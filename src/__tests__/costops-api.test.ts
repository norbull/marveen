import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'
import { initDatabase, getDb } from '../db.js'
import { tryHandleCosts, startCostsSyncTask } from '../web/routes/costs.js'
import { monthWindow } from '../costops/ledger.js'
import { COSTOPS_CONFIG_PATH } from '../costops/config.js'
import type { RouteContext } from '../web/routes/types.js'

// Minimal fake ServerResponse capturing what json() writes. `body`, when given,
// is streamed as the request payload so POST handlers can readBody(req).
function fakeCtx(path: string, method = 'GET', body?: string): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const url = new URL(`http://localhost:3420${path}`)
  const req: any = body != null ? Readable.from([Buffer.from(body)]) : {}
  const ctx = { req, res, path: url.pathname, method, url } as RouteContext
  return { ctx, out }
}

describe('costops API (route smoke)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('GET /api/costs/summary returns a well-formed read-only summary', async () => {
    // seed a current-month token_usage row -> proves volume is reported but NOT priced
    const now = Math.floor(Date.now() / 1000)
    const w = monthWindow(now)
    getDb().prepare("INSERT INTO token_usage (agent,session_id,timestamp,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens) VALUES ('marveen','s',?,1234,5678,0,0)").run(w.start + 100)

    const { ctx, out } = fakeCtx('/api/costs/summary')
    const handled = await tryHandleCosts(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(200)
    // shape
    expect(out.body).toHaveProperty('month')
    expect(out.body).toHaveProperty('current_spend')
    expect(out.body).toHaveProperty('forecast_month_end')
    expect(out.body).toHaveProperty('top_sources')
    expect(out.body).toHaveProperty('confidence_breakdown')
    expect(out.body).toHaveProperty('breakdown')
    expect(out.body).toHaveProperty('budget')
    expect(out.body).toHaveProperty('token_usage')
    // token usage reported as VOLUME
    expect(out.body.token_usage.input_tokens).toBe(1234)
    expect(out.body.token_usage.output_tokens).toBe(5678)
    expect(out.body.token_usage.note).toContain('not priced')
    // money never derived from tokens (config amounts are 0 placeholders)
    expect(typeof out.body.current_spend).toBe('number')
    // no secret / account id leaks into the response
    expect(JSON.stringify(out.body)).not.toMatch(/secret|api[_-]?key|password|token=/i)
  })

  it('GET /api/costs/sources returns an array', async () => {
    const { ctx, out } = fakeCtx('/api/costs/sources')
    expect(await tryHandleCosts(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(Array.isArray(out.body)).toBe(true)
  })

  it('falls through (returns false) for unrelated paths', async () => {
    const { ctx } = fakeCtx('/api/kanban')
    expect(await tryHandleCosts(ctx)).toBe(false)
  })

  // Review blocker (Szotasz, PR #524): "the GET endpoint performs writes". Proven with a
  // REAL fixed cost configured (not the empty default), so there is something a buggy
  // sync-on-GET would actually have inserted -- an empty-config test wouldn't distinguish
  // "no write call" from "nothing to write".
  describe('GET /api/costs/summary is read-only (review blocker regression)', () => {
    const hadConfig = existsSync(COSTOPS_CONFIG_PATH)
    beforeEach(() => {
      mkdirSync(dirname(COSTOPS_CONFIG_PATH), { recursive: true })
      writeFileSync(COSTOPS_CONFIG_PATH, JSON.stringify({
        version: 1, currency: 'HUF',
        fixed_costs: [{ source_id: 'anthropic-max', name: 'Claude Max', provider: 'anthropic', source_type: 'subscription', amount: 22000 }],
        budgets: [],
      }))
    })
    afterEach(() => { if (!hadConfig) { try { unlinkSync(COSTOPS_CONFIG_PATH) } catch { /* already gone */ } } })

    it('never inserts into cost_line_items/cost_sources, even with a real fixed cost configured', async () => {
      const { ctx } = fakeCtx('/api/costs/summary')
      expect(await tryHandleCosts(ctx)).toBe(true)
      expect(await tryHandleCosts(ctx)).toBe(true) // twice, to also rule out a one-shot lazy-write pattern
      const items = (getDb().prepare('SELECT COUNT(*) as n FROM cost_line_items').get() as { n: number }).n
      const sources = (getDb().prepare('SELECT COUNT(*) as n FROM cost_sources').get() as { n: number }).n
      expect(items).toBe(0)
      expect(sources).toBe(0)
    })

    it('startCostsSyncTask() is where the write actually happens, and it works', () => {
      startCostsSyncTask(24 * 60 * 60 * 1000) // long interval -- test only needs the immediate one-shot run
      const row = getDb().prepare("SELECT billed_cost FROM cost_line_items WHERE source_id='anthropic-max'").get() as { billed_cost: number } | undefined
      expect(row?.billed_cost).toBe(22000)
    })
  })

  describe('POST /api/costs/usage', () => {
    it('records a valid usage charge and returns 200 with dedup info', async () => {
      const { ctx, out } = fakeCtx('/api/costs/usage', 'POST', JSON.stringify({
        provider: 'fal.ai', billed_cost: 8, service_name: 'flux-pro', agent: 'iris', ref: 'gen-1',
      }))
      expect(await tryHandleCosts(ctx)).toBe(true)
      expect(out.status).toBe(200)
      expect(out.body.ok).toBe(true)
      expect(out.body.source_id).toBe('usage:fal.ai')
      expect(out.body.deduped).toBe(false)
      const n = (getDb().prepare("SELECT COUNT(*) c FROM cost_line_items WHERE charge_category='usage'").get() as any).c
      expect(n).toBe(1)
    })

    it('is idempotent: re-posting the same ref returns deduped=true and does not double-count', async () => {
      const payload = JSON.stringify({ provider: 'fal.ai', billed_cost: 8, ref: 'gen-x' })
      const a = fakeCtx('/api/costs/usage', 'POST', payload)
      await tryHandleCosts(a.ctx)
      expect(a.out.body.deduped).toBe(false)
      const b = fakeCtx('/api/costs/usage', 'POST', payload)
      await tryHandleCosts(b.ctx)
      expect(b.out.body.deduped).toBe(true)
      const n = (getDb().prepare("SELECT COUNT(*) c FROM cost_line_items").get() as any).c
      expect(n).toBe(1)
    })

    it('rejects malformed JSON with 400', async () => {
      const { ctx, out } = fakeCtx('/api/costs/usage', 'POST', '{not json')
      expect(await tryHandleCosts(ctx)).toBe(true)
      expect(out.status).toBe(400)
    })

    it('rejects a missing provider with 400', async () => {
      const { ctx, out } = fakeCtx('/api/costs/usage', 'POST', JSON.stringify({ billed_cost: 5 }))
      await tryHandleCosts(ctx)
      expect(out.status).toBe(400)
    })

    it('rejects a negative billed_cost with 400', async () => {
      const { ctx, out } = fakeCtx('/api/costs/usage', 'POST', JSON.stringify({ provider: 'fal.ai', billed_cost: -3 }))
      await tryHandleCosts(ctx)
      expect(out.status).toBe(400)
    })

    it('rejects an omitted billed_cost with 400 when no price is configured', async () => {
      // default (no config file) -> empty pricing table -> cannot estimate
      const { ctx, out } = fakeCtx('/api/costs/usage', 'POST', JSON.stringify({ provider: 'fal.ai', service_name: 'fal-ai/flux-pro/kontext' }))
      await tryHandleCosts(ctx)
      expect(out.status).toBe(400)
      expect(String(out.body.error)).toContain('no price configured')
    })
  })

  // Estimate mode + budget gate need a real config with a pricing table.
  describe('priced config (estimate + budget-check)', () => {
    const hadConfig = existsSync(COSTOPS_CONFIG_PATH)
    beforeEach(() => {
      mkdirSync(dirname(COSTOPS_CONFIG_PATH), { recursive: true })
      writeFileSync(COSTOPS_CONFIG_PATH, JSON.stringify({
        version: 1, currency: 'HUF', fixed_costs: [], budgets: [],
        circuit_breaker: { currency: 'USD', daily_cap: 5, project_cap: 20, max_retries: 2, systematic_threshold: 2 },
        pricing: [
          { provider: 'fal.ai', model: 'fal-ai/flux-pro/kontext', unit_price: 0.04, unit: 'image', currency: 'USD' },
        ],
      }))
    })
    afterEach(() => { if (!hadConfig) { try { unlinkSync(COSTOPS_CONFIG_PATH) } catch { /* already gone */ } } })

    it('POST /api/costs/usage derives billed_cost from the price table when omitted', async () => {
      const { ctx, out } = fakeCtx('/api/costs/usage', 'POST', JSON.stringify({
        provider: 'fal.ai', service_name: 'fal-ai/flux-pro/kontext', consumed_quantity: 3, agent: 'iris', project: 'zoe', ref: 'gen-est-1',
      }))
      expect(await tryHandleCosts(ctx)).toBe(true)
      expect(out.status).toBe(200)
      expect(out.body.estimated).toBe(true)
      expect(out.body.billed_cost).toBeCloseTo(0.12)   // 0.04 * 3
      const row = getDb().prepare("SELECT billed_cost, confidence, currency FROM cost_line_items WHERE dedup_key='usage|fal.ai|gen-est-1'").get() as any
      expect(row.billed_cost).toBeCloseTo(0.12)
      expect(row.confidence).toBe('estimate')
      expect(row.currency).toBe('USD')
    })

    it('an explicit billed_cost still takes precedence over the price table', async () => {
      const { ctx, out } = fakeCtx('/api/costs/usage', 'POST', JSON.stringify({
        provider: 'fal.ai', service_name: 'fal-ai/flux-pro/kontext', billed_cost: 9.99, ref: 'gen-explicit',
      }))
      await tryHandleCosts(ctx)
      expect(out.body.estimated).toBe(false)
      expect(out.body.billed_cost).toBe(9.99)
    })

    it('GET /api/costs/budget-check returns allow with no spend yet', async () => {
      const { ctx, out } = fakeCtx('/api/costs/budget-check?project=zoe')
      expect(await tryHandleCosts(ctx)).toBe(true)
      expect(out.status).toBe(200)
      expect(out.body.action).toBe('allow')
      expect(out.body.daily_spend).toBe(0)
      expect(out.body.currency).toBe('USD')
    })

    it('GET /api/costs/budget-check pre-flight estimates a pending charge', async () => {
      const { ctx, out } = fakeCtx('/api/costs/budget-check?project=zoe&provider=fal.ai&model=fal-ai/flux-pro/kontext&quantity=2')
      await tryHandleCosts(ctx)
      expect(out.body.preflight.estimated_cost).toBeCloseTo(0.08)  // 0.04 * 2
      expect(out.body.preflight.would_exceed_daily).toBe(false)
    })

    it('GET /api/costs/budget-check hard_holds once the daily cap is reached', async () => {
      // record a USD usage charge that meets the daily_cap (5) for today
      const post = fakeCtx('/api/costs/usage', 'POST', JSON.stringify({
        provider: 'fal.ai', currency: 'USD', billed_cost: 5, ref: 'gen-cap',
      }))
      await tryHandleCosts(post.ctx)
      const { ctx, out } = fakeCtx('/api/costs/budget-check')
      await tryHandleCosts(ctx)
      expect(out.body.action).toBe('hard_hold')
      expect(String(out.body.reason)).toContain('daily cap reached')
    })
  })
})
