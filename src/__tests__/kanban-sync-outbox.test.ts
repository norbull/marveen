// Forward-path outbox + echo-loop suppress + sync-state contract tests.
// Exercises the real db.ts entry points on an in-memory DB. Zero network/token.

import { describe, it, expect, beforeEach } from 'vitest'
import {
  initDatabase, createKanbanCard, updateKanbanCard, moveKanbanCard,
  archiveKanbanCard, deleteKanbanCard,
  drainKanbanOutbox, deleteKanbanOutboxRow, setKanbanSyncSuppressed,
  getKanbanSyncState, upsertKanbanSyncState, listKanbanSyncStates, deleteKanbanSyncState,
} from '../db.js'

beforeEach(() => {
  initDatabase(':memory:')
  setKanbanSyncSuppressed(false)
})

describe('forward-path outbox enqueue', () => {
  it('createKanbanCard enqueues an upsert', () => {
    createKanbanCard({ id: 'c1', title: 'A' })
    const rows = drainKanbanOutbox()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ card_id: 'c1', op: 'upsert' })
  })

  it('updateKanbanCard enqueues an upsert only when a row changed', () => {
    createKanbanCard({ id: 'c1', title: 'A' })
    drainKanbanOutbox().forEach(r => deleteKanbanOutboxRow(r.seq)) // clear create event
    expect(updateKanbanCard('c1', { title: 'B' })).toBe(true)
    expect(drainKanbanOutbox().map(r => r.op)).toEqual(['upsert'])
    // updating a non-existent card changes nothing -> no enqueue
    expect(updateKanbanCard('nope', { title: 'X' })).toBe(false)
    expect(drainKanbanOutbox()).toHaveLength(1)
  })

  it('moveKanbanCard enqueues an upsert', () => {
    createKanbanCard({ id: 'c1', title: 'A' })
    drainKanbanOutbox().forEach(r => deleteKanbanOutboxRow(r.seq))
    moveKanbanCard('c1', 'done', 0)
    expect(drainKanbanOutbox().map(r => r.op)).toEqual(['upsert'])
  })

  it('archiveKanbanCard enqueues a delete (archive == remove on GitHub)', () => {
    createKanbanCard({ id: 'c1', title: 'A' })
    drainKanbanOutbox().forEach(r => deleteKanbanOutboxRow(r.seq))
    archiveKanbanCard('c1')
    expect(drainKanbanOutbox().map(r => r.op)).toEqual(['delete'])
  })

  it('deleteKanbanCard enqueues a delete (inside its transaction)', () => {
    createKanbanCard({ id: 'c1', title: 'A' })
    drainKanbanOutbox().forEach(r => deleteKanbanOutboxRow(r.seq))
    deleteKanbanCard('c1')
    expect(drainKanbanOutbox().map(r => r.op)).toEqual(['delete'])
  })
})

describe('echo-loop suppress', () => {
  it('no outbox rows are written while suppressed (backward-write guard)', () => {
    setKanbanSyncSuppressed(true)
    createKanbanCard({ id: 'c1', title: 'A' })
    updateKanbanCard('c1', { status: 'done' })
    moveKanbanCard('c1', 'waiting', 1)
    expect(drainKanbanOutbox()).toHaveLength(0)
  })
  it('resumes enqueueing once suppression is lifted', () => {
    setKanbanSyncSuppressed(true)
    createKanbanCard({ id: 'c1', title: 'A' })
    setKanbanSyncSuppressed(false)
    updateKanbanCard('c1', { title: 'B' })
    expect(drainKanbanOutbox().map(r => r.card_id)).toEqual(['c1'])
  })
})

describe('outbox drain ordering + removal', () => {
  it('drains in seq order and deletes processed rows', () => {
    createKanbanCard({ id: 'c1', title: 'A' })
    createKanbanCard({ id: 'c2', title: 'B' })
    const rows = drainKanbanOutbox()
    expect(rows.map(r => r.card_id)).toEqual(['c1', 'c2'])
    deleteKanbanOutboxRow(rows[0].seq)
    expect(drainKanbanOutbox().map(r => r.card_id)).toEqual(['c2'])
  })
})

describe('sync-state store', () => {
  it('upserts, reads back, and deletes', () => {
    upsertKanbanSyncState({
      card_id: 'c1', item_id: 'PVTI_x', last_synced_hash: 'abc',
      local_updated_at: 100, remote_updated_at: 90, synced_at: 110,
    })
    expect(getKanbanSyncState('c1')).toMatchObject({ item_id: 'PVTI_x', last_synced_hash: 'abc' })
    // conflict-update overwrites
    upsertKanbanSyncState({
      card_id: 'c1', item_id: 'PVTI_x', last_synced_hash: 'def',
      local_updated_at: 200, remote_updated_at: 190, synced_at: 210,
    })
    expect(getKanbanSyncState('c1')?.last_synced_hash).toBe('def')
    expect(listKanbanSyncStates()).toHaveLength(1)
    deleteKanbanSyncState('c1')
    expect(getKanbanSyncState('c1')).toBeNull()
  })
})
