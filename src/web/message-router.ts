import { logger } from '../logger.js'
import { MAIN_AGENT_ID } from '../config.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'
import { resolveAgentChannelStateDir } from './voice-directive.js'
import {
  getPendingMessages,
  markMessageDelivered,
  markMessageFailed,
} from '../db.js'
import { readAgentRemoteHost, readAgentVoiceConfig } from './agent-config.js'
import {
  agentSessionName,
  isSessionReadyForPrompt,
  clearStaleParkedInput,
  sendPromptToSession,
  sessionExistsOnHost,
} from './agent-process.js'
import { setLastInboundModality } from './voice-modality.js'
import { classifyAgentMessage, wrapAgentMessageForDelivery } from './agent-message-wrap.js'

// A message that cannot be delivered within this window (target session never
// exists / stays busy) is marked failed so it stops clogging the pending
// queue and we stop re-scanning it forever. Matches the scheduled-task retry
// window so a long turn that ate one also eats the other.
const MESSAGE_ABANDON_WINDOW_MS = 60 * 60 * 1000
// How long a message must have waited before the stale-parked-input janitor is
// allowed to clear the receiver's input box. Long enough that a brief, genuine
// "agent parked a draft it is about to submit" never gets clobbered; short
// enough that a wedged channel recovers within ~a minute instead of forever.
const JANITOR_PARKED_MIN_AGE_MS = 45 * 1000
// Log "skipping, target not ready" at most once per message id so a busy
// receiver over many 5s ticks does not spam the log.
const routerLoggedMisses: Set<number> = new Set()
// Wakeup cooldown for the main agent: the router fires at most one
// sendPromptToSession wakeup per COOLDOWN_MS window to avoid spamming the
// channels session. 45s gives enough headroom that a normal turn (typically
// 5-30s) ends and drain-inbox fires before we would retry.
let lastMainAgentWakeupMs = 0
const MAIN_AGENT_WAKEUP_COOLDOWN_MS = 45 * 1000

// --- main-agent wake-nudge (kanban #96cd2ac9) -------------------------------
// The main agent (orin) is delivered its inter-agent inbox by the PULL model
// (the UserPromptSubmit inbox-drain hook), NOT the router tmux-inject path --
// injecting CONTENT into its perpetually-busy channel session raced and stalled
// delivery for ~1h (see the isMainAgent branch below, message-router.ts race).
// But the drain hook only fires when the main agent takes a TURN, and it only
// turns on a user prompt or the 30-minute heartbeat -- so a sub-agent's reply
// can sit pending for up to 30 minutes. The wake-nudge closes that latency gap
// WITHOUT reintroducing the race: when a main-agent message has waited long
// enough AND the channel session is idle, the router injects a minimal,
// CONTENT-FREE prompt so the drain hook fires and atomically claims the backlog.
// This is the exact operation the scheduler already performs against the same
// session for heartbeats (sendPromptToSession, idle-gated) -- only the trigger
// differs. No content and no markMessageDelivered here: the pull path owns the
// atomic claim and the security framing (single source, no drift).

// How long a main-agent message must wait before the first wake-nudge. Gives a
// naturally-arriving user prompt / heartbeat a chance to drain it first, so an
// idle channel is not nudged for a reply the main agent was about to pick up.
const MAIN_WAKE_MIN_AGE_MS = 30 * 1000
// Minimum gap between wake-nudges. One nudge starts a turn whose drain claims
// the WHOLE backlog, so re-nudging sooner would pile redundant prompts on a
// session that is already handling the inbox. Bounds it to at most one nudge
// per window even if the turn is slow to start.
const MAIN_WAKE_DEBOUNCE_MS = 60 * 1000
// The content-free wake prompt. The inbox-drain UserPromptSubmit hook PREPENDS
// the claimed (already security-wrapped) messages above this line, so the nudge
// text is only a trailing trigger -- it must never carry inter-agent content
// itself (that is the race this design avoids).
const MAIN_WAKE_NUDGE =
  '[orin-wake] Bejövő inter-agent üzenet(ek) várnak a soron; a drain hook behúzta őket a kontextusba fentebb. Dolgozd fel és válaszolj.'
// When the last wake-nudge was sent (module-scoped, mirrors routerLoggedMisses).
let _lastMainWakeAt = 0

/**
 * Pure decision: should the router send a wake-nudge to the main agent's
 * channel session? Dependency-free so it is unit-testable without tmux, like
 * shouldAbandon. ALL conditions must hold:
 *   - the channel session exists (nothing to wake otherwise);
 *   - it is idle (never inject a prompt mid-turn -- that is the race);
 *   - the oldest pending main-agent message is older than minAgeMs (let the
 *     natural pull drain a fresh one first);
 *   - the debounce window since the last nudge has elapsed (one nudge per
 *     backlog, not one per tick).
 */
export function shouldWakeMainAgent(params: {
  oldestPendingAgeMs: number
  now: number
  lastWakeAt: number
  sessionExists: boolean
  sessionIdle: boolean
  minAgeMs: number
  debounceMs: number
}): boolean {
  const { oldestPendingAgeMs, now, lastWakeAt, sessionExists, sessionIdle, minAgeMs, debounceMs } = params
  if (!sessionExists) return false
  if (!sessionIdle) return false
  if (oldestPendingAgeMs <= minAgeMs) return false
  if (now - lastWakeAt < debounceMs) return false
  return true
}

// I/O wrapper around shouldWakeMainAgent: probes the channel session's presence
// and idle state, and on a positive decision injects the content-free nudge and
// records the debounce timestamp. Called at most ONCE per tick (the caller gates
// on a per-tick flag) so a backlog of main-agent messages triggers a single
// readiness probe, not one per message.
function maybeWakeMainAgent(oldestPendingAgeMs: number, now: number): void {
  // Cheap gates first so a fresh message or an in-debounce window skips the
  // tmux capture-pane entirely (keep the tick's tmux I/O bounded).
  if (oldestPendingAgeMs <= MAIN_WAKE_MIN_AGE_MS) return
  if (now - _lastMainWakeAt < MAIN_WAKE_DEBOUNCE_MS) return
  const sessionExists = sessionExistsOnHost(null, MAIN_CHANNELS_SESSION)
  const sessionIdle = sessionExists && isSessionReadyForPrompt(MAIN_CHANNELS_SESSION, null)
  if (!shouldWakeMainAgent({
    oldestPendingAgeMs, now, lastWakeAt: _lastMainWakeAt,
    sessionExists, sessionIdle,
    minAgeMs: MAIN_WAKE_MIN_AGE_MS, debounceMs: MAIN_WAKE_DEBOUNCE_MS,
  })) return
  try {
    sendPromptToSession(MAIN_CHANNELS_SESSION, MAIN_WAKE_NUDGE, null)
    _lastMainWakeAt = now
    logger.info({ session: MAIN_CHANNELS_SESSION, ageMs: oldestPendingAgeMs }, 'message-router: wake-nudged main agent (pending inbox, idle session)')
  } catch (err) {
    logger.warn({ err, session: MAIN_CHANNELS_SESSION }, 'message-router: main-agent wake-nudge failed')
  }
}

/**
 * Pure decision: should a pending inter-agent message be abandoned?
 *
 * Abandon ONLY when the target session has been ABSENT for the full retry
 * window. A session that EXISTS (even if busy or mid-turn) is never hard-
 * abandoned -- it keeps retrying until an idle gap delivers the message.
 *
 * The previous inline code checked `ageMs > window` BEFORE the session-
 * existence check, which abandoned messages to an alive-but-busy main
 * session at the 1h mark even though the session was continuously running
 * (incident: two reports lost while the session was busy).
 *
 * @param sessionExists Whether the target tmux session is currently alive.
 * @param ageMs         How long the message has been pending (ms).
 * @param windowMs      The abandon window threshold (ms).
 */
export function shouldAbandon(sessionExists: boolean, ageMs: number, windowMs: number): boolean {
  return !sessionExists && ageMs > windowMs
}

// Checks for pending messages every 5 seconds and injects them into target
// agent tmux sessions.
let _tickRunning = false

// Max messages drained per 5s tick; a larger backlog rolls to the next tick.
export const MAX_MESSAGES_PER_TICK = 25

export function startMessageRouter(): NodeJS.Timeout {
  return setInterval(async () => {
    // Re-entrancy guard: STT can hold a tick for up to 65s; skip new ticks
    // while the previous one is still in flight to prevent double-delivery.
    if (_tickRunning) return
    _tickRunning = true
    try {
      await runMessageRouterTick()
    } finally {
      _tickRunning = false
    }
  }, 5000)
}

// One router pass: drain up to MAX_MESSAGES_PER_TICK pending inter-agent
// messages and inject each into its target tmux session. Extracted from the
// setInterval body so it can be exercised directly in unit tests (the
// _tickRunning re-entrancy guard stays in startMessageRouter, around the call).
export async function runMessageRouterTick(): Promise<void> {
    // Cap work per tick: process at most MAX_MESSAGES_PER_TICK messages, the
    // rest roll to the next 5s tick. Bounds a single tick's wall-time so a
    // backlog (e.g. after a delivery stall) can never make one tick run long
    // and starve the event loop -- the slow-tick half of the progressive-hang
    // pattern. Ordering is preserved (oldest first) so nothing is starved.
    const pending = getPendingMessages().slice(0, MAX_MESSAGES_PER_TICK)
    const now = Date.now()
    // Wake-nudge the main agent at most once per tick: `pending` is oldest-first,
    // so the FIRST main-agent message we hit carries the oldest main-agent age --
    // the correct age-gate input. The flag stops a backlog of main messages from
    // firing one readiness probe (capture-pane) per message.
    let mainWakeCheckedThisTick = false
    for (const msg of pending) {
      const ageMs = now - msg.created_at * 1000
      // The main agent runs in `${MAIN_AGENT_ID}-channels`, not `agent-${name}`,
      // so agentSessionName() would miss it and strand every sub-agent → main
      // message as pending forever. Mirror the scheduler's session resolution.
      const isMainAgent = msg.to_agent === MAIN_AGENT_ID
      // PULL MODEL: the main agent drains its OWN inbox each turn (the
      // drain-inbox endpoint + UserPromptSubmit hook), so the router does NOT
      // tmux-inject into its perpetually-busy channel session -- that race is
      // what stalled inter-agent delivery to the main agent for ~1h on a busy
      // day. Leave the message pending; the next main-agent turn claims it
      // atomically. Sub-agents keep the tmux-inject path (they have idle gaps).
      //
      // Wake-nudge (kanban #96cd2ac9): to close the "up to 30 min until the next
      // main-agent turn" latency, nudge the idle channel session with a
      // CONTENT-FREE prompt so the drain hook fires now. Still no content-inject
      // and no markMessageDelivered here -- the pull path owns claim + framing.
      if (isMainAgent) {
        if (!mainWakeCheckedThisTick) {
          mainWakeCheckedThisTick = true
          maybeWakeMainAgent(ageMs, now)
        }
        continue
      }
      const session = agentSessionName(msg.to_agent)
      // Remote sub-agents run their tmux session on the laptop; resolve the host
      // so the existence/readiness checks and the send all cross the ssh
      // boundary. Local agents (and the main channels agent) stay host=null.
      const host = isMainAgent ? null : readAgentRemoteHost(msg.to_agent)

      const sessionExists = sessionExistsOnHost(host, session)

      if (shouldAbandon(sessionExists, ageMs, MESSAGE_ABANDON_WINDOW_MS)) {
        logger.warn({ id: msg.id, from: msg.from_agent, to: msg.to_agent, ageMs }, 'Agent message abandoned: target session absent for full retry window')
        if (!markMessageFailed(msg.id, 'Abandoned: target session absent for full retry window')) {
          logger.warn({ id: msg.id }, 'markMessageFailed affected 0 rows (deleted concurrently?)')
        }
        routerLoggedMisses.delete(msg.id)
        continue
      }

      if (!sessionExists) {
        if (!routerLoggedMisses.has(msg.id)) {
          logger.warn({ id: msg.id, to: msg.to_agent, session }, 'Agent message target session not running, will retry')
          routerLoggedMisses.add(msg.id)
        }
        continue
      }

      if (!isSessionReadyForPrompt(session, host)) {
        // Stale-parked-input janitor: a non-submitted line stuck in the input
        // box (e.g. a weak local model that typed its heartbeat reply into the
        // box instead of ending the turn) keeps isSessionReadyForPrompt false
        // forever, so this message -- and every later one -- strands as pending
        // and the channel silently wedges. Once a message has waited long enough,
        // clear a STABLE parked input so delivery resumes next tick. clearStale
        // ParkedInput only fires on the idle 'typing' state with text unchanged
        // across a settle, so it never clobbers a session that is actually
        // processing or input a human/agent is mid-typing.
        if (ageMs > JANITOR_PARKED_MIN_AGE_MS && clearStaleParkedInput(session, host)) {
          routerLoggedMisses.delete(msg.id)
          continue // input cleared; deliver on the next tick
        }
        if (!routerLoggedMisses.has(msg.id)) {
          logger.warn({ id: msg.id, to: msg.to_agent, session }, 'Agent message target session busy, will retry')
          routerLoggedMisses.add(msg.id)
        }
        continue
      }

      // Classify (channel-inbound / trusted-peer / untrusted) + reject an empty
      // from_agent -- SINGLE SOURCE in agent-message-wrap so the router and the
      // main-agent pull endpoint frame messages identically (no security drift).
      const cls = classifyAgentMessage(msg.from_agent, msg.to_agent)
      if (!cls) {
        logger.warn({ id: msg.id, rawFrom: msg.from_agent }, 'Agent message rejected: from_agent empty after sanitize')
        if (!markMessageFailed(msg.id, 'Invalid or empty from_agent')) {
          logger.warn({ id: msg.id }, 'markMessageFailed affected 0 rows (deleted concurrently?)')
        }
        routerLoggedMisses.delete(msg.id)
        continue
      }
      const { category, safeFrom: safeFromAgent } = cls
      const isChannelInbound = category === 'channel-inbound'
      const trusted = category === 'trusted-peer'

      // Voice auto-mode: if this is a channel-inbound voice message, run STT
      // and update the last-inbound-modality flag. The decision (STT or not)
      // lives HERE so both the inbound transcript injection and the modality
      // flag are set in one place, with full knowledge of agent-id + chat-id.
      let deliveryContent = msg.content
      if (isChannelInbound) {
        const voiceFileId = extractVoiceFileId(msg.content)
        const chatId = extractChatId(msg.content)
        const voiceCfg = readAgentVoiceConfig(msg.to_agent)
        if (voiceFileId && chatId) {
          // Always record modality so auto-mode TTS can fire on reply.
          setLastInboundModality(msg.to_agent, chatId, 'voice')
          if (voiceCfg.responseMode !== 'text') {
            // Attempt STT; on failure fall through to raw voice block.
            const transcript = await callVoiceSTT(voiceFileId, msg.to_agent)
            if (transcript) {
              deliveryContent = injectTranscript(msg.content, transcript)
              logger.info({ id: msg.id, agent: msg.to_agent }, 'message-router: voice STT applied')
              // TTS directive is injected by the UserPromptSubmit hook (voice-reply-directive.py)
              // which fires on every delivery path, not just coordinator-relay.
            } else {
              logger.warn({ id: msg.id, agent: msg.to_agent }, 'message-router: STT failed, delivering raw voice block')
            }
          }
        } else if (chatId) {
          // Text message: record modality so a previous voice flag is cleared.
          setLastInboundModality(msg.to_agent, chatId, 'text')
        }
      }

      try {
        // channel-inbound carries the STT-applied deliveryContent; the agent
        // wrap (trusted/untrusted) carries the raw content. Single-source frame.
        // msgId passed so receiving agents can write back via PUT /api/messages/:id.
        const content = isChannelInbound ? deliveryContent : msg.content
        const { prefix, wrapped } = wrapAgentMessageForDelivery(category, safeFromAgent, msg.from_agent, content, msg.id)
        // Inline preamble so a fresh session (post hard-restart) doesn't miss
        // the context that explains the tag semantics.
        sendPromptToSession(session, prefix + wrapped, host)
        if (!markMessageDelivered(msg.id)) {
          logger.warn({ id: msg.id }, 'markMessageDelivered affected 0 rows (deleted concurrently?)')
        }
        routerLoggedMisses.delete(msg.id)
        logger.info({ id: msg.id, from: msg.from_agent, to: msg.to_agent, category: isChannelInbound ? 'channel-inbound' : trusted ? 'trusted-peer' : 'untrusted' }, 'Agent message delivered')
      } catch (err) {
        logger.warn({ err, id: msg.id }, 'Failed to deliver agent message')
        if (!markMessageFailed(msg.id, 'Failed to inject into tmux session')) {
          logger.warn({ id: msg.id }, 'markMessageFailed affected 0 rows (deleted concurrently?)')
        }
        routerLoggedMisses.delete(msg.id)
      }
    }
}

// ---- voice helpers (message-router level) ----------------------------------

// Extract attachment_file_id from a <channel ... attachment_kind="voice" attachment_file_id="..."> block.
function extractVoiceFileId(content: string): string | null {
  if (!content.includes('attachment_kind="voice"')) return null
  const m = content.match(/attachment_file_id="([^"]+)"/)
  return m ? m[1] : null
}

// Extract chat_id from a <channel chat_id="..."> block.
function extractChatId(content: string): string | null {
  const m = content.match(/chat_id="([^"]+)"/)
  return m ? m[1] : null
}

// Replace the voice attachment block with a transcript prefix.
// Removes attachment_kind and attachment_file_id attributes; prepends [Hang átirat]:.
function injectTranscript(content: string, transcript: string): string {
  // Strip the attachment attributes from the opening tag
  let result = content
    .replace(/\s*attachment_kind="voice"/, '')
    .replace(/\s*attachment_file_id="[^"]*"/, '')
  // Replace the body with the transcript unconditionally (handles empty, "(empty message)", and caption).
  // Replacer function avoids $1/$& special-pattern interpretation in the transcript string.
  result = result.replace(
    /(<channel[^>]*>)[\s\S]*?(<\/channel>)/,
    (_m, open: string, close: string) => `${open}\n[Hang átirat]: ${transcript}\n${close}`,
  )
  return result
}

// Transcribe an inbound voice message. Calls transcribeVoiceFile() DIRECTLY
// (in-process) instead of self-HTTP'ing to /api/voice/stt: the old fetch to
// the same process's dashboard (65s AbortSignal) ran on the tick and coupled
// delivery to the HTTP server -- under sustained voice traffic it progressively
// throttled the event loop (/api/agents 73ms -> 12s -> timeout). The whisper
// subprocess keeps its own 60s timeout inside transcribeVoiceFile, so this can
// never hang the tick beyond that. Returns the transcript, or null on failure.
async function callVoiceSTT(fileId: string, agentId: string): Promise<string | null> {
  try {
    const { existsSync } = await import('node:fs')
    const { join } = await import('node:path')

    // Resolve the agent's channel state_dir using the canonical helper so
    // sub-agents (whose .env lives under AGENTS_BASE_DIR) are found correctly.
    const resolvedDir = resolveAgentChannelStateDir(agentId, 'telegram')
    if (!existsSync(join(resolvedDir, '.env'))) return null

    const { transcribeVoiceFile } = await import('./routes/voice.js')
    return await transcribeVoiceFile(fileId, resolvedDir)
  } catch (err) {
    logger.warn({ err }, 'message-router: callVoiceSTT error')
    return null
  }
}

