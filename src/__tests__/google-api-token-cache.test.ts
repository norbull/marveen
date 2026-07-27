import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Contract tests for the 2026-06-02 14:30 hb regression after Calendar
// re-auth. Symptom: Szabi re-authed at 16:26 (live HTTP 200 verified), but
// the heartbeat kept logging `Google token refresh failed` because the
// module-level token cache still held the pre-re-auth (88-day expired,
// revoked) refresh_token. Manual restart fixed the immediate symptom; the
// mtime-invalidating cache fixes it so out-of-process re-auths propagate.
//
// 2026-07-26: the token-cache/refresh logic was extracted from google-api.ts
// into the shared google-auth.ts (so gmail-api.ts reuses the same headless
// flow) and moved to the store/ dir with a flat token schema. These contract
// tests now guard google-auth.ts -- the regression protection is unchanged,
// only its location and the constant names (TOKEN_PATH, loadToken/saveToken).

const SRC = readFileSync(join(__dirname, '../google-auth.ts'), 'utf-8')

describe('google-auth token cache mtime invalidation', () => {
  it('cache entry carries the file mtime alongside the parsed payload', () => {
    // Without mtimeMs in the cache shape, no way to tell when the file
    // on disk has been rewritten by an out-of-process re-auth.
    expect(SRC).toMatch(/cachedToken:\s*\{[^}]*mtimeMs:\s*number/s)
  })

  it('loadToken re-reads when the file mtime advances', () => {
    const start = SRC.indexOf('function loadToken')
    expect(start).toBeGreaterThan(0)
    const closeIdx = SRC.indexOf('\n}\n', start)
    const body = SRC.slice(start, closeIdx)
    expect(body).toMatch(/statSync\(TOKEN_PATH\)/)
    expect(body).toMatch(/cachedToken\.mtimeMs !==/)
  })

  it('saveToken populates the cache with a matching mtime (no double-read)', () => {
    // After a write, the next loadToken() should NOT need to re-read the
    // file (the in-memory copy is the truth). Track the post-write mtime
    // so cachedToken.mtimeMs matches the file's mtime on the next check.
    const start = SRC.indexOf('function saveToken')
    const closeIdx = SRC.indexOf('\n}\n', start)
    const body = SRC.slice(start, closeIdx)
    expect(body).toMatch(/statSync\(TOKEN_PATH\)/)
    expect(body).toMatch(/cachedToken\s*=\s*\{[^}]*mtimeMs/s)
  })

  it('saveToken writes the flat TokenData JSON with 0600 mode (no cache-mtime leak, secret perms)', () => {
    // The store token is flat TokenData (no { normal } MCP wrapper). The cache
    // layer must not leak its internal mtimeMs into the on-disk JSON, and the
    // file must be written 0600 (it holds the refresh_token).
    const start = SRC.indexOf('function saveToken')
    const closeIdx = SRC.indexOf('\n}\n', start)
    const body = SRC.slice(start, closeIdx)
    expect(body).toMatch(/writeFileSync\([^)]*JSON\.stringify\(data/)
    expect(body).toMatch(/mode:\s*0o600/)
  })

  it('handles a missing TOKEN_PATH at stat time without throwing', () => {
    // statSync throws on missing file. The cache check must be wrapped in
    // try/catch so loadToken can still surface the readFileSync error
    // explicitly (current behaviour) rather than being short-circuited by
    // the stat.
    const start = SRC.indexOf('function loadToken')
    const closeIdx = SRC.indexOf('\n}\n', start)
    const body = SRC.slice(start, closeIdx)
    expect(body).toMatch(/try\s*\{\s*[^}]*statSync\(TOKEN_PATH\)/s)
    expect(body).toMatch(/catch\s*\{\s*\/\*/)
  })
})
