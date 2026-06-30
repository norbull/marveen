// Kanban <-> GitHub Projects v2 two-way sync engine.
//
// CONSTRAINT (Norbi): deterministic, ZERO runtime LLM tokens. This is plain
// code -- a poll loop + a transactional outbox drain. It never calls an agent.
//
// Layering:
//   - kanban-sync-mapping.ts : pure field <-> field transforms (no I/O).
//   - db.ts kanban_sync_*     : the outbox + per-card sync state (SQLite).
//   - THIS module             : the orchestration (forward drain + backward poll)
//                               against a ProjectsClient.
//   - ProjectsClient (live)   : the GraphQL impl. Built at boot from a vault
//                               token with `project` scope (F1). Injected here
//                               so the orchestration is unit-testable with a mock.
//
// Feature-flag: with no token / no project id configured the engine is a no-op
// (logs a one-line hint and never starts the loop) -- safe to ship dark.

import {
  drainKanbanOutbox, deleteKanbanOutboxRow,
  getKanbanCard, createKanbanCard, updateKanbanCard,
  getKanbanSyncState, upsertKanbanSyncState, deleteKanbanSyncState, listKanbanSyncStates,
  setKanbanSyncSuppressed,
  type KanbanCard,
} from './db.js'
import { cardToFields, fieldsToCardUpdate, fieldsHash, type SyncFields } from './kanban-sync-mapping.js'
import { logger } from './logger.js'

// A Project item as the client surfaces it to the engine. `fields` are the
// canonical (human-label) values; the client maps option-IDs <-> labels.
export interface RemoteItem {
  itemId: string
  fields: SyncFields
  updatedAt: number // epoch seconds (parsed from the GraphQL ISO updatedAt)
}

// The GraphQL boundary. The live implementation (F1) talks to
// api.github.com/graphql; tests inject a mock. Every method is deterministic
// from the engine's point of view -- no LLM anywhere.
export interface ProjectsClient {
  listItems(): Promise<RemoteItem[]>
  upsertItem(fields: SyncFields, itemId: string | null): Promise<{ itemId: string; updatedAt: number }>
  deleteItem(itemId: string): Promise<void>
}

export interface KanbanSyncDeps {
  client: ProjectsClient
  now?: () => number // injectable clock for tests (default: epoch seconds)
}

const nowSec = () => Math.floor(Date.now() / 1000)

// --- forward: SQLite -> GitHub (drain the outbox) ---

export async function drainForward(deps: KanbanSyncDeps): Promise<number> {
  const { client } = deps
  const now = deps.now ?? nowSec
  let processed = 0
  for (const row of drainKanbanOutbox()) {
    try {
      const state = getKanbanSyncState(row.card_id)
      if (row.op === 'delete') {
        if (state?.item_id) await client.deleteItem(state.item_id)
        deleteKanbanSyncState(row.card_id)
      } else {
        const card = getKanbanCard(row.card_id)
        // upsert intent but the card is gone/archived -> treat as a delete
        if (!card || card.archived_at) {
          if (state?.item_id) await client.deleteItem(state.item_id)
          deleteKanbanSyncState(row.card_id)
        } else {
          const fields = cardToFields(card)
          const hash = fieldsHash(fields)
          if (state && state.last_synced_hash === hash) {
            // already in sync (e.g. a no-op update) -- just drop the outbox row
          } else {
            const res = await client.upsertItem(fields, state?.item_id ?? null)
            upsertKanbanSyncState({
              card_id: row.card_id,
              item_id: res.itemId,
              last_synced_hash: hash,
              local_updated_at: card.updated_at,
              remote_updated_at: res.updatedAt,
              synced_at: now(),
            })
          }
        }
      }
      deleteKanbanOutboxRow(row.seq)
      processed++
    } catch (err) {
      // Leave the row in the outbox for the next tick (at-least-once delivery).
      logger.warn({ err, card_id: row.card_id, op: row.op }, 'kanban-sync: forward row failed, will retry')
      break // preserve ordering; stop this tick on first failure
    }
  }
  return processed
}

// --- backward: GitHub -> SQLite (poll the Project) ---

export async function pollBackward(deps: KanbanSyncDeps): Promise<number> {
  const { client } = deps
  const now = deps.now ?? nowSec
  const items = await client.listItems()
  const byItemId = new Map(listKanbanSyncStates().filter(s => s.item_id).map(s => [s.item_id as string, s]))
  let applied = 0

  for (const item of items) {
    const hash = fieldsHash(item.fields)
    const state = byItemId.get(item.itemId)

    if (!state) {
      // New item created on GitHub (mobile) with no local mapping yet -> create
      // a local card. New id is derived deterministically from the item id.
      const cardId = newCardIdFromItem(item.itemId)
      const upd = fieldsToCardUpdate(item.fields)
      withSuppressed(() => {
        createKanbanCard({
          id: cardId, title: upd.title, description: upd.description ?? undefined,
          status: upd.status, priority: upd.priority,
          assignee: upd.assignee ?? undefined, project: upd.project ?? undefined,
          due_date: upd.due_date ?? undefined,
        })
      })
      upsertKanbanSyncState({
        card_id: cardId, item_id: item.itemId, last_synced_hash: hash,
        local_updated_at: now(), remote_updated_at: item.updatedAt, synced_at: now(),
      })
      applied++
      continue
    }

    if (state.last_synced_hash === hash) continue // remote unchanged since last sync

    // Remote changed. V1 = last-write-wins; the poll only fires when the remote
    // fingerprint moved, so apply it. (Field-level merge is V2.) The suppress
    // flag stops this write from re-enqueueing an outbox row -> no echo.
    withSuppressed(() => updateKanbanCard(state.card_id, fieldsToCardUpdate(item.fields)))
    upsertKanbanSyncState({
      card_id: state.card_id, item_id: item.itemId, last_synced_hash: hash,
      local_updated_at: now(), remote_updated_at: item.updatedAt, synced_at: now(),
    })
    applied++
  }
  return applied
}

function withSuppressed(fn: () => void): void {
  setKanbanSyncSuppressed(true)
  try { fn() } finally { setKanbanSyncSuppressed(false) }
}

// Deterministic local id for a GitHub-originated card. 8-hex like the dashboard
// ids, derived from the stable Project item id so re-polls never duplicate.
import { createHash } from 'node:crypto'
function newCardIdFromItem(itemId: string): string {
  return createHash('sha256').update(itemId).digest('hex').slice(0, 8)
}

// --- lifecycle (boot/stop), feature-flagged ---

let timer: ReturnType<typeof setInterval> | null = null

export interface KanbanSyncBootConfig {
  client: ProjectsClient | null // null when not configured (no token / no project)
  pollMs?: number
}

export function startKanbanProjectsSync(cfg: KanbanSyncBootConfig): void {
  if (!cfg.client) {
    logger.info('kanban-sync: no Projects client (missing project-scope token or project id) -- sync disabled')
    return
  }
  const pollMs = cfg.pollMs ?? 45_000
  const deps: KanbanSyncDeps = { client: cfg.client }
  let running = false
  timer = setInterval(async () => {
    if (running) return // never overlap ticks
    running = true
    try {
      await drainForward(deps)
      await pollBackward(deps)
    } catch (err) {
      logger.warn({ err }, 'kanban-sync: tick failed')
    } finally {
      running = false
    }
  }, pollMs)
  logger.info({ pollMs }, 'kanban-sync: started')
}

export function stopKanbanProjectsSync(): void {
  if (timer) { clearInterval(timer); timer = null }
}

// Re-export for the (future) live client + index boot wiring.
export type { KanbanCard }
export type { SyncFields }
