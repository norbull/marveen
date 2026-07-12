import { logger } from '../../logger.js'
import { readBody, json } from '../http-helpers.js'
import { sanitizeAgentIdent } from '../../prompt-safety.js'
import { enqueueChannelOutbox } from '../../db.js'
import { isPluginHealthy } from '../../channel-outbox.js'
import type { ChannelProviderType } from '../../channel-provider.js'
import type { RouteContext } from './types.js'

// POST /api/channel/send -- DEAD-only outbound safety net.
//
// An agent posts a Norbi-bound reply here when its channel plugin was DEAD and
// the reply tool could not deliver. The endpoint is the DEDUP GATE: it enqueues
// ONLY when the plugin is DEAD right now. If the plugin is HEALTHY the reply
// tool is the live delivery path, so queuing would risk a duplicate and we
// decline. The drain (src/channel-outbox.ts) flushes queued rows once HEALTHY.
export async function tryHandleChannelSend(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (path === '/api/channel/send' && method === 'POST') {
    const body = await readBody(req)
    let parsed: { agent_id?: string; chat_id?: string; text?: string; parse_mode?: string; provider?: string }
    try {
      parsed = JSON.parse(body.toString())
    } catch {
      json(res, { error: 'malformed JSON body' }, 400)
      return true
    }

    // sanitizeAgentIdent strips path-unsafe chars -- agent_id feeds a filesystem
    // path (channel state dir / token / bot.pid), so this closes ../ traversal.
    const agentId = sanitizeAgentIdent(parsed.agent_id ?? '')
    const chatId = parsed.chat_id?.trim()
    const text = parsed.text
    const provider = (parsed.provider?.trim() || 'telegram') as ChannelProviderType
    const parseMode = parsed.parse_mode?.trim() || null

    if (!agentId || !chatId || !text?.trim()) {
      json(res, { error: 'agent_id, chat_id, and text are required' }, 400)
      return true
    }

    if (isPluginHealthy(agentId, provider)) {
      json(res, { queued: false, reason: 'plugin healthy; use the reply tool' })
      return true
    }

    const row = enqueueChannelOutbox(agentId, provider, chatId, text, parseMode)
    logger.info({ id: row.id, agentId, provider }, 'channel-outbox: enqueued DEAD-time reply')
    json(res, { queued: true, id: row.id })
    return true
  }

  return false
}
