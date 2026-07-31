// Pure, deterministic mapping between kanban_cards rows and GitHub Projects v2
// item field values. NO I/O, NO network, NO LLM -- every function here is a pure
// transform so the sync engine's hot logic is fully unit-testable without a
// token or a live Project. (Norbi constraint: zero runtime LLM tokens.)
//
// The live GraphQL layer (kanban-projects-sync.ts) turns these field names into
// the Project's option-IDs via a cache discovered at boot (F1); this module only
// speaks the human-readable canonical values.

import { createHash } from 'node:crypto'
import type { KanbanCard } from './db.js'

// --- canonical enum <-> Project single-select option label maps ---

const STATUS_TO_LABEL: Record<KanbanCard['status'], string> = {
  planned: 'Planned',
  in_progress: 'In Progress',
  testing: 'Testing',
  waiting: 'Waiting',
  done: 'Done',
}
const LABEL_TO_STATUS: Record<string, KanbanCard['status']> = {
  Planned: 'planned',
  'In Progress': 'in_progress',
  Testing: 'testing',
  Waiting: 'waiting',
  Done: 'done',
}

const PRIORITY_TO_LABEL: Record<KanbanCard['priority'], string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
}
const LABEL_TO_PRIORITY: Record<string, KanbanCard['priority']> = {
  Low: 'low',
  Normal: 'normal',
  High: 'high',
  Urgent: 'urgent',
}

export function statusToLabel(s: KanbanCard['status']): string {
  return STATUS_TO_LABEL[s] ?? 'Planned'
}
export function labelToStatus(label: string | null | undefined): KanbanCard['status'] {
  return (label && LABEL_TO_STATUS[label]) || 'planned'
}
export function priorityToLabel(p: KanbanCard['priority']): string {
  return PRIORITY_TO_LABEL[p] ?? 'Normal'
}
export function labelToPriority(label: string | null | undefined): KanbanCard['priority'] {
  return (label && LABEL_TO_PRIORITY[label]) || 'normal'
}

// --- date <-> Projects Date field (ISO yyyy-mm-dd, UTC) ---

export function dueToIso(due: number | null): string | null {
  if (!due) return null
  // due_date is a unix epoch (seconds). Projects Date fields are date-only ISO.
  return new Date(due * 1000).toISOString().slice(0, 10)
}
export function isoToDue(iso: string | null | undefined): number | null {
  if (!iso) return null
  const ms = Date.parse(`${iso}T00:00:00Z`)
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000)
}

// --- the canonical field projection that crosses the boundary ---
// V1 maps the main card fields only (no comments/labels/parent_id -- decision #4).

export interface SyncFields {
  title: string
  body: string
  status: string // option label
  priority: string // option label
  assignee: string // text (fleet agent name, NOT a GitHub user -- decision)
  project: string // text
  due: string | null // ISO date or null
}

export function cardToFields(card: Pick<KanbanCard,
  'title' | 'description' | 'status' | 'priority' | 'assignee' | 'project' | 'due_date'>): SyncFields {
  return {
    title: card.title,
    body: card.description ?? '',
    status: statusToLabel(card.status),
    priority: priorityToLabel(card.priority),
    assignee: card.assignee ?? '',
    project: card.project ?? '',
    due: dueToIso(card.due_date),
  }
}

// Reverse: a Project item's field values -> the partial card update we apply on
// the backward path. Returns the same shape updateKanbanCard accepts.
export function fieldsToCardUpdate(f: SyncFields): Pick<KanbanCard,
  'title' | 'description' | 'status' | 'priority' | 'assignee' | 'project' | 'due_date'> {
  return {
    title: f.title,
    description: f.body === '' ? null : f.body,
    status: labelToStatus(f.status),
    priority: labelToPriority(f.priority),
    assignee: f.assignee === '' ? null : f.assignee,
    project: f.project === '' ? null : f.project,
    due_date: isoToDue(f.due),
  }
}

// --- change detection: a stable content hash over the synced projection ---
// Used to skip no-op syncs and to detect which side actually changed. Field
// order is fixed so the hash is deterministic across runs/processes.

export function fieldsHash(f: SyncFields): string {
  const canonical = JSON.stringify([f.title, f.body, f.status, f.priority, f.assignee, f.project, f.due ?? ''])
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16)
}

// --- conflict resolution (V1: last-write-wins by timestamp) ---
// Both sides carry an "updated" epoch (SQLite updated_at; Projects item
// updatedAt parsed to epoch). The fresher side wins. Ties resolve to 'local'
// so a same-second double-edit does not bounce. Pure + side-effect free.

export type SyncWinner = 'local' | 'remote' | 'none'

export function resolveConflict(args: {
  localChanged: boolean
  remoteChanged: boolean
  localUpdatedAt: number
  remoteUpdatedAt: number
}): SyncWinner {
  const { localChanged, remoteChanged, localUpdatedAt, remoteUpdatedAt } = args
  if (!localChanged && !remoteChanged) return 'none'
  if (localChanged && !remoteChanged) return 'local'
  if (!localChanged && remoteChanged) return 'remote'
  // both changed since last sync -> fresher timestamp wins, tie -> local
  return remoteUpdatedAt > localUpdatedAt ? 'remote' : 'local'
}
