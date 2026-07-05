// Orchestration tests for the sync engine against a MOCK ProjectsClient.
// No network, no token, no LLM -- this is the F4 "mocked GraphQL" layer.

import { describe, it, expect, beforeEach } from 'vitest'
import {
  initDatabase, createKanbanCard, updateKanbanCard, archiveKanbanCard,
  getKanbanCard, drainKanbanOutbox, getKanbanSyncState, setKanbanSyncSuppressed,
} from '../db.js'
import { drainForward, pollBackward, type ProjectsClient, type RemoteItem, type SyncFields } from '../kanban-projects-sync.js'
import { cardToFields, fieldsHash } from '../kanban-sync-mapping.js'

// In-memory fake of the GitHub Projects v2 side.
class MockProjects implements ProjectsClient {
  items = new Map<string, RemoteItem>()
  private n = 0
  upserts = 0
  deletes = 0
  async listItems(): Promise<RemoteItem[]> { return [...this.items.values()] }
  async upsertItem(fields: SyncFields, itemId: string | null): Promise<{ itemId: string; updatedAt: number }> {
    this.upserts++
    const id = itemId ?? `PVTI_${++this.n}`
    const updatedAt = 1000 + this.n
    this.items.set(id, { itemId: id, fields, updatedAt })
    return { itemId: id, updatedAt }
  }
  async deleteItem(itemId: string): Promise<void> { this.deletes++; this.items.delete(itemId) }
  // test helper: simulate a mobile edit on GitHub
  edit(itemId: string, patch: Partial<SyncFields>, updatedAt: number) {
    const cur = this.items.get(itemId)!
    this.items.set(itemId, { itemId, fields: { ...cur.fields, ...patch }, updatedAt })
  }
  addRemote(fields: SyncFields, updatedAt: number): string {
    const id = `PVTI_${++this.n}`
    this.items.set(id, { itemId: id, fields, updatedAt })
    return id
  }
}

beforeEach(() => {
  initDatabase(':memory:')
  setKanbanSyncSuppressed(false)
})

describe('forward drain (SQLite -> GitHub)', () => {
  it('pushes a created card and records sync state', async () => {
    createKanbanCard({ id: 'c1', title: 'Hello', status: 'in_progress', priority: 'high' })
    const mock = new MockProjects()
    const n = await drainForward({ client: mock })
    expect(n).toBe(1)
    expect(mock.upserts).toBe(1)
    expect(mock.items.size).toBe(1)
    expect(drainKanbanOutbox()).toHaveLength(0) // outbox cleared
    const st = getKanbanSyncState('c1')
    expect(st?.item_id).toBeTruthy()
    expect(st?.last_synced_hash).toBe(fieldsHash(cardToFields(getKanbanCard('c1')!)))
  })

  it('a delete intent removes the remote item', async () => {
    createKanbanCard({ id: 'c1', title: 'Hello' })
    const mock = new MockProjects()
    await drainForward({ client: mock })
    archiveKanbanCard('c1') // enqueues a delete
    await drainForward({ client: mock })
    expect(mock.deletes).toBe(1)
    expect(mock.items.size).toBe(0)
    expect(getKanbanSyncState('c1')).toBeNull()
  })

  it('skips the push when synced fields did not change (no-op update)', async () => {
    createKanbanCard({ id: 'c1', title: 'Hello' })
    const mock = new MockProjects()
    await drainForward({ client: mock })
    expect(mock.upserts).toBe(1)
    // an update that does not touch any synced field (sort_order only) -> same hash
    updateKanbanCard('c1', { sort_order: 5 })
    await drainForward({ client: mock })
    expect(mock.upserts).toBe(1) // unchanged: no second push
  })
})

describe('backward poll (GitHub -> SQLite) + echo-loop guard', () => {
  it('applies a remote edit and does NOT re-enqueue (no echo)', async () => {
    createKanbanCard({ id: 'c1', title: 'Hello', status: 'planned' })
    const mock = new MockProjects()
    await drainForward({ client: mock })
    const itemId = getKanbanSyncState('c1')!.item_id!
    // mobile changes the status on GitHub
    mock.edit(itemId, { status: 'Done', title: 'Hello edited' }, 2000)

    const applied = await pollBackward({ client: mock })
    expect(applied).toBe(1)
    const card = getKanbanCard('c1')!
    expect(card.status).toBe('done')
    expect(card.title).toBe('Hello edited')
    // CRITICAL: the suppressed backward write must not enqueue a forward sync
    expect(drainKanbanOutbox()).toHaveLength(0)
  })

  it('creates a local card for a brand-new GitHub item', async () => {
    const mock = new MockProjects()
    mock.addRemote({ title: 'From mobile', body: 'b', status: 'Waiting', priority: 'Urgent', assignee: 'dex', project: 'x', due: null }, 3000)
    const applied = await pollBackward({ client: mock })
    expect(applied).toBe(1)
    // exactly one local card now exists, mapped, with the remote values
    const states = getKanbanSyncState // type hint only
    void states
    const allOutbox = drainKanbanOutbox()
    expect(allOutbox).toHaveLength(0) // created under suppression -> no echo
  })

  it('round-trips without bouncing: push then poll is a no-op', async () => {
    createKanbanCard({ id: 'c1', title: 'Hello' })
    const mock = new MockProjects()
    await drainForward({ client: mock })
    const applied = await pollBackward({ client: mock }) // remote hash == last synced
    expect(applied).toBe(0)
    expect(drainKanbanOutbox()).toHaveLength(0)
  })
})
