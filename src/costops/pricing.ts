// CostOps -- provider price table + usage-cost estimator.
//
// Paid generation providers (fal.ai image/video, Kling, Seedance, ...) do NOT
// return a cost in their API response -- verified against @fal-ai/client 1.10.1:
// its response types carry no cost/billed/price/amount field (the price/cost
// mentions there are all request-side *input* parameters). So the per-event
// ledger writer needs a way to DERIVE the charge from what the caller does know:
// the provider, the model, and how much was consumed (images, seconds, calls).
//
// This module is that derivation, and nothing more. It is PURE arithmetic + a
// lookup: no LLM, no network, no secrets. Prices are NOT hard-coded here -- they
// live in the same gitignored local config (store/costops-config.json, a
// `pricing` block) as the operator's other real amounts, so a stale price
// snapshot can never silently enter a tracked file or produce wrong cost data
// baked into the repo. With no price configured for a (provider, model) the
// estimator returns null and the caller must supply an explicit billed_cost --
// it never fabricates a number, matching the rest of the CostOps slice.

import type { PriceEntry } from './config.js'

export interface UsageEstimate {
  billed_cost: number     // unit_price * quantity, in `currency`
  unit_price: number      // price per unit, from the matched entry
  unit: string            // 'image' | 'second' | 'call' | ... (matched entry's)
  currency: string        // matched entry's currency
  matched_model: string   // the config model pattern that matched (for audit)
}

export interface EstimateInput {
  provider: string
  model?: string
  quantity?: number       // defaults to 1
}

function norm(s: string): string {
  return s.trim().toLowerCase()
}

/**
 * Find the best price entry for a (provider, model). Provider must match exactly
 * (case-insensitively). Model matches by, in priority order: exact match, then
 * the LONGEST configured model that is a prefix of the requested model (so a
 * specific `fal-ai/flux-pro/kontext` entry wins over a broad `fal-ai/flux-pro`
 * one, and a family entry still catches unlisted sub-variants). An entry with an
 * empty/absent model is a provider-wide fallback (lowest priority). Returns null
 * when nothing matches -- the caller then requires an explicit billed_cost.
 */
export function findPrice(pricing: PriceEntry[], provider: string, model?: string): PriceEntry | null {
  const p = norm(provider)
  const m = model ? norm(model) : ''
  let best: PriceEntry | null = null
  let bestLen = -1
  for (const e of pricing) {
    if (norm(e.provider) !== p) continue
    const em = e.model ? norm(e.model) : ''
    let score: number
    if (em === '') {
      score = 0                       // provider-wide fallback
    } else if (em === m) {
      score = em.length + 1_000_000   // exact match always wins
    } else if (m && m.startsWith(em)) {
      score = em.length               // longest prefix wins among prefixes
    } else {
      continue                        // configured model is unrelated
    }
    if (score > bestLen) { bestLen = score; best = e }
  }
  return best
}

/**
 * Estimate the cost of one paid usage event from the configured price table.
 * Returns null when the (provider, model) is not priced -- never a guessed
 * number. `quantity` defaults to 1 and must be a finite number >= 0.
 */
export function estimateUsageCost(pricing: PriceEntry[], input: EstimateInput): UsageEstimate | null {
  const entry = findPrice(pricing, input.provider, input.model)
  if (!entry) return null
  const quantity = input.quantity === undefined ? 1 : input.quantity
  if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity < 0) return null
  const billed_cost = round4(entry.unit_price * quantity)
  return {
    billed_cost,
    unit_price: entry.unit_price,
    unit: entry.unit ?? 'call',
    currency: entry.currency ?? 'USD',
    matched_model: entry.model ?? '*',
  }
}

function round4(n: number): number { return Math.round(n * 10000) / 10000 }
