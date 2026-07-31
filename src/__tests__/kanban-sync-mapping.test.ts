import { describe, it, expect } from 'vitest'
import {
  statusToLabel, labelToStatus, priorityToLabel, labelToPriority,
  dueToIso, isoToDue, cardToFields, fieldsToCardUpdate, fieldsHash, resolveConflict,
  type SyncFields,
} from '../kanban-sync-mapping.js'
import type { KanbanCard } from '../db.js'

const sampleCard: Pick<KanbanCard,
  'title' | 'description' | 'status' | 'priority' | 'assignee' | 'project' | 'due_date'> = {
  title: 'Wire the sync',
  description: 'body text',
  status: 'in_progress',
  priority: 'high',
  assignee: 'dex',
  project: 'infra',
  due_date: 1782777600, // 2026-06-30 (UTC midnight-ish)
}

describe('status mapping', () => {
  it('round-trips every status', () => {
    for (const s of ['planned', 'in_progress', 'waiting', 'done'] as const) {
      expect(labelToStatus(statusToLabel(s))).toBe(s)
    }
  })
  it('unknown label falls back to planned', () => {
    expect(labelToStatus('Bogus')).toBe('planned')
    expect(labelToStatus(null)).toBe('planned')
  })
})

describe('priority mapping', () => {
  it('round-trips every priority', () => {
    for (const p of ['low', 'normal', 'high', 'urgent'] as const) {
      expect(labelToPriority(priorityToLabel(p))).toBe(p)
    }
  })
  it('unknown label falls back to normal', () => {
    expect(labelToPriority('Bogus')).toBe('normal')
    expect(labelToPriority(undefined)).toBe('normal')
  })
})

describe('due date mapping', () => {
  it('converts epoch to ISO date and back to the same day', () => {
    const iso = dueToIso(sampleCard.due_date)
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    const back = isoToDue(iso)
    // round-trips to UTC midnight of the same calendar day
    expect(dueToIso(back)).toBe(iso)
  })
  it('handles null both ways', () => {
    expect(dueToIso(null)).toBeNull()
    expect(isoToDue(null)).toBeNull()
    expect(isoToDue('not-a-date')).toBeNull()
  })
})

describe('field projection round-trip', () => {
  it('cardToFields -> fieldsToCardUpdate preserves the canonical values', () => {
    const f = cardToFields(sampleCard)
    const back = fieldsToCardUpdate(f)
    expect(back.title).toBe(sampleCard.title)
    expect(back.status).toBe(sampleCard.status)
    expect(back.priority).toBe(sampleCard.priority)
    expect(back.assignee).toBe(sampleCard.assignee)
    expect(back.project).toBe(sampleCard.project)
    expect(dueToIso(back.due_date)).toBe(dueToIso(sampleCard.due_date))
  })
  it('maps empty strings back to null (description/assignee/project)', () => {
    const f: SyncFields = { title: 't', body: '', status: 'Planned', priority: 'Normal', assignee: '', project: '', due: null }
    const back = fieldsToCardUpdate(f)
    expect(back.description).toBeNull()
    expect(back.assignee).toBeNull()
    expect(back.project).toBeNull()
    expect(back.due_date).toBeNull()
  })
})

describe('fieldsHash', () => {
  it('is stable for identical content', () => {
    expect(fieldsHash(cardToFields(sampleCard))).toBe(fieldsHash(cardToFields(sampleCard)))
  })
  it('changes when any synced field changes', () => {
    const base = fieldsHash(cardToFields(sampleCard))
    expect(fieldsHash(cardToFields({ ...sampleCard, title: 'changed' }))).not.toBe(base)
    expect(fieldsHash(cardToFields({ ...sampleCard, status: 'done' }))).not.toBe(base)
  })
})

describe('resolveConflict (last-write-wins V1)', () => {
  it('no change -> none', () => {
    expect(resolveConflict({ localChanged: false, remoteChanged: false, localUpdatedAt: 1, remoteUpdatedAt: 1 })).toBe('none')
  })
  it('one-sided change wins that side', () => {
    expect(resolveConflict({ localChanged: true, remoteChanged: false, localUpdatedAt: 5, remoteUpdatedAt: 9 })).toBe('local')
    expect(resolveConflict({ localChanged: false, remoteChanged: true, localUpdatedAt: 9, remoteUpdatedAt: 5 })).toBe('remote')
  })
  it('both changed -> fresher timestamp wins', () => {
    expect(resolveConflict({ localChanged: true, remoteChanged: true, localUpdatedAt: 10, remoteUpdatedAt: 20 })).toBe('remote')
    expect(resolveConflict({ localChanged: true, remoteChanged: true, localUpdatedAt: 20, remoteUpdatedAt: 10 })).toBe('local')
  })
  it('both changed, tie -> local (no bounce)', () => {
    expect(resolveConflict({ localChanged: true, remoteChanged: true, localUpdatedAt: 7, remoteUpdatedAt: 7 })).toBe('local')
  })
})
