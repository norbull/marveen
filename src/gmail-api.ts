import { logger } from './logger.js'
import { getValidAccessToken, forceRefreshAccessToken, httpsRequest } from './google-auth.js'

// Headless Gmail helper (Gmail API v1) for the background service. Direct API
// over the shared refresh-token flow (google-auth.ts) -- the same proven path
// the Calendar helper uses, avoiding the fragile headless MCP connector.
//
// Scopes required: gmail.readonly (list/get) + gmail.send (send).
// Replaces the `search_emails` MCP tool the heartbeat/morning prompts assumed.

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'

export interface GmailSummary {
  id: string
  from: string
  subject: string
  date: string
  snippet: string
}

interface RawListResponse { messages?: Array<{ id: string; threadId: string }> }
interface RawHeader { name: string; value: string }
interface RawMessage { id: string; snippet?: string; payload?: { headers?: RawHeader[] } }

async function apiGet(path: string): Promise<{ status: number; data: string }> {
  const token = await getValidAccessToken()
  const url = `${GMAIL_BASE}${path}`
  const res = await httpsRequest(url, { method: 'GET', headers: { Authorization: `Bearer ${token}` } })
  if (res.status === 401) {
    // Token expired mid-flight: refresh once and retry.
    const fresh = await forceRefreshAccessToken()
    return httpsRequest(url, { method: 'GET', headers: { Authorization: `Bearer ${fresh}` } })
  }
  return res
}

function headerValue(headers: RawHeader[] | undefined, name: string): string {
  const h = headers?.find((x) => x.name.toLowerCase() === name.toLowerCase())
  return h?.value ?? ''
}

/**
 * List messages matching a Gmail search query (e.g. "is:unread newer_than:2h").
 * Returns lightweight summaries (from/subject/date/snippet), newest first.
 * Returns [] on any API error so the heartbeat never breaks on a mail hiccup.
 */
export async function listMessages(query: string, maxResults = 10): Promise<GmailSummary[]> {
  const params = new URLSearchParams({ q: query, maxResults: String(maxResults) })
  const list = await apiGet(`/messages?${params}`)
  if (list.status !== 200) {
    logger.error({ status: list.status }, 'Gmail list error')
    return []
  }
  const ids = (JSON.parse(list.data) as RawListResponse).messages ?? []

  const out: GmailSummary[] = []
  for (const { id } of ids) {
    const mp = new URLSearchParams({ format: 'metadata' })
    for (const h of ['From', 'Subject', 'Date']) mp.append('metadataHeaders', h)
    const msg = await apiGet(`/messages/${id}?${mp}`)
    if (msg.status !== 200) continue
    const m = JSON.parse(msg.data) as RawMessage
    out.push({
      id: m.id,
      from: headerValue(m.payload?.headers, 'From'),
      subject: headerValue(m.payload?.headers, 'Subject'),
      date: headerValue(m.payload?.headers, 'Date'),
      snippet: m.snippet ?? '',
    })
  }
  return out
}

/** Fetch a single message's metadata + snippet. Returns null on error. */
export async function getMessage(id: string): Promise<GmailSummary | null> {
  const mp = new URLSearchParams({ format: 'metadata' })
  for (const h of ['From', 'Subject', 'Date']) mp.append('metadataHeaders', h)
  const msg = await apiGet(`/messages/${encodeURIComponent(id)}?${mp}`)
  if (msg.status !== 200) {
    logger.error({ status: msg.status }, 'Gmail get error')
    return null
  }
  const m = JSON.parse(msg.data) as RawMessage
  return {
    id: m.id,
    from: headerValue(m.payload?.headers, 'From'),
    subject: headerValue(m.payload?.headers, 'Subject'),
    date: headerValue(m.payload?.headers, 'Date'),
    snippet: m.snippet ?? '',
  }
}

function buildRawEmail(to: string, subject: string, body: string): string {
  // RFC 2822, UTF-8. Subject encoded so accents survive (=?UTF-8?B?...?=).
  const encSubject = `=?UTF-8?B?${Buffer.from(subject, 'utf-8').toString('base64')}?=`
  const lines = [
    `To: ${to}`,
    `Subject: ${encSubject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(body, 'utf-8').toString('base64'),
  ]
  // base64url of the full RFC822 message (Gmail requires url-safe, no padding).
  return Buffer.from(lines.join('\r\n'), 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/**
 * Send a plain-text email as the authenticated user.
 * Returns the sent message id, or null on failure.
 */
export async function sendMessage(to: string, subject: string, body: string): Promise<string | null> {
  const raw = buildRawEmail(to, subject, body)
  const post = async (bearer: string) => httpsRequest(
    `${GMAIL_BASE}/messages/send`,
    { method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' } },
    JSON.stringify({ raw }),
  )

  let token = await getValidAccessToken()
  let res = await post(token)
  if (res.status === 401) {
    token = await forceRefreshAccessToken()
    res = await post(token)
  }
  if (res.status !== 200) {
    logger.error({ status: res.status }, 'Gmail send error')
    return null
  }
  const sent = JSON.parse(res.data) as { id?: string }
  logger.info({ id: sent.id }, 'Gmail message sent')
  return sent.id ?? null
}
