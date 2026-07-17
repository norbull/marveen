// Contract tests for the cost circuit-breaker pure decision core.
//
// Pure logic + a small attempt/fail ledger, driven on an in-memory database
// seeded with the production schema (initDatabase). Budget tests seed real
// usage line items via recordUsage so checkBudget aggregates the same rows the
// production ledger produces.

import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { recordUsage } from '../costops/ledger.js'
import { validateConfig, DEFAULT_CIRCUIT_BREAKER } from '../costops/config.js'
import type { CircuitBreakerConfig } from '../costops/config.js'
import {
  FAIL_CODES,
  isFailCode,
  recordAttempt,
  countFailedAttempts,
  countFailsByCode,
  evaluateRetry,
  classifyFail,
  checkBudget,
  modelFallback,
  resolveCircuitBreaker,
} from '../costops/circuit-breaker.js'

// 2026-07-15T12:00:00Z -- deterministic "now".
const NOW = Math.floor(Date.UTC(2026, 6, 15, 12, 0, 0) / 1000)
const DAY = 86400

const CFG: CircuitBreakerConfig = {
  currency: 'USD', daily_cap: 5, project_cap: 20, max_retries: 2, systematic_threshold: 2,
}

beforeEach(() => {
  initDatabase(':memory:')
})

describe('fail-code taxonomy', () => {
  it('has the 11 Iris QC-rubric codes and a working guard', () => {
    expect(FAIL_CODES).toHaveLength(11)
    expect(isFailCode('COLOR_MISMATCH')).toBe(true)
    expect(isFailCode('LOGO_MISSING')).toBe(true)
    expect(isFailCode('NOT_A_CODE')).toBe(false)
    expect(isFailCode(42)).toBe(false)
  })
})

describe('attempt/fail ledger', () => {
  it('numbers attempts monotonically per deliverable and counts failures', () => {
    const db = getDb()
    expect(recordAttempt(db, { client_id: 'Acme', deliverable: 'poster' }, NOW)).toBe(1)             // success
    expect(recordAttempt(db, { client_id: 'Acme', deliverable: 'poster', fail_code: 'COLOR_MISMATCH' }, NOW)).toBe(2)
    expect(recordAttempt(db, { client_id: 'Acme', deliverable: 'poster', fail_code: 'LOGO_MISSING' }, NOW)).toBe(3)

    expect(countFailedAttempts(db, 'Acme', 'poster')).toBe(2)
    // a different deliverable is independent
    expect(recordAttempt(db, { client_id: 'Acme', deliverable: 'banner' }, NOW)).toBe(1)
    expect(countFailedAttempts(db, 'Acme', 'banner')).toBe(0)
  })

  it('counts a client+fail_code across deliverables', () => {
    const db = getDb()
    recordAttempt(db, { client_id: 'Acme', deliverable: 'poster', fail_code: 'COLOR_MISMATCH' }, NOW)
    recordAttempt(db, { client_id: 'Acme', deliverable: 'banner', fail_code: 'COLOR_MISMATCH' }, NOW)
    recordAttempt(db, { client_id: 'Acme', deliverable: 'banner', fail_code: 'FONT_MISMATCH' }, NOW)
    expect(countFailsByCode(db, 'Acme', 'COLOR_MISMATCH')).toBe(2)
    expect(countFailsByCode(db, 'Acme', 'FONT_MISMATCH')).toBe(1)
    expect(countFailsByCode(db, 'Beta', 'COLOR_MISMATCH')).toBe(0)
  })
})

describe('retry cap (evaluateRetry)', () => {
  it('allows retries up to max_retries, then holds on the exhausting fail', () => {
    expect(evaluateRetry(1, CFG)).toBe('retry')                 // fail #1
    expect(evaluateRetry(2, CFG)).toBe('retry')                 // fail #2
    expect(evaluateRetry(3, CFG)).toBe('hold_awaiting_approval') // fail #3 -> hold
    expect(evaluateRetry(4, CFG)).toBe('hold_awaiting_approval')
  })
})

describe('fail classification (classifyFail)', () => {
  it('flags systematic when a client+fail_code reaches the threshold', () => {
    const db = getDb()
    recordAttempt(db, { client_id: 'Acme', deliverable: 'poster', fail_code: 'RATIO_MISMATCH' }, NOW)
    expect(classifyFail(db, 'Acme', 'RATIO_MISMATCH', CFG)).toEqual({ systematic: false, count: 1 })

    recordAttempt(db, { client_id: 'Acme', deliverable: 'banner', fail_code: 'RATIO_MISMATCH' }, NOW)
    expect(classifyFail(db, 'Acme', 'RATIO_MISMATCH', CFG)).toEqual({ systematic: true, count: 2 })
  })
})

describe('budget cap (checkBudget)', () => {
  function seed(billed: number, opts: { project?: string; ref: string; currency?: string; at?: number }) {
    recordUsage(getDb(), {
      provider: 'fal.ai', billed_cost: billed, currency: opts.currency ?? 'USD',
      project: opts.project, ref: opts.ref, occurred_at: opts.at ?? NOW,
    }, NOW)
  }

  it('allows when under both caps', () => {
    seed(2, { project: 'Acme', ref: 'g1' })
    const r = checkBudget(getDb(), { project: 'Acme', now: NOW, cfg: CFG })
    expect(r.action).toBe('allow')
    expect(r.daily_spend).toBe(2)
    expect(r.project_spend).toBe(2)
  })

  it('hard-holds when the daily cap is reached', () => {
    seed(3, { project: 'Acme', ref: 'g1' })
    seed(2, { project: 'Beta', ref: 'g2' })   // different project, same day -> counts to daily
    const r = checkBudget(getDb(), { project: 'Acme', now: NOW, cfg: CFG })
    expect(r.daily_spend).toBe(5)
    expect(r.action).toBe('hard_hold')
    expect(r.reason).toMatch(/daily cap/)
  })

  it('hard-holds when the project cap is reached (cumulative, all-time)', () => {
    // Keep today's line under the daily cap (4 < 5) so the PROJECT cap is the
    // only trigger; the older line pushes the cumulative project total to 20.
    seed(16, { project: 'Acme', ref: 'g1', at: NOW - 3 * DAY })  // earlier day, still counts to project
    seed(4, { project: 'Acme', ref: 'g2' })
    const r = checkBudget(getDb(), { project: 'Acme', now: NOW, cfg: CFG })
    expect(r.project_spend).toBe(20)
    expect(r.daily_spend).toBe(4)             // only today's line, under daily cap
    expect(r.action).toBe('hard_hold')
    expect(r.reason).toMatch(/project cap/)
  })

  it('daily total ignores other days; project total ignores other projects', () => {
    seed(4, { project: 'Acme', ref: 'today' })
    seed(9, { project: 'Acme', ref: 'yesterday', at: NOW - DAY })
    seed(3, { project: 'Beta', ref: 'beta-today' })
    const r = checkBudget(getDb(), { project: 'Acme', now: NOW, cfg: CFG })
    expect(r.daily_spend).toBe(7)     // 4 Acme + 3 Beta today (yesterday's 9 excluded)
    expect(r.project_spend).toBe(13)  // 4 + 9 Acme all-time (Beta excluded)
    expect(r.action).toBe('hard_hold') // daily 7 >= 5
  })

  it('ignores usage lines in a different currency (no FX in v0.1)', () => {
    seed(100000, { project: 'Acme', ref: 'huf', currency: 'HUF' })   // huge HUF spend
    const r = checkBudget(getDb(), { project: 'Acme', now: NOW, cfg: CFG })
    expect(r.daily_spend).toBe(0)
    expect(r.action).toBe('allow')
  })

  it('reports null project_spend when no project scope is given', () => {
    seed(2, { project: 'Acme', ref: 'g1' })
    const r = checkBudget(getDb(), { now: NOW, cfg: CFG })
    expect(r.project_spend).toBeNull()
    expect(r.daily_spend).toBe(2)
    expect(r.action).toBe('allow')
  })
})

describe('model fallback (modelFallback)', () => {
  it('escalates to Orin only once the fail streak is systematic; never auto', () => {
    expect(modelFallback(1, CFG)).toBe('allow')
    expect(modelFallback(2, CFG)).toBe('orin_decision')
    expect(modelFallback(5, CFG)).toBe('orin_decision')
  })
})

describe('config integration', () => {
  it('resolveCircuitBreaker falls back to defaults when the block is absent', () => {
    const { config } = validateConfig({ version: 1, currency: 'HUF', fixed_costs: [], budgets: [] })
    expect(config.circuit_breaker).toEqual(DEFAULT_CIRCUIT_BREAKER)
    expect(resolveCircuitBreaker(config)).toEqual(DEFAULT_CIRCUIT_BREAKER)
  })

  it('parses a provided circuit_breaker block and falls back per-field on bad values', () => {
    const { config, errors } = validateConfig({
      version: 1, currency: 'USD', fixed_costs: [], budgets: [],
      circuit_breaker: { currency: 'USD', daily_cap: 10, project_cap: -3, max_retries: 1 },
    })
    expect(config.circuit_breaker?.daily_cap).toBe(10)
    expect(config.circuit_breaker?.max_retries).toBe(1)
    expect(config.circuit_breaker?.project_cap).toBe(DEFAULT_CIRCUIT_BREAKER.project_cap) // -3 rejected
    expect(errors.some((e) => e.includes('project_cap'))).toBe(true)
  })
})
