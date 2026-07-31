import https from 'node:https'
import { readFileSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from './logger.js'
import { TOOL_TIMEOUTS } from './tool-timeouts.js'

// Shared headless Google OAuth (refresh-token flow) for the background service.
// Both the Calendar helper (google-api.ts) and the Gmail helper (gmail-api.ts)
// pull their access token through here so there is a single token source.
//
// Storage: the store/ dir (gitignored, chmod 600), consistent with the other
// service secrets (.dashboard-token, .openrouter-api-key, ...). The token and
// client are NEVER logged.
//
// Token file  : store/.google-oauth-token.json   -> flat TokenData (see below)
// Client file : store/.google-oauth-client.json  -> Google "Desktop app" client JSON
//               ({ "installed": { client_id, client_secret, token_uri } })
//
// The files are written once by the OAuth consent helper (offline access,
// scopes: gmail.readonly + gmail.send + calendar.readonly) and refreshed here.

const STORE_DIR = join(process.cwd(), 'store')
const TOKEN_PATH = process.env.GOOGLE_OAUTH_TOKEN_PATH ?? join(STORE_DIR, '.google-oauth-token.json')
const CLIENT_PATH = process.env.GOOGLE_OAUTH_CLIENT_PATH ?? join(STORE_DIR, '.google-oauth-client.json')

export interface TokenData {
  access_token: string
  refresh_token: string
  expiry_date: number
  token_type?: string
  scope?: string
}

interface ClientCredentials {
  installed: {
    client_id: string
    client_secret: string
    token_uri?: string
  }
}

// Token cache with mtime-invalidation: spares a JSON parse per call, but a
// stale cache would keep using a revoked refresh_token after an out-of-process
// re-auth. Re-read whenever the file's mtime advances (same guard as the
// original google-api.ts, ported here 2026-07-26).
let cachedToken: { data: TokenData; mtimeMs: number } | null = null
let cachedClient: ClientCredentials | null = null

function loadToken(): TokenData {
  let mtime = 0
  try { mtime = statSync(TOKEN_PATH).mtimeMs } catch { /* missing -> readFileSync throws below */ }
  if (!cachedToken || cachedToken.mtimeMs !== mtime) {
    const parsed = JSON.parse(readFileSync(TOKEN_PATH, 'utf-8')) as TokenData
    cachedToken = { data: parsed, mtimeMs: mtime }
  }
  return cachedToken.data
}

function saveToken(data: TokenData): void {
  writeFileSync(TOKEN_PATH, JSON.stringify(data, null, 2), { mode: 0o600 })
  let mtimeMs = 0
  try { mtimeMs = statSync(TOKEN_PATH).mtimeMs } catch { /* unlikely right after write */ }
  cachedToken = { data, mtimeMs }
}

function loadClient(): ClientCredentials {
  if (!cachedClient) {
    cachedClient = JSON.parse(readFileSync(CLIENT_PATH, 'utf-8')) as ClientCredentials
  }
  return cachedClient
}

function httpsRequest(
  url: string,
  options: https.RequestOptions,
  body?: string,
  timeoutMs = TOOL_TIMEOUTS['google-calendar'],
): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, data: Buffer.concat(chunks).toString('utf-8') }))
      res.on('error', reject)
    })
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Google API request timed out after ${timeoutMs}ms`)))
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

async function refreshAccessToken(): Promise<string> {
  const token = loadToken()
  const client = loadClient()

  const params = new URLSearchParams({
    client_id: client.installed.client_id,
    client_secret: client.installed.client_secret,
    refresh_token: token.refresh_token,
    grant_type: 'refresh_token',
  })

  const { status, data } = await httpsRequest(
    'https://oauth2.googleapis.com/token',
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    params.toString(),
  )

  if (status !== 200) {
    // NB: never log `data` verbatim at info level -- it can echo token material.
    logger.error({ status }, 'Google token refresh failed')
    throw new Error(`Token refresh failed: ${status}`)
  }

  const refreshed = JSON.parse(data) as { access_token: string; expires_in: number }
  const updated: TokenData = {
    ...token,
    access_token: refreshed.access_token,
    expiry_date: Date.now() + refreshed.expires_in * 1000,
  }
  saveToken(updated)
  logger.info('Google access token refreshed')
  return updated.access_token
}

/** Returns a valid access token, refreshing if it expires within 5 minutes. */
export async function getValidAccessToken(): Promise<string> {
  const token = loadToken()
  if (Date.now() > token.expiry_date - 5 * 60 * 1000) {
    return refreshAccessToken()
  }
  return token.access_token
}

/** Force a refresh (used by callers on a mid-flight 401). */
export async function forceRefreshAccessToken(): Promise<string> {
  return refreshAccessToken()
}

export { httpsRequest }
