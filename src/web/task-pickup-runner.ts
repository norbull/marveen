import { logger } from '../logger.js'
import { OWNER_NAME, BOT_NAME, MAIN_AGENT_ID } from '../config.js'
import { listAgentNames, readAgentRemoteHost } from './agent-config.js'
import {
  agentRunState,
  agentSessionName,
  capturePane,
  isAgentRunning,
} from './agent-process.js'
import { paneLooksIdle } from '../pane-state.js'
import {
  getNextPickableCardForAssignee,
  getInProgressCardsForAssignee,
  moveKanbanCard,
  markKanbanCardDispatched,
  createAgentMessage,
} from '../db.js'
import { resolveKanbanDispatchTarget } from '../kanban-dispatch.js'
import { kanbanMoveInstructions } from './routes/kanban.js'

// Autonomous task pickup: when a running sub-agent is idle at its prompt and has
// no card in progress, hand it the highest-priority not-yet-dispatched
// planned/waiting card assigned to it. Detection + dispatch cost zero tokens; the
// agent only spends tokens once there is real work to pick up.
//
// Mirrors the existing move-to-in_progress dispatch path (routes/kanban.ts
// fireKanbanDispatch): move the card to in_progress, wake the agent via the
// inter-agent message router (retry / dedup / trust-wrap / busy-receiver handling
// for free -- NOT raw send-keys, which would loop against the 15s stuck-input
// watcher), and stamp dispatched_at as the once-only guard.

const INITIAL_DELAY_MS = 57_000
const INTERVAL_MS = 60_000

function pickForAgent(name: string): void {
  if (agentRunState(name) !== 'running') return

  // Idle-at-prompt gate: only inject when the agent is actually free. A busy or
  // unreadable pane is left alone.
  const session = agentSessionName(name)
  const host = readAgentRemoteHost(name)
  const pane = capturePane(session, host)
  if (pane == null || !paneLooksIdle(pane)) return

  // Do not pile a second task: if the agent already has work in progress, skip.
  if (getInProgressCardsForAssignee(name).length > 0) return

  const card = getNextPickableCardForAssignee(name)
  if (!card) return

  // Safety guard: the same resolver the manual dispatch uses (owner/bot/main
  // rules + running check). A null target means "do not dispatch".
  const target = resolveKanbanDispatchTarget(card.assignee, {
    ownerName: OWNER_NAME,
    botName: BOT_NAME,
    mainAgentId: MAIN_AGENT_ID,
    agentNames: listAgentNames(),
    isRunning: isAgentRunning,
  })
  if (!target) return

  try {
    moveKanbanCard(card.id, 'in_progress', card.sort_order)
    const desc = (card.description ?? '').trim()
    const content = `[Kanban feladat #${card.id}]: ${card.title}${desc ? ' — ' + desc : ''}\n\n${kanbanMoveInstructions(card.id, target)}`
    createAgentMessage(MAIN_AGENT_ID, target, content)
    markKanbanCardDispatched(card.id)
    logger.info({ id: card.id, target, priority: card.priority }, 'task-pickup: idle agent auto-assigned a card')
  } catch (err) {
    logger.warn({ err, id: card.id, name }, 'task-pickup: dispatch failed')
  }
}

export function startTaskPickupRunner(): NodeJS.Timeout {
  function sweep() {
    for (const name of listAgentNames()) {
      try { pickForAgent(name) } catch (err) { logger.debug({ err, agent: name }, 'task-pickup: agent check error') }
    }
  }
  setTimeout(sweep, INITIAL_DELAY_MS)
  return setInterval(sweep, INTERVAL_MS)
}
