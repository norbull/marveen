// Tests for the main-agent wake-nudge (kanban #96cd2ac9).
//
// Two layers:
//  1. shouldWakeMainAgent -- the PURE gate decision (idle + age + debounce +
//     session-exists), tested exhaustively with no tmux/mocks (like
//     shouldAbandon).
//  2. runMessageRouterTick wiring -- a main-agent pending message that is old
//     enough and whose channel session is idle results in ONE content-free
//     nudge sent to the channel session; a sub-agent message never touches the
//     wake path; the main message is NOT marked delivered (the pull path owns
//     the atomic claim + security framing).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockGetPendingMessages = vi.fn()
const mockMarkDelivered = vi.fn((..._a: unknown[]) => true)
const mockMarkFailed = vi.fn((..._a: unknown[]) => true)
const mockSessionExistsOnHost = vi.fn((..._a: unknown[]) => true)
const mockIsReady = vi.fn((..._a: unknown[]) => true)
const mockSendPrompt = vi.fn()

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../config.js', () => ({
  MAIN_AGENT_ID: 'orin',
}))

vi.mock('../web/main-agent.js', () => ({
  MAIN_CHANNELS_SESSION: 'orin-channels',
}))

vi.mock('../db.js', () => ({
  getPendingMessages: () => mockGetPendingMessages(),
  markMessageDelivered: (...a: unknown[]) => mockMarkDelivered(...a),
  markMessageFailed: (...a: unknown[]) => mockMarkFailed(...a),
}))

vi.mock('../web/voice-directive.js', () => ({
  resolveAgentChannelStateDir: () => '/tmp/none',
}))

vi.mock('../web/agent-config.js', () => ({
  readAgentRemoteHost: () => null,
  readAgentVoiceConfig: () => ({ responseMode: 'text' }),
}))

vi.mock('../web/agent-process.js', () => ({
  agentSessionName: (name: string) => `agent-${name}`,
  isSessionReadyForPrompt: (...a: unknown[]) => mockIsReady(...a),
  clearStaleParkedInput: vi.fn(() => false),
  sendPromptToSession: (...a: unknown[]) => mockSendPrompt(...a),
  sessionExistsOnHost: (...a: unknown[]) => mockSessionExistsOnHost(...a),
}))

vi.mock('../web/voice-modality.js', () => ({
  setLastInboundModality: vi.fn(),
}))

vi.mock('../web/agent-message-wrap.js', () => ({
  classifyAgentMessage: () => ({ category: 'trusted-peer', safeFrom: 'dex' }),
  wrapAgentMessageForDelivery: () => ({ prefix: '', wrapped: '' }),
}))

import { runMessageRouterTick, shouldWakeMainAgent } from '../web/message-router.js'

const BASE = {
  oldestPendingAgeMs: 60_000,
  now: 1_000_000_000,
  lastWakeAt: 0,
  sessionExists: true,
  sessionIdle: true,
  minAgeMs: 30_000,
  debounceMs: 60_000,
}

describe('shouldWakeMainAgent (pure gate decision)', () => {
  it('wakes when session exists+idle, message old enough, debounce elapsed', () => {
    expect(shouldWakeMainAgent(BASE)).toBe(true)
  })

  it('does NOT wake when the channel session is absent', () => {
    expect(shouldWakeMainAgent({ ...BASE, sessionExists: false })).toBe(false)
  })

  it('does NOT wake when the session is busy (mid-turn) -- avoids the inject race', () => {
    expect(shouldWakeMainAgent({ ...BASE, sessionIdle: false })).toBe(false)
  })

  it('does NOT wake for a message younger than the age gate', () => {
    expect(shouldWakeMainAgent({ ...BASE, oldestPendingAgeMs: 10_000 })).toBe(false)
    // exactly at the threshold is still not old enough (strict >)
    expect(shouldWakeMainAgent({ ...BASE, oldestPendingAgeMs: 30_000 })).toBe(false)
  })

  it('does NOT wake within the debounce window of the last nudge', () => {
    expect(shouldWakeMainAgent({ ...BASE, now: BASE.now, lastWakeAt: BASE.now - 30_000 })).toBe(false)
    // exactly at the debounce boundary is allowed
    expect(shouldWakeMainAgent({ ...BASE, now: BASE.now, lastWakeAt: BASE.now - 60_000 })).toBe(true)
  })
})

function mainMsg(ageSec: number) {
  return {
    id: 1,
    from_agent: 'dex',
    to_agent: 'orin', // MAIN_AGENT_ID
    content: 'a reply that must NOT be injected as content',
    created_at: Math.floor(Date.now() / 1000) - ageSec,
  }
}

describe('runMessageRouterTick main-agent wake-nudge wiring', () => {
  // The router keeps a module-scoped `_lastMainWakeAt` debounce clock. Drive a
  // fake system clock forward by well over the debounce window before EACH test
  // so a nudge in one test never suppresses the next (the debounce itself is
  // covered by the pure shouldWakeMainAgent tests above).
  let clock = 1_700_000_000_000
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    clock += 3_600_000 // +1h -> always past MAIN_WAKE_DEBOUNCE_MS
    vi.setSystemTime(clock)
    mockSessionExistsOnHost.mockReturnValue(true)
    mockIsReady.mockReturnValue(true)
    mockMarkDelivered.mockReturnValue(true)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends ONE content-free nudge to the channel session for an old, idle main-agent message', async () => {
    mockGetPendingMessages.mockReturnValue([mainMsg(60)])

    await runMessageRouterTick()

    expect(mockSendPrompt).toHaveBeenCalledTimes(1)
    const [session, text] = mockSendPrompt.mock.calls[0]
    expect(session).toBe('orin-channels')
    // Content-free: the nudge must NOT carry the message body.
    expect(text).not.toContain('a reply that must NOT be injected')
    expect(String(text)).toContain('[orin-wake]')
    // The pull path owns the claim -- the router must not mark it delivered.
    expect(mockMarkDelivered).not.toHaveBeenCalled()
  })

  it('does not nudge for a fresh main-agent message (age gate)', async () => {
    mockGetPendingMessages.mockReturnValue([mainMsg(5)])

    await runMessageRouterTick()

    expect(mockSendPrompt).not.toHaveBeenCalled()
  })

  it('probes the channel session at most once per tick for a main-agent backlog', async () => {
    mockGetPendingMessages.mockReturnValue([mainMsg(60), { ...mainMsg(60), id: 2 }])

    await runMessageRouterTick()

    // The per-tick flag gates the readiness probe (capture-pane) to one call.
    expect(mockSessionExistsOnHost).toHaveBeenCalledTimes(1)
  })

  it('never routes a sub-agent message through the wake path', async () => {
    mockSessionExistsOnHost.mockReturnValue(false) // sub-agent session absent
    mockGetPendingMessages.mockReturnValue([
      { id: 9, from_agent: 'orin', to_agent: 'dex', content: 'ping', created_at: Math.floor(Date.now() / 1000) - 60 },
    ])

    await runMessageRouterTick()

    // sessionExistsOnHost is probed for the SUB-agent session (agent-dex), never
    // for the channel session via the wake path.
    for (const call of mockSessionExistsOnHost.mock.calls) {
      expect(call[1]).not.toBe('orin-channels')
    }
    expect(mockSendPrompt).not.toHaveBeenCalled()
  })
})
