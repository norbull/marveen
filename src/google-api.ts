import { logger } from './logger.js'
import { getValidAccessToken, forceRefreshAccessToken, httpsRequest } from './google-auth.js'

// Calendar helper (Google Calendar API v3). Auth is shared with the Gmail
// helper via google-auth.ts (single refresh-token source in store/). The
// token/client-path + refresh logic used to live here; extracted 2026-07-26
// so gmail-api.ts can reuse the same proven headless flow.

interface CalendarEvent {
  id: string
  summary?: string
  start?: { dateTime?: string; date?: string }
  end?: { dateTime?: string; date?: string }
  status?: string
  location?: string
  description?: string
  attendees?: Array<{ email: string; responseStatus?: string; displayName?: string }>
}

interface CalendarListResponse {
  items?: CalendarEvent[]
}

export async function getCalendarEvents(
  calendarId: string,
  timeMin: Date,
  timeMax: Date,
): Promise<CalendarEvent[]> {
  const token = await getValidAccessToken()

  const params = new URLSearchParams({
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '20',
  })

  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`

  const { status, data } = await httpsRequest(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  })

  if (status === 401) {
    // Token expired mid-flight, refresh and retry once.
    const newToken = await forceRefreshAccessToken()
    const retry = await httpsRequest(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${newToken}` },
    })
    if (retry.status !== 200) {
      logger.error({ status: retry.status }, 'Google Calendar API error after refresh')
      return []
    }
    return (JSON.parse(retry.data) as CalendarListResponse).items ?? []
  }

  if (status !== 200) {
    logger.error({ status }, 'Google Calendar API error')
    return []
  }

  return (JSON.parse(data) as CalendarListResponse).items ?? []
}

export type { CalendarEvent }
