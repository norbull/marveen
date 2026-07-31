// Channel Outbox -- DEAD-only outbound safety net for Norbi-bound agent replies.
//
// Problem: an agent delivers replies through the native channel plugin's reply
// MCP tool. While that plugin is DEAD (crashed / mid-respawn) the reply is lost
// with no retry, and Norbi only notices by watching the terminal.
//
// Design (approved 2026-07-12, dedup-first per Norbi):
//   - A row is enqueued ONLY when the agent's plugin was DEAD at send time, so
//     the reply tool could NOT have delivered it -> a later flush cannot dup a
//     message Norbi already received. (Enqueue happens in the reply-guard hook.)
//   - The drain flushes pending rows once the plugin is HEALTHY again, sending
//     DIRECTLY via the Bot API (telegramProvider.sendMessage is plugin
//     -independent), max 3 attempts on transient Bot-API errors, 5 min TTL.
//   - A HEALTHY-time reply that returns 500 is NOT queued here (dup risk) -- the
//     enqueue path only fires on a DEAD plugin.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from './logger.js'
import { MAIN_AGENT_ID } from './config.js'
import {
  getProvider, channelStateDir, readChannelToken, type ChannelProviderType,
} from './channel-provider.js'
import { agentDir } from './web/agent-config.js'
import { classifyTelegramSendError } from './pending-retries.js'
import {
  pendingChannelOutboxAgents, listPendingChannelOutbox,
  markChannelOutboxSent, bumpChannelOutboxAttempt, markChannelOutboxDropped,
} from './db.js'

export const MAX_ATTEMPTS = 3
export const TTL_MS = 5 * 60 * 1000
const DRAIN_INTERVAL_MS = 20_000

// --- pure decisions (no DB / no fs, so tests need neither) ---

/** A queued row past the TTL is stale -- drop rather than deliver a late reply. */
export function isExpired(createdAtSec: number, nowMs: number): boolean {
  return nowMs - createdAtSec * 1000 > TTL_MS
}

/**
 * What to do after a send attempt failed. `attemptsAfterBump` is the attempt
 * counter AFTER incrementing for this failure. Permanent Bot-API errors (4xx
 * except 429) never retry; transient ones retry until MAX_ATTEMPTS.
 */
export function decideAfterSendError(
  errMsg: string, attemptsAfterBump: number,
): 'drop-permanent' | 'drop-max' | 'retry' {
  if (classifyTelegramSendError(errMsg) === 'permanent') return 'drop-permanent'
  return attemptsAfterBump >= MAX_ATTEMPTS ? 'drop-max' : 'retry'
}

/** Per-agent channel state dir (main agent lives at ~/.claude/channels). */
function pluginStateDir(agentId: string, provider: ChannelProviderType): string {
  return agentId === MAIN_AGENT_ID
    ? channelStateDir(provider)
    : channelStateDir(provider, agentDir(agentId))
}

// HEALTHY = the plugin's bot.pid names a live process. The direct Bot-API send
// works even when the plugin is DEAD, but Norbi's rule flushes only once the
// plugin is back so we never race the agent's own reply during a DEAD window.
// Exported: the /api/channel/send endpoint uses it as the dedup gate -- it only
// enqueues when the plugin is DEAD, so a queued row can never duplicate a reply
// the tool already delivered while HEALTHY.
export function isPluginHealthy(agentId: string, provider: ChannelProviderType): boolean {
  const pidPath = join(pluginStateDir(agentId, provider), 'bot.pid')
  if (!existsSync(pidPath)) return false
  const pid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10)
  if (!Number.isFinite(pid)) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

function resolveToken(agentId: string, provider: ChannelProviderType): string | null {
  return readChannelToken(provider, join(pluginStateDir(agentId, provider), '.env'))
}

/** Flush one agent+provider queue. Caller guarantees the plugin is HEALTHY. */
async function drainAgentQueue(agentId: string, provider: ChannelProviderType): Promise<void> {
  const token = resolveToken(agentId, provider)
  if (!token) {
    logger.warn({ agentId, provider }, 'channel-outbox: no token, cannot flush')
    return
  }
  const providerImpl = getProvider(provider)
  const rows = listPendingChannelOutbox(agentId, provider)
  const nowMs = Date.now()
  for (const row of rows) {
    // TTL: a message older than the window is stale. Norbi has moved on;
    // dropping beats delivering a late, confusing reply.
    if (isExpired(row.created_at, nowMs)) {
      markChannelOutboxDropped(row.id, `TTL exceeded (${Math.round((nowMs - row.created_at * 1000) / 1000)}s)`)
      logger.warn({ id: row.id, agentId }, 'channel-outbox: dropped stale message (TTL)')
      continue
    }
    try {
      await providerImpl.sendMessage(token, row.chat_id, row.text, row.parse_mode ?? undefined)
      markChannelOutboxSent(row.id)
      logger.info({ id: row.id, agentId }, 'channel-outbox: flushed queued reply')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // Permanent errors don't burn an attempt (retrying can't help); transient
      // ones bump the counter and retry until MAX_ATTEMPTS.
      const permanent = classifyTelegramSendError(msg) === 'permanent'
      const attempts = permanent ? row.attempts : bumpChannelOutboxAttempt(row.id, msg)
      const action = decideAfterSendError(msg, attempts)
      if (action === 'retry') {
        logger.info({ id: row.id, agentId, attempts }, 'channel-outbox: transient error, will retry')
      } else {
        markChannelOutboxDropped(row.id, msg)
        logger.warn({ id: row.id, agentId, attempts, reason: action }, 'channel-outbox: dropped')
      }
    }
  }
}

/** One drain pass over every agent that has pending rows. */
export async function drainChannelOutbox(): Promise<void> {
  for (const { agent_id, provider } of pendingChannelOutboxAgents()) {
    const prov = provider as ChannelProviderType
    if (!isPluginHealthy(agent_id, prov)) continue // DEAD -> wait for recovery
    try {
      await drainAgentQueue(agent_id, prov)
    } catch (err) {
      logger.error({ err, agent_id }, 'channel-outbox: drain failed')
    }
  }
}

let drainTimer: NodeJS.Timeout | null = null

export function startChannelOutboxDrain(): void {
  if (drainTimer) return
  drainTimer = setInterval(() => {
    drainChannelOutbox().catch((err) => logger.error({ err }, 'channel-outbox: drain tick failed'))
  }, DRAIN_INTERVAL_MS)
  logger.info('Channel outbox drain elindult (20s)')
}

export function stopChannelOutboxDrain(): void {
  if (drainTimer) { clearInterval(drainTimer); drainTimer = null }
}
