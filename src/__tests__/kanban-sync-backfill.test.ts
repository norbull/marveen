// Boot-time backfill reconcile for pre-sync kanban cards.
// Uses the real in-memory SQLite helpers and a mock ProjectsClient. No network.

import { setImmediate } from 'node:timers'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  initDatabase, createKanbanCard, updateKanbanCard,
  drainKanbanOutbox,
  setKanbanSyncSuppressed, upsertKanbanSyncState,
} from '../db.js'
import {
  backfillForwardOutbox, startKanbanProjectsSync, stopKanbanProjectsSync,
  type ProjectsClient, type RemoteItem, type SyncFields,
} from '../kanban-projects-sync.js'

class MockProjects implements ProjectsClient {
  upserts: SyncFields[] = []
  async listItems(): Promise<RemoteItem[]> { return [] }
  async upsertItem(fields: SyncFields, _itemId: string | null): Promise<{ itemId: string; updatedAt: number }> {
    this.upserts.push(fields)
    return { itemId: `PVTI_${this.upserts.length}`, updatedAt: 1000 + this.upserts.length }
  }
  async deleteItem(_itemId: string): Promise<void> {}
}

const flushImmediateTick = () => new Promise<void>((resolve) => setImmediate(resolve))

function seedPreSyncCard(id: string, title: string): void {
  setKanbanSyncSuppressed(true)
  try {
    createKanbanCard({ id, title })
  } finally {
    setKanbanSyncSuppressed(false)
  }
}

beforeEach(() => {
  initDatabase(':memory:')
  setKanbanSyncSuppressed(false)
})

afterEach(() => {
  stopKanbanProjectsSync()
  setKanbanSyncSuppressed(false)
})

describe('kanban sync boot-time backfill reconcile', () => {
  it('enqueues exactly the unsynced non-archived cards', () => {
    seedPreSyncCard('unsynced', 'Unsynced')
    seedPreSyncCard('archived', 'Archived')
    setKanbanSyncSuppressed(true)
    updateKanbanCard('archived', { archived_at: 123 })
    setKanbanSyncSuppressed(false)
    seedPreSyncCard('synced', 'Synced')
    upsertKanbanSyncState({
      card_id: 'synced', item_id: 'PVTI_synced', last_synced_hash: 'h',
      local_updated_at: 1, remote_updated_at: 1, synced_at: 1,
    })

    expect(backfillForwardOutbox()).toBe(1)
    expect(drainKanbanOutbox().map(r => ({ card_id: r.card_id, op: r.op }))).toEqual([
      { card_id: 'unsynced', op: 'upsert' },
    ])
  })

  it('second run enqueues nothing, including pending-outbox and sync-state variants', () => {
    seedPreSyncCard('needs-backfill', 'Needs backfill')
    createKanbanCard({ id: 'already-pending', title: 'Already pending' })
    seedPreSyncCard('already-synced', 'Already synced')
    upsertKanbanSyncState({
      card_id: 'already-synced', item_id: 'PVTI_synced', last_synced_hash: 'h',
      local_updated_at: 1, remote_updated_at: 1, synced_at: 1,
    })

    expect(backfillForwardOutbox()).toBe(1)
    expect(backfillForwardOutbox()).toBe(0)
    expect(drainKanbanOutbox().map(r => r.card_id).sort()).toEqual([
      'already-pending',
      'needs-backfill',
    ])
  })

  it('feature flag off performs no enqueue', () => {
    seedPreSyncCard('preexisting', 'Pre-existing')

    startKanbanProjectsSync({ client: null })

    expect(drainKanbanOutbox()).toHaveLength(0)
  })

  it('boot backfills before the first consumer tick', async () => {
    seedPreSyncCard('preexisting', 'Pre-existing')
    const mock = new MockProjects()

    startKanbanProjectsSync({ client: mock, pollMs: 60_000 })
    await flushImmediateTick()

    expect(mock.upserts.map(f => f.title)).toEqual(['Pre-existing'])
    expect(drainKanbanOutbox()).toHaveLength(0)
  })
})
