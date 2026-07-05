import { logger } from '../logger.js'
import { MAIN_AGENT_ID } from '../config.js'
import { listAgentNames, readAgentRemoteHost } from './agent-config.js'
import {
  agentRunState,
  agentSessionName,
  capturePane,
  getAgentRunningSince,
} from './agent-process.js'
import { paneLooksIdle } from '../pane-state.js'
import { getInProgressCardsForAssignee, createAgentMessage } from '../db.js'
import { sendAlert } from './channel-monitor.js'
import {
  decideStuckAgent,
  DEFAULT_STUCK_MS,
  type StuckAgentState,
} from '../stuck-agent.js'

// Watches running sub-agents that are SUPPOSED to be working (have an in_progress
// card) and, when one's pane goes quiet for too long while non-idle, fires a
// NON-silent alert. See src/stuck-agent.ts for the why and the pure decision.
//
// Mirrors the other watcher loops: a 60s sweep, offset so capture-pane calls do
// not pile onto one tick. Alert routing (per Norbi): a direct Telegram alert so
// it reaches the human, plus an inter-agent note to the main agent (Orin) -- the
// same shape the stuck-tool-call watcher uses for the main session.

const INITIAL_DELAY_MS = 55_000
const INTERVAL_MS = 60_000
// A freshly (re)started session needs to boot before a static pane means
// anything; ignore stuck-judgement for this long after session creation.
const RESPAWN_GRACE_SEC = 120

const states = new Map<string, StuckAgentState>()

function alertStuck(name: string, cardTitle: string, quietMs: number): void {
  const mins = Math.round(quietMs / 60_000)
  const human = `⚠️ Stuck-gyanú: a(z) ${name} ágens kb. ${mins} perce nem produkál új kimenetet, pedig van in_progress kártyája ("${cardTitle}"). Nézd meg a panelját.`
  try {
    sendAlert(human)
  } catch (err) {
    logger.warn({ err, name }, 'stuck-agent: telegram alert failed')
  }
  try {
    createAgentMessage(
      name, MAIN_AGENT_ID,
      `[STUCK-DETEKTOR] A(z) ${name} ágens ${mins} perce nem halad (pane befagyott), in_progress kártya: "${cardTitle}". Erdemes ranezni / eszkalalni Norbihoz ha kell.`,
    )
  } catch (err) {
    logger.warn({ err, name }, 'stuck-agent: inter-agent notice failed')
  }
  logger.warn({ name, cardTitle, quietMs }, 'stuck-agent: stuck-suspect alert fired')
}

function checkAgent(name: string, nowMs: number): void {
  if (agentRunState(name) !== 'running') {
    states.delete(name)
    return
  }

  const inProgress = getInProgressCardsForAssignee(name)
  if (inProgress.length === 0) {
    // Not supposed to be actively working -> nothing to judge.
    states.delete(name)
    return
  }

  const session = agentSessionName(name)
  const host = readAgentRemoteHost(name)
  const pane = capturePane(session, host)
  const idle = pane != null && paneLooksIdle(pane)

  const runningSince = getAgentRunningSince(name) // epoch seconds
  const withinRespawnGrace =
    runningSince != null && (Math.floor(nowMs / 1000) - runningSince) < RESPAWN_GRACE_SEC

  const { state, action } = decideStuckAgent(
    states.get(name) ?? null,
    { pane, idle, hasInProgressCard: true, withinRespawnGrace },
    nowMs,
    { stuckMs: DEFAULT_STUCK_MS },
  )

  if (state === null) states.delete(name)
  else states.set(name, state)

  if (action === 'alert') {
    const quietMs = state ? nowMs - state.lastChangeAtMs : DEFAULT_STUCK_MS
    alertStuck(name, inProgress[0].title, quietMs)
  }
}

export function startStuckAgentWatcher(): NodeJS.Timeout {
  function sweep() {
    const now = Date.now()
    for (const name of listAgentNames()) {
      try { checkAgent(name, now) } catch (err) { logger.debug({ err, agent: name }, 'stuck-agent: agent check error') }
    }
  }
  setTimeout(sweep, INITIAL_DELAY_MS)
  return setInterval(sweep, INTERVAL_MS)
}
