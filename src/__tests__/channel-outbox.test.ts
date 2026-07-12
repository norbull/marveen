import { describe, it, expect } from 'vitest'
import { isExpired, decideAfterSendError, MAX_ATTEMPTS, TTL_MS } from '../channel-outbox.js'

const NOW = 1_700_000_000_000 // fixed ms; Date.now() is banned in tests anyway

describe('channel-outbox TTL (isExpired)', () => {
  it('keeps a fresh row', () => {
    expect(isExpired(Math.floor(NOW / 1000), NOW)).toBe(false)
  })

  it('expires a row older than the TTL window', () => {
    const created = Math.floor((NOW - TTL_MS - 1000) / 1000)
    expect(isExpired(created, NOW)).toBe(true)
  })

  it('keeps a row exactly at the boundary (strict >, not >=)', () => {
    const created = Math.floor((NOW - TTL_MS) / 1000)
    expect(isExpired(created, NOW)).toBe(false)
  })
})

describe('channel-outbox send-error decision (decideAfterSendError)', () => {
  it('drops permanently on a 4xx that is not 429 -- retry cannot help', () => {
    expect(decideAfterSendError('Telegram API 403', 1)).toBe('drop-permanent')
    expect(decideAfterSendError('Telegram API 400', 3)).toBe('drop-permanent')
  })

  it('retries a transient error below the attempt cap', () => {
    expect(decideAfterSendError('Telegram API 429', 1)).toBe('retry')
    expect(decideAfterSendError('Telegram API 500', 2)).toBe('retry')
    expect(decideAfterSendError('network timeout', 1)).toBe('retry') // no status -> transient
  })

  it('drops once transient failures reach MAX_ATTEMPTS', () => {
    expect(decideAfterSendError('Telegram API 500', MAX_ATTEMPTS)).toBe('drop-max')
    expect(decideAfterSendError('Telegram API 429', MAX_ATTEMPTS + 1)).toBe('drop-max')
  })
})
