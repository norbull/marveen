import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { logger } from '../logger.js'
import { PROJECT_ROOT } from '../config.js'
import { getDb } from '../db.js'
import { sendMarveenAlert } from './telegram.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'

// Auto-recovery orchestrator (kanban #fdfa238a).
//
// Scope split (agreed with iris, who owns #e601c705):
//   - THIS module = orchestrator/policy: WHEN to act, which component, anti-flap,
//     escalation to Norbi. Cross-component (channel / inter-agent delivery / ...).
//   - iris = channel/telegram RECOVERY EXECUTOR (HOW): scripts/recover-channel.sh
//     with structured exit codes (0=recovered, 2=deferred, 3=systemic/capped,
//     1=failed) and OWNS the channel anti-flap stamps. We only call her script;
//     we never duplicate channel-restart logic or write her stamp files.
//
// Boundary note: the orchestrator runs INSIDE the dashboard process (dist/index.js).
// It therefore cannot restart the dashboard process itself -- that is the job of
// systemd (Restart=) plus the independent channel-watchdog systemd --user timer
// (iris, belt-and-suspenders). This module handles components that live *inside*
// or *alongside* the running process and are observable from it.
//
// DRY-RUN FIRST (Norbi's gate): by default we detect + log + (would-)escalate but
// execute NO recovery action. Flip AUTO_RECOVERY_LIVE=1 only after the dry-run
// logs validate the detection is reliable and iris' recover-channel.sh is ready.

const execFileAsync = promisify(execFile)

/** Live mode is opt-in; absence of the flag keeps us in safe shadow mode. */
const DRY_RUN = process.env['AUTO_RECOVERY_LIVE'] !== '1'

const TICK_MS = 30_000
// Anti-flap policy, mirroring channel-health-monitor.ts: at most one recovery
// attempt per incident window, then a cooldown before we touch the component
// again. Prevents restart-loops from a flapping or false-positive probe.
const MAX_ATTEMPTS_PER_WINDOW = 1
const COOLDOWN_MS = 10 * 60 * 1000

// A pending inter-agent message older than this is considered stuck (the
// known stuck-pending delivery bug: a delivered message never leaves 'pending').
const STUCK_DELIVERY_MS = 5 * 60 * 1000

const CHANNEL_HEALTH_SCRIPT = join(PROJECT_ROOT, 'scripts', 'verify-channels-health.sh')
const CHANNEL_RECOVER_SCRIPT = join(PROJECT_ROOT, 'scripts', 'recover-channel.sh')

interface Health {
  healthy: boolean
  detail?: string
}

interface RecoveryComponent {
  name: string
  /** Read-only liveness probe. Must not mutate state. */
  probe: () => Promise<Health>
  /**
   * Attempt recovery. In dry-run it performs nothing and returns the action it
   * WOULD take; in live mode it executes and reports success.
   */
  recover: (dryRun: boolean) => Promise<{ ok: boolean; action: string }>
}

interface ComponentState {
  attempts: number
  lastAttemptAt: number
  escalated: boolean
}

// In-memory flap state per component. Phase 1 keeps this process-local; a
// persistent orchestrator-store (store/auto-recovery-state.json, atomicWrite)
// is deferred to phase 3 and is SEPARATE from iris' channel stamp files.
const state = new Map<string, ComponentState>()

function getState(name: string): ComponentState {
  let s = state.get(name)
  if (!s) {
    s = { attempts: 0, lastAttemptAt: 0, escalated: false }
    state.set(name, s)
  }
  return s
}

function resetState(name: string): void {
  state.delete(name)
}

// ---- Components ----------------------------------------------------------

// Channel bridge: observation is iris' verify-channels-health.sh exit code
// (0=healthy, non-zero=fail); action delegates to her recover-channel.sh.
const channelComponent: RecoveryComponent = {
  name: 'channel',
  async probe() {
    try {
      await execFileAsync(CHANNEL_HEALTH_SCRIPT, [], { timeout: 20_000 })
      return { healthy: true }
    } catch (err) {
      const code = (err as { code?: number }).code
      return { healthy: false, detail: `verify-channels-health.sh exit ${code ?? '?'}` }
    }
  },
  async recover(dryRun) {
    const action = `recover-channel.sh ${MAIN_CHANNELS_SESSION}`
    if (dryRun) return { ok: true, action: `[DRY-RUN] would run ${action}` }
    // Live: iris' executor is idempotent and owns its own flock'd anti-flap
    // stamps, so it is safe to call alongside the independent systemd timer.
    try {
      await execFileAsync(CHANNEL_RECOVER_SCRIPT, [MAIN_CHANNELS_SESSION], { timeout: 180_000 })
      return { ok: true, action } // exit 0 = recovered
    } catch (err) {
      const code = (err as { code?: number }).code
      // exit 2 (deferred) and 3 (systemic/capped) are not "recovered"; the
      // orchestrator treats any non-zero as not-yet-healthy and re-probes /
      // escalates per policy. The structured code is surfaced for the log.
      return { ok: false, action: `${action} -> exit ${code ?? '?'}` }
    }
  },
}

// Inter-agent delivery: pending messages that never flip to 'delivered' are the
// known stuck-pending bug. Probe counts stale pending rows; live requeue logic
// is deferred to phase 2 (needs the delivery path, not just detection).
const interAgentComponent: RecoveryComponent = {
  name: 'inter-agent-delivery',
  async probe() {
    const cutoff = Math.floor((Date.now() - STUCK_DELIVERY_MS) / 1000)
    const row = getDb()
      .prepare("SELECT COUNT(*) AS c FROM agent_messages WHERE status = 'pending' AND created_at < ?")
      .get(cutoff) as { c: number }
    if (row.c === 0) return { healthy: true }
    return { healthy: false, detail: `${row.c} pending message(s) stuck > ${STUCK_DELIVERY_MS / 60000}min` }
  },
  async recover(dryRun) {
    const action = 'requeue stuck pending agent_messages'
    if (dryRun) return { ok: true, action: `[DRY-RUN] would ${action}` }
    // Phase 2: implement actual requeue. Until then, report not-recovered so
    // the orchestrator escalates rather than silently claiming success.
    return { ok: false, action: `${action} (live requeue not yet implemented)` }
  },
}

const COMPONENTS: RecoveryComponent[] = [channelComponent, interAgentComponent]

// ---- Orchestration -------------------------------------------------------

async function escalate(component: string, health: Health): Promise<void> {
  const msg =
    `Auto-recovery: a(z) '${component}' komponens nem jott helyre ` +
    `(${health.detail ?? 'ismeretlen ok'}). A recovery-probalkozas elerte a limitet, kezi beavatkozas kellhet.`
  logger.error({ component, detail: health.detail }, '[auto-recovery] escalating to Norbi')
  if (DRY_RUN) {
    logger.warn({ component }, `[auto-recovery][DRY-RUN] would send Telegram alert: ${msg}`)
    return
  }
  try {
    await sendMarveenAlert(msg)
  } catch (err) {
    logger.error({ err, component }, '[auto-recovery] escalation alert failed')
  }
}

async function tickComponent(component: RecoveryComponent): Promise<void> {
  const health = await component.probe()
  if (health.healthy) {
    resetState(component.name)
    return
  }

  const st = getState(component.name)
  const now = Date.now()

  // Cooldown: after a recent attempt, leave the component alone for a while.
  if (st.lastAttemptAt && now - st.lastAttemptAt < COOLDOWN_MS) return

  // Capped: one attempt per window already spent -> escalate once, then wait.
  if (st.attempts >= MAX_ATTEMPTS_PER_WINDOW) {
    if (!st.escalated) {
      await escalate(component.name, health)
      st.escalated = true
    }
    // Cooldown elapsed (we passed the guard above) -> open a fresh window.
    st.attempts = 0
    st.escalated = false
    return
  }

  st.attempts += 1
  st.lastAttemptAt = now
  const result = await component.recover(DRY_RUN)
  logger.warn(
    { component: component.name, dryRun: DRY_RUN, action: result.action, detail: health.detail },
    '[auto-recovery] recovery attempt',
  )
  if (DRY_RUN) return

  // Live: verify the action actually restored health; escalate if not.
  const after = await component.probe()
  if (after.healthy) {
    resetState(component.name)
  } else if (!st.escalated) {
    await escalate(component.name, after)
    st.escalated = true
  }
}

async function tick(): Promise<void> {
  for (const component of COMPONENTS) {
    try {
      await tickComponent(component)
    } catch (err) {
      logger.error({ err, component: component.name }, '[auto-recovery] tick error')
    }
  }
}

let timer: ReturnType<typeof setInterval> | null = null

export function startAutoRecovery(): void {
  if (timer) return
  logger.info(
    { dryRun: DRY_RUN, tickMs: TICK_MS, components: COMPONENTS.map((c) => c.name) },
    '[auto-recovery] orchestrator starting',
  )
  timer = setInterval(() => {
    void tick()
  }, TICK_MS)
  // Do not keep the event loop alive for this background timer.
  if (typeof timer.unref === 'function') timer.unref()
}

export function stopAutoRecovery(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

// Exported for tests: run a single tick deterministically.
export const __test = { tick, tickComponent, COMPONENTS, state, DRY_RUN }
