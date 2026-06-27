import { describe, it, expect, beforeEach } from 'vitest'
import { __test } from '../web/auto-recovery.js'

const { tickComponent, state, DRY_RUN } = __test

type Health = { healthy: boolean; detail?: string }

// Build a stub component whose probe returns a scripted health sequence and
// whose recover records the dryRun flag it was invoked with. Lets us drive the
// orchestrator state machine without touching execFile / the database.
function makeComponent(name: string, healthSeq: Health[]) {
  let i = 0
  const calls = { probe: 0, recover: [] as boolean[] }
  const comp = {
    name,
    async probe(): Promise<Health> {
      calls.probe += 1
      return healthSeq[Math.min(i++, healthSeq.length - 1)]
    },
    async recover(dryRun: boolean) {
      calls.recover.push(dryRun)
      return { ok: true, action: `stub:${name}` }
    },
  }
  return { comp, calls }
}

describe('auto-recovery orchestrator (phase 1, dry-run)', () => {
  beforeEach(() => state.clear())

  it('defaults to dry-run (shadow) mode', () => {
    expect(DRY_RUN).toBe(true)
  })

  it('healthy probe -> no recovery attempt and no lingering state', async () => {
    const { comp, calls } = makeComponent('t-healthy', [{ healthy: true }])
    await tickComponent(comp)
    expect(calls.recover).toEqual([])
    expect(state.has('t-healthy')).toBe(false)
  })

  it('unhealthy -> exactly one recovery attempt, invoked with dryRun=true', async () => {
    const { comp, calls } = makeComponent('t-unhealthy', [{ healthy: false, detail: 'down' }])
    await tickComponent(comp)
    // recover called once, and crucially with the dry-run flag set (no live action)
    expect(calls.recover).toEqual([true])
    expect(state.get('t-unhealthy')?.attempts).toBe(1)
  })

  it('does not run a verify-probe in dry-run (no live side effects)', async () => {
    const { comp, calls } = makeComponent('t-noverify', [{ healthy: false }])
    await tickComponent(comp)
    // exactly one probe (initial); the post-recovery verify probe is live-only
    expect(calls.probe).toBe(1)
  })

  it('cooldown blocks a second attempt within the incident window', async () => {
    const { comp, calls } = makeComponent('t-cooldown', [{ healthy: false }, { healthy: false }])
    await tickComponent(comp) // attempt #1
    await tickComponent(comp) // still in cooldown -> suppressed
    expect(calls.recover).toEqual([true]) // only the first attempt fired
  })

  it('recovery back to healthy clears state', async () => {
    const { comp } = makeComponent('t-recover', [{ healthy: false }, { healthy: true }])
    await tickComponent(comp) // attempt #1 (state created)
    expect(state.has('t-recover')).toBe(true)
    state.get('t-recover')!.lastAttemptAt = 0 // expire cooldown for the test
    await tickComponent(comp) // now healthy -> reset
    expect(state.has('t-recover')).toBe(false)
  })
})
