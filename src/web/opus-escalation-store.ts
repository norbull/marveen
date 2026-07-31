import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { PROJECT_ROOT } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import {
  normalizeOpusEscalationConfig,
  normalizeEscalationState,
  DEFAULT_OPUS_ESCALATION,
  EMPTY_ESCALATION_STATE,
  type OpusEscalationConfig,
  type OpusEscalationState,
} from '../opus-escalation.js'

// Two files, mirroring the model-fallback split (src/web/model-fallback-store.ts):
//   - config: operator policy (master toggle + models + safety cap). Default
//     DISABLED, so an upgrade is inert until the operator turns it on.
//   - state:  the runtime escalation REQUEST (set by orin via the API). This is
//     persisted (not in-memory) so an escalation survives a dashboard restart --
//     otherwise orin could be stranded on Opus with no revert signal.
const CONFIG_PATH = join(PROJECT_ROOT, 'store', 'opus-escalation.json')
const STATE_PATH = join(PROJECT_ROOT, 'store', 'opus-escalation-state.json')

export function readOpusEscalationConfig(): OpusEscalationConfig {
  try {
    return normalizeOpusEscalationConfig(JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')))
  } catch {
    return { ...DEFAULT_OPUS_ESCALATION }
  }
}

export function writeOpusEscalationConfig(cfg: Partial<OpusEscalationConfig>): OpusEscalationConfig {
  const merged = normalizeOpusEscalationConfig({ ...readOpusEscalationConfig(), ...cfg })
  atomicWriteFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2))
  return merged
}

export function readEscalationState(): OpusEscalationState {
  try {
    return normalizeEscalationState(JSON.parse(readFileSync(STATE_PATH, 'utf-8')))
  } catch {
    return { ...EMPTY_ESCALATION_STATE }
  }
}

export function writeEscalationState(state: OpusEscalationState): OpusEscalationState {
  const normalized = normalizeEscalationState(state)
  atomicWriteFileSync(STATE_PATH, JSON.stringify(normalized, null, 2))
  return normalized
}
