// Pure logic for stuck-agent detection.
//
// The fleet's liveness checks only tell us an agent's tmux session is ALIVE, not
// that it is making PROGRESS. A wedged agent (hit a session limit, blocked on a
// modal, frozen mid-turn) looks alive but produces no new output -- this has
// caused silent incidents. This module decides, from a pane snapshot plus a bit
// of context, whether an agent that is supposed to be working (has an in_progress
// card) has gone quiet long enough to warrant a NON-silent alert.
//
// Scope choice: an agent sitting IDLE at its prompt is NOT stuck -- it is simply
// available/waiting for the next message (the common resting state in this
// fleet), and flagging it would be noise. Stuck means a NON-idle pane whose
// content has not changed for a while. That matches the real failure modes
// (error banner, approval menu, frozen turn) without false-positiving every
// resting agent.
//
// Dependency-free so the decision is unit-testable without a clock, tmux, or the
// filesystem. The I/O (capturing panes, querying cards, alerting) lives in
// src/web/stuck-agent-watcher.ts.

export interface StuckAgentThresholds {
  /** Pane content unchanged at least this long (ms) while non-idle => stuck. */
  stuckMs: number
}

export const DEFAULT_STUCK_MS = 8 * 60_000

export interface StuckAgentState {
  /** Signature of the last observed pane content. */
  signature: string
  /** When the signature last changed (ms) -- the start of the current quiet spell. */
  lastChangeAtMs: number
  /** Whether we already alerted for the current frozen spell (alert once, not every tick). */
  alerted: boolean
}

export type StuckAgentAction = 'none' | 'alert'

export interface StuckAgentInputs {
  /** Captured pane text, or null if it could not be read. */
  pane: string | null
  /** Whether the pane looks idle at the prompt (paneLooksIdle). */
  idle: boolean
  /** Whether the agent has a card in in_progress assigned to it. */
  hasInProgressCard: boolean
  /** Whether the agent (re)started too recently to judge (boot / respawn grace). */
  withinRespawnGrace: boolean
}

// A cheap, stable content key for change-detection (NOT a security hash). We
// normalize away volatile-but-not-progress noise (trailing whitespace, a blinking
// cursor line, trailing blank lines) so genuine new output reads as activity but
// a static frame does not. FNV-1a keeps the stored state tiny.
export function paneSignature(pane: string): string {
  const normalized = pane
    .split('\n')
    .map(l => l.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n+$/, '')
  let h = 0x811c9dc5
  for (let i = 0; i < normalized.length; i++) {
    h ^= normalized.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

/**
 * Pure decision: is this agent stuck right now, and what is the carried state?
 *
 * Returns state:null whenever the agent is not a stuck candidate (unreadable
 * pane, idle at prompt, in respawn grace, or no in_progress work) so the caller
 * clears any tracked spell -- a later freeze starts a fresh clock.
 */
export function decideStuckAgent(
  prev: StuckAgentState | null,
  inputs: StuckAgentInputs,
  nowMs: number,
  thresholds: StuckAgentThresholds,
): { state: StuckAgentState | null; action: StuckAgentAction } {
  if (inputs.pane == null || inputs.idle || inputs.withinRespawnGrace || !inputs.hasInProgressCard) {
    return { state: null, action: 'none' }
  }
  const sig = paneSignature(inputs.pane)
  if (!prev || prev.signature !== sig) {
    // First sight or the content changed => activity. (Re)start the quiet clock.
    return { state: { signature: sig, lastChangeAtMs: nowMs, alerted: false }, action: 'none' }
  }
  // Content unchanged since the last observation.
  const quietFor = nowMs - prev.lastChangeAtMs
  if (quietFor >= thresholds.stuckMs && !prev.alerted) {
    return { state: { ...prev, alerted: true }, action: 'alert' }
  }
  return { state: prev, action: 'none' }
}
