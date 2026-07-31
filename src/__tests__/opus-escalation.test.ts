import { describe, it, expect } from 'vitest'
import {
  normalizeOpusEscalationConfig,
  normalizeEscalationState,
  isEscalationExpired,
  decideEscalationAction,
  DEFAULT_OPUS_ESCALATION,
  OPUS_MODEL_ID,
  SONNET_MODEL_ID,
  type EscalationFacts,
} from '../opus-escalation.js'

const MAX_MS = 30 * 60_000

function facts(over: Partial<EscalationFacts>): EscalationFacts {
  return {
    active: false,
    requestedAt: null,
    currentModel: SONNET_MODEL_ID,
    escalateModel: OPUS_MODEL_ID,
    baseModel: SONNET_MODEL_ID,
    now: 1_000_000,
    maxEscalationMs: MAX_MS,
    ...over,
  }
}

describe('normalizeOpusEscalationConfig', () => {
  it('defaults on junk', () => {
    expect(normalizeOpusEscalationConfig(null)).toEqual(DEFAULT_OPUS_ESCALATION)
    expect(normalizeOpusEscalationConfig('nope')).toEqual(DEFAULT_OPUS_ESCALATION)
    expect(normalizeOpusEscalationConfig({})).toEqual(DEFAULT_OPUS_ESCALATION)
  })
  it('is disabled by default (feature off unless explicitly enabled)', () => {
    expect(DEFAULT_OPUS_ESCALATION.enabled).toBe(false)
    expect(normalizeOpusEscalationConfig({ enabled: 'yes' }).enabled).toBe(false)
    expect(normalizeOpusEscalationConfig({ enabled: true }).enabled).toBe(true)
  })
  it('respects valid overrides', () => {
    const c = normalizeOpusEscalationConfig({
      enabled: true, escalateModel: 'x', baseModel: 'y', maxEscalationMinutes: 10,
    })
    expect(c).toEqual({ enabled: true, escalateModel: 'x', baseModel: 'y', maxEscalationMinutes: 10 })
  })
  it('floors a fractional cap and ignores non-positive', () => {
    expect(normalizeOpusEscalationConfig({ maxEscalationMinutes: 12.9 }).maxEscalationMinutes).toBe(12)
    expect(normalizeOpusEscalationConfig({ maxEscalationMinutes: 0 }).maxEscalationMinutes)
      .toBe(DEFAULT_OPUS_ESCALATION.maxEscalationMinutes)
    expect(normalizeOpusEscalationConfig({ maxEscalationMinutes: -5 }).maxEscalationMinutes)
      .toBe(DEFAULT_OPUS_ESCALATION.maxEscalationMinutes)
  })
})

describe('normalizeEscalationState', () => {
  it('treats active-without-timestamp as inactive (corrupt file cannot strand orin on Opus)', () => {
    expect(normalizeEscalationState({ active: true })).toEqual({ active: false, requestedAt: null })
  })
  it('keeps a valid active state', () => {
    expect(normalizeEscalationState({ active: true, requestedAt: 42, reason: 'hard merge' }))
      .toEqual({ active: true, requestedAt: 42, reason: 'hard merge' })
  })
  it('defaults junk to inactive', () => {
    expect(normalizeEscalationState(null)).toEqual({ active: false, requestedAt: null })
    expect(normalizeEscalationState({ active: 'x', requestedAt: 'y' })).toEqual({ active: false, requestedAt: null })
  })
  it('preserves appliedModel even when a malformed active is dropped (pending revert not lost)', () => {
    expect(normalizeEscalationState({ active: true, appliedModel: OPUS_MODEL_ID }))
      .toEqual({ active: false, requestedAt: null, appliedModel: OPUS_MODEL_ID })
  })
})

describe('isEscalationExpired', () => {
  it('is false when inactive (null requestedAt)', () => {
    expect(isEscalationExpired(null, 10_000_000, MAX_MS)).toBe(false)
  })
  it('is false within the window, true at/after the cap', () => {
    const t = 1_000_000
    expect(isEscalationExpired(t, t + MAX_MS - 1, MAX_MS)).toBe(false)
    expect(isEscalationExpired(t, t + MAX_MS, MAX_MS)).toBe(true)
    expect(isEscalationExpired(t, t + MAX_MS + 5_000, MAX_MS)).toBe(true)
  })
})

describe('decideEscalationAction', () => {
  it('escalates up when active and not yet on Opus', () => {
    const a = decideEscalationAction(facts({ active: true, requestedAt: 1_000_000, currentModel: SONNET_MODEL_ID }))
    expect(a).toEqual({ kind: 'escalate', model: OPUS_MODEL_ID })
  })
  it('does nothing when active and already on Opus within the window', () => {
    const a = decideEscalationAction(facts({ active: true, requestedAt: 990_000, currentModel: OPUS_MODEL_ID }))
    expect(a).toEqual({ kind: 'none' })
  })
  it('reverts (expired) when active past the safety cap', () => {
    const a = decideEscalationAction(facts({
      active: true, requestedAt: 1_000_000 - MAX_MS, currentModel: OPUS_MODEL_ID,
    }))
    expect(a).toEqual({ kind: 'revert', model: SONNET_MODEL_ID, expired: true })
  })
  it('reverts down when de-escalated (inactive) and still on Opus', () => {
    const a = decideEscalationAction(facts({ active: false, currentModel: OPUS_MODEL_ID }))
    expect(a).toEqual({ kind: 'revert', model: SONNET_MODEL_ID, expired: false })
  })
  it('does nothing when inactive and already on base', () => {
    expect(decideEscalationAction(facts({ active: false, currentModel: SONNET_MODEL_ID }))).toEqual({ kind: 'none' })
  })
  it('never touches a model we did not escalate to (e.g. a fallback downgrade to Haiku)', () => {
    const a = decideEscalationAction(facts({ active: false, currentModel: 'claude-haiku-4-5-20251001' }))
    expect(a).toEqual({ kind: 'none' })
  })
})
