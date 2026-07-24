import { describe, it, expect } from 'vitest'
import { findPrice, estimateUsageCost } from '../costops/pricing.js'
import type { PriceEntry } from '../costops/config.js'

const TABLE: PriceEntry[] = [
  { provider: 'fal.ai', model: 'fal-ai/flux-pro/kontext', unit_price: 0.04, unit: 'image', currency: 'USD' },
  { provider: 'fal.ai', model: 'fal-ai/flux-pro', unit_price: 0.05, unit: 'image', currency: 'USD' },
  { provider: 'fal.ai', model: '', unit_price: 0.01, unit: 'image', currency: 'USD' },  // provider-wide fallback
  { provider: 'kling', model: 'kling-2.1', unit_price: 0.28, unit: 'second', currency: 'USD' },
]

describe('costops pricing -- findPrice', () => {
  it('picks the exact model over a shorter prefix', () => {
    const e = findPrice(TABLE, 'fal.ai', 'fal-ai/flux-pro/kontext')
    expect(e?.unit_price).toBe(0.04)
  })

  it('falls back to the longest prefix match for an unlisted sub-variant', () => {
    // no exact entry -> the 'fal-ai/flux-pro' family entry (a prefix) wins over the provider-wide one
    const e = findPrice(TABLE, 'fal.ai', 'fal-ai/flux-pro/ultra')
    expect(e?.unit_price).toBe(0.05)
  })

  it('uses the provider-wide fallback when no model matches', () => {
    const e = findPrice(TABLE, 'fal.ai', 'fal-ai/nano-banana-2')
    expect(e?.unit_price).toBe(0.01)
  })

  it('is case-insensitive on provider and model', () => {
    const e = findPrice(TABLE, 'FAL.AI', 'FAL-AI/FLUX-PRO/KONTEXT')
    expect(e?.unit_price).toBe(0.04)
  })

  it('returns null for an unpriced provider', () => {
    expect(findPrice(TABLE, 'openrouter', 'anthropic/claude')).toBeNull()
  })
})

describe('costops pricing -- estimateUsageCost', () => {
  it('multiplies unit_price by quantity', () => {
    const est = estimateUsageCost(TABLE, { provider: 'kling', model: 'kling-2.1', quantity: 5 })
    expect(est).not.toBeNull()
    expect(est!.billed_cost).toBe(1.4)   // 0.28 * 5
    expect(est!.unit).toBe('second')
    expect(est!.currency).toBe('USD')
    expect(est!.matched_model).toBe('kling-2.1')
  })

  it('defaults quantity to 1', () => {
    const est = estimateUsageCost(TABLE, { provider: 'fal.ai', model: 'fal-ai/flux-pro/kontext' })
    expect(est!.billed_cost).toBe(0.04)
  })

  it('returns null when nothing is priced (never fabricates)', () => {
    expect(estimateUsageCost([], { provider: 'fal.ai', model: 'x' })).toBeNull()
    expect(estimateUsageCost(TABLE, { provider: 'unknown' })).toBeNull()
  })

  it('rejects a negative or non-finite quantity', () => {
    expect(estimateUsageCost(TABLE, { provider: 'kling', model: 'kling-2.1', quantity: -1 })).toBeNull()
    expect(estimateUsageCost(TABLE, { provider: 'kling', model: 'kling-2.1', quantity: NaN })).toBeNull()
  })
})
