// CostOps -- cost circuit-breaker (pure decision core).
//
// The client-deliverable governance enforcement layer for paid generation. This
// module is PURE decision logic + a small attempt/fail ledger: no LLM, no
// network, no generation. `db` and `now` are passed in, so every function is
// deterministic and unit-testable against an in-memory database.
//
// It is deliberately NOT wired into any generation pipeline: no such pipeline
// exists in this repo yet. The future AI-video / image service (the revenue
// line) will call these functions -- budget gate BEFORE a paid generation, and
// the retry/fail evaluator AFTER a QC failure. Until then the core stands ready
// and fully covered by tests.
//
// Four responsibilities (Norbi-approved caps, Orin scope decisions):
//   1. retry cap        -- max_retries per deliverable; the next fail holds.
//   2. fail classify    -- same client+fail_code >= threshold => systematic.
//   3. budget cap        -- per-day + per-project paid spend, provider-agnostic,
//                          enforced BEFORE generation (reads cost_line_items).
//   4. model fallback   -- consistent model failure never auto-switches; it
//                          escalates the model choice to Orin.

import type Database from 'better-sqlite3'
import type { CostOpsConfig, CircuitBreakerConfig } from './config.js'
import { DEFAULT_CIRCUIT_BREAKER } from './config.js'

// ---- Iris QC fail-taxonomy (canonical code home) ---------------------------
// Mirrors the Iris QC-rubric v1.0 (governance doc, not code). Defined here so
// the fail taxonomy has a single canonical, type-checked home the enforcement
// core can reason over. Keep in sync with the rubric doc.
export const FAIL_CODES = [
  'BRAND_LOCK_MISSING',
  'RATIO_MISMATCH',
  'TEXT_OUTSIDE_SAFE_ZONE',
  'COLOR_MISMATCH',
  'FONT_MISMATCH',
  'LOGO_MISSING',
  'LOGO_MISPLACED',
  'AI_ARTIFACT_DETECTED',
  'PROHIBITED_ELEMENT',
  'LOW_RESOLUTION',
  'UNSUPPORTED_FORMAT',
] as const

export type FailCode = typeof FAIL_CODES[number]

export function isFailCode(x: unknown): x is FailCode {
  return typeof x === 'string' && (FAIL_CODES as readonly string[]).includes(x)
}

// ---- decision vocabulary ---------------------------------------------------
// The single enum every circuit-breaker call resolves to. The future pipeline
// maps these onto EXISTING mechanisms -- notably hold_awaiting_approval ->
// card to `waiting` + BLOKK label + comment (no new kanban status needed).
export type CircuitAction =
  | 'allow'                   // proceed
  | 'retry'                   // a prior attempt failed but retries remain
  | 'hold_awaiting_approval'  // retries exhausted -> hold for human/Orin approval
  | 'hard_hold'               // a budget cap is reached -> stop before generation
  | 'orin_decision'           // consistent failure -> escalate the choice to Orin

// ---- config resolution -----------------------------------------------------

/** The effective circuit-breaker caps: the config block, or the defaults. */
export function resolveCircuitBreaker(config: CostOpsConfig): CircuitBreakerConfig {
  return config.circuit_breaker ?? { ...DEFAULT_CIRCUIT_BREAKER }
}

// ---- attempt/fail ledger (deliverable_attempts) ----------------------------

export interface AttemptRecord {
  client_id: string
  deliverable: string
  fail_code?: FailCode | null   // null/undefined = a successful attempt
}

/**
 * Append one generation attempt for a deliverable and return its 1-based
 * attempt number. fail_code null = success. Attempt numbering is derived from
 * the current row count so it is monotonic per (client_id, deliverable).
 */
export function recordAttempt(db: Database.Database, a: AttemptRecord, now: number): number {
  const prev = db.prepare(
    'SELECT COUNT(*) AS c FROM deliverable_attempts WHERE client_id = ? AND deliverable = ?'
  ).get(a.client_id, a.deliverable) as { c: number }
  const attempt_no = prev.c + 1
  db.prepare(
    `INSERT INTO deliverable_attempts (client_id, deliverable, attempt_no, fail_code, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(a.client_id, a.deliverable, attempt_no, a.fail_code ?? null, now)
  return attempt_no
}

/** Number of FAILED attempts (fail_code not null) for a deliverable. */
export function countFailedAttempts(db: Database.Database, client_id: string, deliverable: string): number {
  return (db.prepare(
    'SELECT COUNT(*) AS c FROM deliverable_attempts WHERE client_id = ? AND deliverable = ? AND fail_code IS NOT NULL'
  ).get(client_id, deliverable) as { c: number }).c
}

/** How many times this client hit this exact fail_code (across deliverables). */
export function countFailsByCode(db: Database.Database, client_id: string, fail_code: FailCode): number {
  return (db.prepare(
    'SELECT COUNT(*) AS c FROM deliverable_attempts WHERE client_id = ? AND fail_code = ?'
  ).get(client_id, fail_code) as { c: number }).c
}

// ---- 1. retry cap ----------------------------------------------------------

/**
 * Decide what to do after `failedAttempts` failures on one deliverable.
 * `max_retries` retries are allowed, so failure number (max_retries + 1) is the
 * one that exhausts them: e.g. max_retries=2 -> fail#1 retry, fail#2 retry,
 * fail#3 hold. Pass the failure count INCLUDING the one just recorded.
 */
export function evaluateRetry(failedAttempts: number, cfg: CircuitBreakerConfig): CircuitAction {
  return failedAttempts > cfg.max_retries ? 'hold_awaiting_approval' : 'retry'
}

// ---- 2. fail classification ------------------------------------------------

export interface FailClassification {
  systematic: boolean   // true => a human should investigate/restart, not a retry
  count: number         // how many times this client+fail_code has occurred
}

/**
 * A fault repeating for the same client + fail_code is systematic (a broken
 * input / config), not a transient miss -- once it reaches the threshold a
 * human is pulled in instead of burning further retries. Call AFTER recording
 * the failing attempt so the current fail is counted.
 */
export function classifyFail(
  db: Database.Database,
  client_id: string,
  fail_code: FailCode,
  cfg: CircuitBreakerConfig,
): FailClassification {
  const count = countFailsByCode(db, client_id, fail_code)
  return { systematic: count >= cfg.systematic_threshold, count }
}

// ---- 3. budget cap (enforced BEFORE a paid generation) ---------------------

export interface BudgetCheck {
  action: 'allow' | 'hard_hold'
  daily_spend: number
  daily_cap: number
  project: string | null
  project_spend: number | null    // null when no project scope was given
  project_cap: number
  currency: string
  reason: string | null
}

interface UsageLineRow {
  billed_cost: number
  charge_period_start: number
  source_ref: string | null
}

/**
 * Provider-agnostic paid-spend gate. Aggregates the RAW usage line items (not
 * the monthly getCostSummary): today's total spend (UTC day) against daily_cap,
 * and the given project's cumulative spend (all-time, matched on the source_ref
 * attribution JSON) against project_cap. Only lines in `cfg.currency` count --
 * there is no FX in v0.1, so a cap in USD compares against USD-priced usage.
 * hard_hold when EITHER cap is already reached; the gate runs before the new
 * charge, so ">=" means "stop, do not spend more".
 */
export function checkBudget(
  db: Database.Database,
  opts: { project?: string | null; now: number; cfg: CircuitBreakerConfig },
): BudgetCheck {
  const { now, cfg } = opts
  const project = opts.project ?? null
  const dayStart = Math.floor(now / 86400) * 86400   // UTC midnight
  const dayEnd = dayStart + 86400

  // Pull every paid usage line in the cap currency once, aggregate in JS.
  const rows = db.prepare(
    `SELECT billed_cost, charge_period_start, source_ref
       FROM cost_line_items
      WHERE charge_category = 'usage' AND currency = ?`
  ).all(cfg.currency) as UsageLineRow[]

  let daily_spend = 0
  let project_spend = project === null ? null : 0
  for (const r of rows) {
    if (r.charge_period_start >= dayStart && r.charge_period_start < dayEnd) {
      daily_spend += r.billed_cost
    }
    if (project !== null && lineProject(r.source_ref) === project) {
      project_spend = (project_spend ?? 0) + r.billed_cost
    }
  }
  daily_spend = round2(daily_spend)
  if (project_spend !== null) project_spend = round2(project_spend)

  let reason: string | null = null
  if (daily_spend >= cfg.daily_cap) {
    reason = `daily cap reached: ${daily_spend} >= ${cfg.daily_cap} ${cfg.currency}`
  } else if (project_spend !== null && project_spend >= cfg.project_cap) {
    reason = `project cap reached: ${project_spend} >= ${cfg.project_cap} ${cfg.currency} (${project})`
  }

  return {
    action: reason ? 'hard_hold' : 'allow',
    daily_spend, daily_cap: cfg.daily_cap,
    project, project_spend, project_cap: cfg.project_cap,
    currency: cfg.currency, reason,
  }
}

/** Extract the project attribution from a usage line's source_ref JSON. */
function lineProject(source_ref: string | null): string | null {
  if (!source_ref) return null
  try {
    const parsed = JSON.parse(source_ref) as { project?: unknown }
    return typeof parsed.project === 'string' ? parsed.project : null
  } catch {
    return null
  }
}

// ---- 4. model fallback -----------------------------------------------------

/**
 * A model that keeps failing is never auto-swapped: once the consecutive-fail
 * streak reaches the systematic threshold the model choice is escalated to Orin
 * ('orin_decision'). Below the threshold there is nothing to escalate ('allow').
 */
export function modelFallback(consecutiveModelFails: number, cfg: CircuitBreakerConfig): CircuitAction {
  return consecutiveModelFails >= cfg.systematic_threshold ? 'orin_decision' : 'allow'
}

function round2(n: number): number { return Math.round(n * 100) / 100 }
