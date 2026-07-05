import { describe, it, expect } from 'vitest'
import {
  decideStuckAgent,
  paneSignature,
  DEFAULT_STUCK_MS,
  type StuckAgentState,
  type StuckAgentInputs,
} from '../stuck-agent.js'

const TH = { stuckMs: DEFAULT_STUCK_MS }
const now = 1_000_000_000

// A candidate agent: non-idle, has work, past respawn grace, readable pane.
function inputs(pane: string | null, over: Partial<StuckAgentInputs> = {}): StuckAgentInputs {
  return { pane, idle: false, hasInProgressCard: true, withinRespawnGrace: false, ...over }
}

describe('paneSignature', () => {
  it('is stable for identical content', () => {
    expect(paneSignature('line one\nline two')).toBe(paneSignature('line one\nline two'))
  })

  it('differs for different content', () => {
    expect(paneSignature('working: step 1')).not.toBe(paneSignature('working: step 2'))
  })

  it('ignores trailing whitespace and trailing blank lines (not progress)', () => {
    expect(paneSignature('a\nb')).toBe(paneSignature('a   \nb\n\n'))
  })
})

describe('decideStuckAgent -- non-candidate cases clear state', () => {
  const prev: StuckAgentState = { signature: 'x', lastChangeAtMs: now - DEFAULT_STUCK_MS * 2, alerted: false }

  it('an unreadable pane is not judged', () => {
    expect(decideStuckAgent(prev, inputs(null), now, TH)).toEqual({ state: null, action: 'none' })
  })

  it('an idle-at-prompt agent is not stuck', () => {
    expect(decideStuckAgent(prev, inputs('frozen', { idle: true }), now, TH)).toEqual({ state: null, action: 'none' })
  })

  it('an agent within respawn grace is not judged', () => {
    expect(decideStuckAgent(prev, inputs('frozen', { withinRespawnGrace: true }), now, TH)).toEqual({ state: null, action: 'none' })
  })

  it('an agent with no in_progress card is not judged', () => {
    expect(decideStuckAgent(prev, inputs('frozen', { hasInProgressCard: false }), now, TH)).toEqual({ state: null, action: 'none' })
  })
})

describe('decideStuckAgent -- freeze clock', () => {
  it('first sight starts the clock, no alert', () => {
    const r = decideStuckAgent(null, inputs('frame A'), now, TH)
    expect(r.action).toBe('none')
    expect(r.state).toEqual({ signature: paneSignature('frame A'), lastChangeAtMs: now, alerted: false })
  })

  it('changed content restarts the clock, no alert', () => {
    const prev: StuckAgentState = { signature: paneSignature('frame A'), lastChangeAtMs: now, alerted: false }
    const r = decideStuckAgent(prev, inputs('frame B'), now + DEFAULT_STUCK_MS * 2, TH)
    expect(r.action).toBe('none')
    expect(r.state?.lastChangeAtMs).toBe(now + DEFAULT_STUCK_MS * 2)
    expect(r.state?.alerted).toBe(false)
  })

  it('unchanged but below threshold keeps waiting', () => {
    const prev: StuckAgentState = { signature: paneSignature('frozen'), lastChangeAtMs: now, alerted: false }
    const r = decideStuckAgent(prev, inputs('frozen'), now + DEFAULT_STUCK_MS - 1, TH)
    expect(r.action).toBe('none')
    expect(r.state).toBe(prev)
  })

  it('unchanged past the threshold alerts once', () => {
    const prev: StuckAgentState = { signature: paneSignature('frozen'), lastChangeAtMs: now, alerted: false }
    const r = decideStuckAgent(prev, inputs('frozen'), now + DEFAULT_STUCK_MS, TH)
    expect(r.action).toBe('alert')
    expect(r.state?.alerted).toBe(true)
  })

  it('does not re-alert while still frozen after an alert', () => {
    const prev: StuckAgentState = { signature: paneSignature('frozen'), lastChangeAtMs: now, alerted: true }
    const r = decideStuckAgent(prev, inputs('frozen'), now + DEFAULT_STUCK_MS * 3, TH)
    expect(r.action).toBe('none')
    expect(r.state?.alerted).toBe(true)
  })

  it('re-arms after activity resumes then freezes again', () => {
    // activity: content changed -> alerted reset
    const afterAlert: StuckAgentState = { signature: paneSignature('frozen'), lastChangeAtMs: now, alerted: true }
    const moved = decideStuckAgent(afterAlert, inputs('now moving'), now + 1000, TH)
    expect(moved.state?.alerted).toBe(false)
    // freezes again on the new content and crosses threshold -> alerts again
    const refroze = decideStuckAgent(moved.state, inputs('now moving'), now + 1000 + DEFAULT_STUCK_MS, TH)
    expect(refroze.action).toBe('alert')
  })
})
