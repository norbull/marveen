// Pure logic for the orin Opus-escalation fallback (kanban #2b7badb8).
//
// Motivation: orin (the coordinator / main agent) runs on Sonnet by default to
// keep routine coordination cheap. Occasionally a genuinely hard, multi-step
// orchestration or a critical permission-router decision would benefit from
// Opus. This feature lets orin EXPLICITLY request a temporary escalation to
// Opus and reverts back to Sonnet afterwards. Norbi's constraint: use it ONLY
// when truly necessary, never routinely -- so the trigger is explicit (orin
// calls an API), never automatic, and there is a hard safety cap that always
// climbs back down even if orin forgets to de-escalate.
//
// The switch itself is a LIVE `/model` change injected into orin's tmux pane
// (context preserved, no restart) -- see the empirical discovery in the card
// comments. This is the INVERSE of the model-fallback-on-limit feature
// (src/model-fallback.ts): that downgrades on a usage-limit banner and climbs
// back up; this climbs UP on an explicit request and reverts back down.
//
// This module is dependency-free so every decision is unit-testable without a
// clock, tmux, or the filesystem. The I/O (capture-pane, /model inject, verify)
// lives in src/web/opus-escalation-runner.ts; the request state lives in
// src/web/opus-escalation-store.ts.

// Resolved full model IDs, mirroring MODEL_ALIASES in src/web/agent-config.ts
// and DEFAULT_MODEL_CHAIN in src/model-fallback.ts. Kept as literals to preserve
// the zero-import, trivially-testable property of this module.
export const OPUS_MODEL_ID = 'claude-opus-4-8[1m]'
export const SONNET_MODEL_ID = 'claude-sonnet-4-6'

// Safety cap: an escalation ALWAYS reverts after this long even without an
// explicit de-escalate, so orin can never be stranded on Opus (cost guard that
// enforces Norbi's "only when truly necessary" rule). Deliberately short --
// escalation is meant for the current hard turn(s), not a whole session.
export const DEFAULT_MAX_ESCALATION_MINUTES = 30

export interface OpusEscalationConfig {
  /** Master toggle. When false orin is never escalated (feature off). */
  enabled: boolean
  /** Model to escalate UP to. */
  escalateModel: string
  /** Model to revert back DOWN to (orin's coordinator default). */
  baseModel: string
  /** Hard cap: revert after this many minutes regardless of de-escalate. */
  maxEscalationMinutes: number
}

export const DEFAULT_OPUS_ESCALATION: OpusEscalationConfig = {
  enabled: false,
  escalateModel: OPUS_MODEL_ID,
  baseModel: SONNET_MODEL_ID,
  maxEscalationMinutes: DEFAULT_MAX_ESCALATION_MINUTES,
}

/** Coerce an untrusted parsed-JSON value into a valid config (defaults on junk). */
export function normalizeOpusEscalationConfig(raw: unknown): OpusEscalationConfig {
  const o = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {}
  const enabled = o.enabled === true
  const escalateModel = (typeof o.escalateModel === 'string' && o.escalateModel.trim())
    ? o.escalateModel.trim() : DEFAULT_OPUS_ESCALATION.escalateModel
  const baseModel = (typeof o.baseModel === 'string' && o.baseModel.trim())
    ? o.baseModel.trim() : DEFAULT_OPUS_ESCALATION.baseModel
  let maxEscalationMinutes = DEFAULT_OPUS_ESCALATION.maxEscalationMinutes
  if (typeof o.maxEscalationMinutes === 'number' && Number.isFinite(o.maxEscalationMinutes) && o.maxEscalationMinutes > 0) {
    maxEscalationMinutes = Math.floor(o.maxEscalationMinutes)
  }
  return { enabled, escalateModel, baseModel, maxEscalationMinutes }
}

export interface OpusEscalationState {
  /** Whether an escalation is currently requested (set by the API, cleared on de-escalate/expiry). */
  active: boolean
  /** When the active escalation was requested (ms epoch), or null when inactive. */
  requestedAt: number | null
  /** Free-text reason orin gave (for audit); never affects the decision. */
  reason?: string
  /**
   * The model the runner last actually switched orin to. Persisted (not derived
   * from the live pane or settings.json, which a `/model` live-switch does not
   * reliably update) so a dashboard restart mid-escalation still knows orin is
   * on Opus and can revert it. Absent => orin is assumed to be on the base model.
   */
  appliedModel?: string
}

export const EMPTY_ESCALATION_STATE: OpusEscalationState = { active: false, requestedAt: null }

/** Coerce untrusted parsed JSON into a valid escalation state. */
export function normalizeEscalationState(raw: unknown): OpusEscalationState {
  const o = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {}
  const active = o.active === true
  const requestedAt = (typeof o.requestedAt === 'number' && Number.isFinite(o.requestedAt))
    ? o.requestedAt : null
  const reason = typeof o.reason === 'string' ? o.reason : undefined
  const appliedModel = (typeof o.appliedModel === 'string' && o.appliedModel.trim())
    ? o.appliedModel : undefined
  // An "active" state with no timestamp is malformed -- treat as inactive so a
  // corrupt file can never strand orin on Opus. appliedModel is preserved even
  // then, so a pending revert of an already-applied escalation is not lost.
  const base = (active && requestedAt === null)
    ? { active: false, requestedAt: null }
    : { active, requestedAt }
  return {
    ...base,
    ...(reason !== undefined ? { reason } : {}),
    ...(appliedModel !== undefined ? { appliedModel } : {}),
  }
}

/**
 * True when an active escalation has outlived the safety cap and must be
 * force-reverted. False when inactive or still within the window.
 */
export function isEscalationExpired(requestedAt: number | null, now: number, maxMs: number): boolean {
  if (requestedAt === null) return false
  return now - requestedAt >= maxMs
}

export type EscalationAction =
  | { kind: 'none' }
  /** Switch orin UP to the escalate model. */
  | { kind: 'escalate'; model: string }
  /** Switch orin back DOWN to the base model. `expired` = the safety cap fired. */
  | { kind: 'revert'; model: string; expired: boolean }

export interface EscalationFacts {
  /** Whether an escalation is currently requested. */
  active: boolean
  /** When it was requested (ms epoch), or null when inactive. */
  requestedAt: number | null
  /** orin's current resolved model id. */
  currentModel: string
  /** Model to escalate up to. */
  escalateModel: string
  /** Model to revert down to. */
  baseModel: string
  /** Current time (ms epoch). */
  now: number
  /** Safety-cap window (ms). */
  maxEscalationMs: number
}

/**
 * Decide what to do for orin. Pure: the runner gates the I/O (idle pane, actual
 * /model injection + verify) separately.
 *
 *   - active & past the safety cap        -> revert to base (expired=true); the
 *                                            runner also clears the request.
 *   - active & not yet on the escalate model -> escalate up to it.
 *   - active & already escalated & in window -> nothing.
 *   - inactive & still on the escalate model -> revert down to base (de-escalated).
 *   - inactive & already on base (or other) -> nothing (never touch a model we
 *                                              did not escalate to).
 */
export function decideEscalationAction(f: EscalationFacts): EscalationAction {
  if (f.active) {
    if (isEscalationExpired(f.requestedAt, f.now, f.maxEscalationMs)) {
      // Only actually revert if we are on the escalate model; otherwise just
      // signal expiry so the runner clears the stale request.
      return { kind: 'revert', model: f.baseModel, expired: true }
    }
    if (f.currentModel !== f.escalateModel) {
      return { kind: 'escalate', model: f.escalateModel }
    }
    return { kind: 'none' }
  }
  // Inactive: only revert a model WE escalated to, never a model set by another
  // mechanism (e.g. the model-fallback-on-limit downgrade).
  if (f.currentModel === f.escalateModel) {
    return { kind: 'revert', model: f.baseModel, expired: false }
  }
  return { kind: 'none' }
}
