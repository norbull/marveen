// CostOps v0.1 -- read-mostly HTTP API. Bearer-gated like every /api/* route.
// GET never writes: reflecting the local config's fixed costs into the ledger
// (an idempotent upsert by dedup_key) happens on its own schedule via
// startCostsSyncTask() below (called once at server boot), not as a side effect
// of a client request. No LLM, no provider API, no secrets in the response.

import { json, readBody } from '../http-helpers.js'
import { logger } from '../../logger.js'
import { getDb } from '../../db.js'
import { loadCostopsConfig } from '../../costops/config.js'
import { syncFixedCostsToLedger, getCostSummary, getCostSources, recordUsage } from '../../costops/ledger.js'
import { estimateUsageCost } from '../../costops/pricing.js'
import { checkBudget, resolveCircuitBreaker } from '../../costops/circuit-breaker.js'
import type { RouteContext } from './types.js'

// Runs the fixed-cost -> ledger reflection once immediately (so the summary is
// fresh from the moment the server comes up) and then on a fixed interval, so a
// manual edit to the local costops config eventually shows up without needing a
// restart. 10 minutes is deliberately coarse -- this is a manually-edited local
// config file, not something that needs near-real-time reflection, and this is
// the only place in the whole CostOps slice that writes to the DB at all.
const SYNC_INTERVAL_MS = 10 * 60 * 1000

export function startCostsSyncTask(intervalMs = SYNC_INTERVAL_MS): NodeJS.Timeout {
  const sync = () => {
    try {
      const { config } = loadCostopsConfig()
      syncFixedCostsToLedger(getDb(), config, Math.floor(Date.now() / 1000))
    } catch (err) {
      logger.warn({ err }, 'CostOps fixed-cost sync failed')
    }
  }
  sync()
  return setInterval(sync, intervalMs).unref()
}

export async function tryHandleCosts(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  if (path === '/api/costs/summary' && method === 'GET') {
    try {
      const monthKey = url.searchParams.get('month') || undefined
      const now = Math.floor(Date.now() / 1000)
      const { config, exists, errors } = loadCostopsConfig()
      const summary = getCostSummary(getDb(), config, now, {
        monthKey, configExists: exists, configErrors: errors,
      })
      json(res, summary)
    } catch (err) {
      logger.error({ err }, 'CostOps summary failed')
      json(res, { error: 'Cost summary failed' }, 500)
    }
    return true
  }

  if (path === '/api/costs/sources' && method === 'GET') {
    try {
      json(res, getCostSources(getDb()))
    } catch (err) {
      logger.error({ err }, 'CostOps sources failed')
      json(res, { error: 'Cost sources failed' }, 500)
    }
    return true
  }

  if (path === '/api/costs/budgets' && method === 'GET') {
    try {
      const { config } = loadCostopsConfig()
      json(res, config.budgets)
    } catch (err) {
      logger.error({ err }, 'CostOps budgets failed')
      json(res, { error: 'Cost budgets failed' }, 500)
    }
    return true
  }

  // POST /api/costs/usage -- record one paid-usage charge (provider-agnostic).
  // Bearer-gated by the central auth gate in web.ts like every /api/* route.
  // This is the only client-triggered ledger write; it is narrow, validated and
  // idempotent on the dedup ref (see recordUsage). A retry never double-counts.
  if (path === '/api/costs/usage' && method === 'POST') {
    const raw = await readBody(req)
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(raw.toString())
    } catch {
      json(res, { error: 'malformed JSON body' }, 400)
      return true
    }
    const provider = typeof parsed.provider === 'string' ? parsed.provider.trim() : ''
    if (!provider) {
      json(res, { error: 'provider is required' }, 400)
      return true
    }
    // model for pricing: explicit `model`, else the service_name (fal.ai callers
    // send the model as service_name, e.g. 'fal-ai/flux-pro/kontext').
    const model = typeof parsed.model === 'string' ? parsed.model
      : typeof parsed.service_name === 'string' ? parsed.service_name : undefined
    try {
      const { config } = loadCostopsConfig()
      const now = Math.floor(Date.now() / 1000)

      // billed_cost may be supplied explicitly (provider-priced call), OR derived
      // from the configured price table (providers don't return a cost). An
      // explicit value takes precedence; otherwise we estimate from provider+model
      // and record it at confidence 'estimate'. No price configured -> 400, so a
      // charge is never silently dropped nor recorded as a fabricated 0.
      let billed_cost = parsed.billed_cost
      let confidence = typeof parsed.confidence === 'string' ? parsed.confidence : undefined
      let estimated: ReturnType<typeof estimateUsageCost> = null
      if (billed_cost === undefined || billed_cost === null) {
        estimated = estimateUsageCost(config.pricing ?? [], {
          provider, model,
          quantity: typeof parsed.consumed_quantity === 'number' ? parsed.consumed_quantity : undefined,
        })
        if (!estimated) {
          json(res, { error: `billed_cost is required (no price configured for provider '${provider}'${model ? ` model '${model}'` : ''})` }, 400)
          return true
        }
        billed_cost = estimated.billed_cost
        confidence = confidence ?? 'estimate'
      }
      if (typeof billed_cost !== 'number' || !Number.isFinite(billed_cost) || billed_cost < 0) {
        json(res, { error: 'billed_cost must be a finite number >= 0' }, 400)
        return true
      }

      const result = recordUsage(getDb(), {
        provider,
        billed_cost,
        currency: typeof parsed.currency === 'string' ? parsed.currency : (estimated?.currency ?? config.currency),
        service_name: typeof parsed.service_name === 'string' ? parsed.service_name : model,
        agent: typeof parsed.agent === 'string' ? parsed.agent : undefined,
        project: typeof parsed.project === 'string' ? parsed.project : undefined,
        deliverable: typeof parsed.deliverable === 'string' ? parsed.deliverable : undefined,
        consumed_quantity: typeof parsed.consumed_quantity === 'number' ? parsed.consumed_quantity : undefined,
        consumed_unit: typeof parsed.consumed_unit === 'string' ? parsed.consumed_unit : (estimated?.unit),
        confidence: confidence as never,
        ref: typeof parsed.ref === 'string' ? parsed.ref : undefined,
        occurred_at: typeof parsed.occurred_at === 'number' ? parsed.occurred_at : undefined,
      }, now)
      json(res, { ok: true, billed_cost, estimated: estimated != null, ...result })
    } catch (err) {
      logger.error({ err }, 'CostOps usage record failed')
      json(res, { error: 'Cost usage record failed' }, 500)
    }
    return true
  }

  // GET /api/costs/budget-check -- pre-flight paid-generation gate. A caller hits
  // this BEFORE a paid generation: action 'hard_hold' means a cap is already
  // reached, do not spend. Optional provider/model/quantity add a pre-flight
  // estimate of the pending charge and whether committing it would breach a cap.
  if (path === '/api/costs/budget-check' && method === 'GET') {
    try {
      const { config } = loadCostopsConfig()
      const now = Math.floor(Date.now() / 1000)
      const cfg = resolveCircuitBreaker(config)
      const project = url.searchParams.get('project') || null
      const gate = checkBudget(getDb(), { project, now, cfg })

      // optional pre-flight: estimate the pending op and project the post-spend caps
      const provider = url.searchParams.get('provider')?.trim()
      const model = url.searchParams.get('model')?.trim() || undefined
      const qtyRaw = url.searchParams.get('quantity')
      const quantity = qtyRaw != null && qtyRaw !== '' ? Number(qtyRaw) : undefined
      let preflight: Record<string, unknown> | null = null
      if (provider) {
        const est = estimateUsageCost(config.pricing ?? [], { provider, model, quantity })
        if (est) {
          const projected_daily = round2(gate.daily_spend + est.billed_cost)
          const projected_project = gate.project_spend != null ? round2(gate.project_spend + est.billed_cost) : null
          preflight = {
            estimated_cost: est.billed_cost, currency: est.currency, unit: est.unit, matched_model: est.matched_model,
            projected_daily, projected_project,
            would_exceed_daily: projected_daily > cfg.daily_cap,
            would_exceed_project: projected_project != null && projected_project > cfg.project_cap,
          }
        } else {
          preflight = { estimated_cost: null, note: `no price configured for provider '${provider}'${model ? ` model '${model}'` : ''}` }
        }
      }
      json(res, { ...gate, preflight })
    } catch (err) {
      logger.error({ err }, 'CostOps budget-check failed')
      json(res, { error: 'Cost budget-check failed' }, 500)
    }
    return true
  }

  return false
}

function round2(n: number): number { return Math.round(n * 100) / 100 }
