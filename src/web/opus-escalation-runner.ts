import { logger } from '../logger.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'
import { capturePane, switchModelLive } from './agent-process.js'
import { paneLooksIdle } from '../pane-state.js'
import { decideEscalationAction } from '../opus-escalation.js'
import {
  readOpusEscalationConfig,
  readEscalationState,
  writeEscalationState,
} from './opus-escalation-store.js'

// Drives the orin Opus-escalation fallback (see src/opus-escalation.ts for the
// why and the pure decision logic). Mirrors the model-fallback runner: a ~60s
// sweep, offset from the other watchers so tmux calls do not pile onto one tick.
//
// Unlike model-fallback (which restarts the session for the swap), this switches
// the model LIVE via `/model` injection so orin's conversation is preserved --
// that is the whole point of escalating for the current hard turn. Scope is the
// MAIN agent only; sub-agent model changes go through the config+restart path.
//
// Each tick: read the operator config + the escalation request state, ask the
// pure decision function what to do, and -- only when orin's pane is idle (never
// cut a live turn) -- inject the `/model` switch and reconcile the persisted
// state. A hard safety cap (config.maxEscalationMinutes) always reverts even if
// orin never de-escalates, so it can never be stranded on Opus.

const INITIAL_DELAY_MS = 55_000
const INTERVAL_MS = 60_000

function sweep(): void {
  const cfg = readOpusEscalationConfig()
  const state = readEscalationState()
  const now = Date.now()

  // Feature disabled => treat as inactive so an in-flight escalation still
  // auto-reverts orin back to the base model (the toggle is also a kill-switch).
  const active = cfg.enabled && state.active
  const currentModel = state.appliedModel ?? cfg.baseModel

  const action = decideEscalationAction({
    active,
    requestedAt: state.requestedAt,
    currentModel,
    escalateModel: cfg.escalateModel,
    baseModel: cfg.baseModel,
    now,
    maxEscalationMs: cfg.maxEscalationMinutes * 60_000,
  })
  if (action.kind === 'none') return

  // Already on the target model (e.g. safety-cap expiry on a request that was
  // never actually applied): just reconcile the persisted state -- no pane
  // injection, so this needs neither an idle pane nor a running switch.
  if (action.model === currentModel) {
    if (action.kind === 'revert') {
      writeEscalationState({ active: false, requestedAt: null, appliedModel: action.model })
    }
    return
  }

  // Never inject into a live turn -- defer until orin's pane is idle.
  const pane = capturePane(MAIN_CHANNELS_SESSION, null)
  if (pane == null || !paneLooksIdle(pane)) {
    logger.info({ action: action.kind }, 'opus-escalation: action due but orin pane busy/absent, deferring')
    return
  }

  const ok = switchModelLive(MAIN_CHANNELS_SESSION, null, action.model)
  if (!ok) {
    logger.warn({ action: action.kind, model: action.model }, 'opus-escalation: /model switch not confirmed, will retry')
    return
  }

  if (action.kind === 'escalate') {
    // Keep the request active (and its requestedAt/reason) so the safety cap and
    // an explicit de-escalate both still apply; record what we switched to.
    writeEscalationState({ ...state, active: true, appliedModel: action.model })
    logger.warn({ to: action.model, reason: state.reason }, 'opus-escalation: orin ESCALATED to Opus')
  } else {
    // Revert (explicit de-escalate or safety-cap expiry): clear the request.
    writeEscalationState({ active: false, requestedAt: null, appliedModel: action.model })
    logger.warn({ to: action.model, expired: action.expired }, 'opus-escalation: orin reverted to base model')
  }
}

export function startOpusEscalationRunner(): NodeJS.Timeout {
  setTimeout(() => {
    try { sweep() } catch (err) { logger.debug({ err }, 'opus-escalation: initial sweep error') }
  }, INITIAL_DELAY_MS)
  return setInterval(() => {
    try { sweep() } catch (err) { logger.debug({ err }, 'opus-escalation: sweep error') }
  }, INTERVAL_MS)
}
