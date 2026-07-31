// Live GitHub Projects v2 GraphQL implementation of the ProjectsClient boundary
// declared in kanban-projects-sync.ts.
//
// CONSTRAINT (Norbi): deterministic, ZERO runtime LLM tokens. Plain GraphQL over
// fetch -- never calls an agent.
//
// The field + single-select option IDs are discovered at BOOT by field NAME
// (discoverSchema), so renaming/recreating the project, or regenerating option
// IDs, needs no code change. The token (project scope) is injected; it is held
// in memory only and never logged.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ProjectsClient, RemoteItem } from './kanban-projects-sync.js'
import type { SyncFields } from './kanban-sync-mapping.js'
import { PROJECT_ROOT } from './config.js'
import { logger } from './logger.js'

const GRAPHQL_URL = 'https://api.github.com/graphql'

// The project field names this sync owns. Must match the fields created in the
// Project. NB: SyncFields.assignee maps to the "Agent" field -- the name
// "Assignee" is reserved by GitHub and cannot be used for a custom field.
const FIELD = {
  status: 'Status',
  priority: 'Priority',
  assignee: 'Agent',
  project: 'Project',
  due: 'Due',
} as const

interface DiscoveredSchema {
  statusFieldId: string
  priorityFieldId: string
  assigneeFieldId: string
  projectFieldId: string
  dueFieldId: string
  // label -> single-select option id (forward path needs option ids for writes)
  statusOptionByLabel: Map<string, string>
  priorityOptionByLabel: Map<string, string>
}

type GqlField =
  | { __typename: string; id: string; name: string; dataType: string; options?: { id: string; name: string }[] }

// epoch seconds from a GraphQL ISO-8601 timestamp.
function isoToEpoch(iso: string | null | undefined): number {
  if (!iso) return 0
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? 0 : Math.floor(ms / 1000)
}

export class GitHubProjectsClient implements ProjectsClient {
  private constructor(
    private readonly token: string,
    private readonly projectId: string,
    private readonly schema: DiscoveredSchema,
  ) {}

  // Boot factory: discover the schema, then build the client. Throws if the
  // project id is wrong or a required field is missing (fail fast at boot).
  static async create(token: string, projectId: string): Promise<GitHubProjectsClient> {
    const schema = await discoverSchema(token, projectId)
    logger.info({ projectId }, 'kanban-sync: GitHub Projects schema discovered')
    return new GitHubProjectsClient(token, projectId, schema)
  }

  private async gql<T = any>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    return gqlRequest<T>(this.token, query, variables)
  }

  // --- read: list every item as canonical SyncFields (paginated) ---
  async listItems(): Promise<RemoteItem[]> {
    const out: RemoteItem[] = []
    let cursor: string | null = null
    do {
      // explicit annotation breaks the cursor<-data<-page<-cursor inference cycle
      const data: { node: { items: ItemsPage } | null } = await this.gql(LIST_ITEMS_QUERY, {
        id: this.projectId,
        cursor,
      })
      const page: ItemsPage | undefined = data.node?.items
      if (!page) break
      for (const node of page.nodes) {
        out.push(this.nodeToRemoteItem(node))
      }
      cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null
    } while (cursor)
    return out
  }

  private nodeToRemoteItem(node: ItemNode): RemoteItem {
    const byField = new Map<string, FieldValueNode>()
    for (const fv of node.fieldValues.nodes) {
      if (fv?.field?.id) byField.set(fv.field.id, fv)
    }
    const single = (fieldId: string): string =>
      (byField.get(fieldId)?.name ?? '')
    const text = (fieldId: string): string =>
      (byField.get(fieldId)?.text ?? '')
    const date = (fieldId: string): string | null =>
      (byField.get(fieldId)?.date ?? null)

    const fields: SyncFields = {
      title: node.content?.title ?? '',
      body: node.content?.body ?? '',
      status: single(this.schema.statusFieldId),
      priority: single(this.schema.priorityFieldId),
      assignee: text(this.schema.assigneeFieldId),
      project: text(this.schema.projectFieldId),
      due: date(this.schema.dueFieldId),
    }
    return { itemId: node.id, fields, updatedAt: isoToEpoch(node.updatedAt) }
  }

  // --- write: create or update a draft issue + its field values ---
  async upsertItem(fields: SyncFields, itemId: string | null): Promise<{ itemId: string; updatedAt: number }> {
    let resolvedItemId = itemId
    let draftIssueId: string | null = null

    if (!resolvedItemId) {
      const created = await this.gql<{ addProjectV2DraftIssue: { projectItem: { id: string; content: { id: string } | null } } }>(
        CREATE_DRAFT_MUTATION,
        { projectId: this.projectId, title: fields.title, body: fields.body },
      )
      resolvedItemId = created.addProjectV2DraftIssue.projectItem.id
      draftIssueId = created.addProjectV2DraftIssue.projectItem.content?.id ?? null
    } else {
      // updating an existing item: fetch its draft-issue content id for title/body
      const got = await this.gql<{ node: { content: { id: string } | null } | null }>(
        ITEM_CONTENT_QUERY,
        { id: resolvedItemId },
      )
      draftIssueId = got.node?.content?.id ?? null
      if (draftIssueId) {
        await this.gql(UPDATE_DRAFT_MUTATION, { draftIssueId, title: fields.title, body: fields.body })
      }
    }

    const updatedAt = await this.applyFieldValues(resolvedItemId, fields)
    return { itemId: resolvedItemId, updatedAt }
  }

  // Set all mapped field values on an item. Single-select labels are resolved to
  // option ids via the discovered schema; an unmappable label is skipped. A null
  // due clears the date field. Returns the item's updatedAt after the writes.
  private async applyFieldValues(itemId: string, fields: SyncFields): Promise<number> {
    const statusOpt = this.schema.statusOptionByLabel.get(fields.status)
    const priorityOpt = this.schema.priorityOptionByLabel.get(fields.priority)

    let updatedAt = 0
    const setSingle = async (fieldId: string, optionId: string | undefined) => {
      if (!optionId) return
      const d = await this.gql<{ updateProjectV2ItemFieldValue: { projectV2Item: { updatedAt: string } } }>(
        SET_FIELD_MUTATION('singleSelectOptionId'),
        { projectId: this.projectId, itemId, fieldId, value: optionId },
      )
      updatedAt = isoToEpoch(d.updateProjectV2ItemFieldValue.projectV2Item.updatedAt)
    }
    const setText = async (fieldId: string, value: string) => {
      const d = await this.gql<{ updateProjectV2ItemFieldValue: { projectV2Item: { updatedAt: string } } }>(
        SET_FIELD_MUTATION('text'),
        { projectId: this.projectId, itemId, fieldId, value },
      )
      updatedAt = isoToEpoch(d.updateProjectV2ItemFieldValue.projectV2Item.updatedAt)
    }
    const setDate = async (fieldId: string, iso: string | null) => {
      if (iso === null) {
        const d = await this.gql<{ clearProjectV2ItemFieldValue: { projectV2Item: { updatedAt: string } } }>(
          CLEAR_FIELD_MUTATION,
          { projectId: this.projectId, itemId, fieldId },
        )
        updatedAt = isoToEpoch(d.clearProjectV2ItemFieldValue.projectV2Item.updatedAt)
        return
      }
      const d = await this.gql<{ updateProjectV2ItemFieldValue: { projectV2Item: { updatedAt: string } } }>(
        SET_FIELD_MUTATION('date'),
        { projectId: this.projectId, itemId, fieldId, value: iso },
      )
      updatedAt = isoToEpoch(d.updateProjectV2ItemFieldValue.projectV2Item.updatedAt)
    }

    await setSingle(this.schema.statusFieldId, statusOpt)
    await setSingle(this.schema.priorityFieldId, priorityOpt)
    await setText(this.schema.assigneeFieldId, fields.assignee)
    await setText(this.schema.projectFieldId, fields.project)
    await setDate(this.schema.dueFieldId, fields.due)
    return updatedAt
  }

  async deleteItem(itemId: string): Promise<void> {
    await this.gql(DELETE_ITEM_MUTATION, { projectId: this.projectId, itemId })
  }
}

// --- boot factory (feature-flagged) ---

const TOKEN_PATH = join(PROJECT_ROOT, 'store', '.github-project-token')
const PROJECT_ID_PATH = join(PROJECT_ROOT, 'store', '.github-project-id')

// Build a live client from the on-disk config, or return null when the feature
// is not configured (no token or no project id) -> the sync engine no-ops. This
// is the safety gate: shipping the code does NOT enable the sync until both
// files exist in the store. Never logs the token.
export async function buildKanbanProjectsClient(): Promise<ProjectsClient | null> {
  if (!existsSync(TOKEN_PATH) || !existsSync(PROJECT_ID_PATH)) return null
  const token = readFileSync(TOKEN_PATH, 'utf8').trim()
  const projectId = readFileSync(PROJECT_ID_PATH, 'utf8').trim()
  if (!token || !projectId) return null
  return GitHubProjectsClient.create(token, projectId)
}

// --- low-level GraphQL request (shared by discovery + client) ---

async function gqlRequest<T>(token: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Authorization': `bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'marveen-kanban-sync',
    },
    body: JSON.stringify({ query, variables }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`GitHub GraphQL HTTP ${res.status}: ${body.slice(0, 200)}`)
  }
  const json = await res.json() as { data?: T; errors?: { message: string }[] }
  if (json.errors?.length) {
    throw new Error(`GitHub GraphQL errors: ${json.errors.map(e => e.message).join('; ')}`)
  }
  return json.data as T
}

// --- boot-time schema discovery (by field name) ---

async function discoverSchema(token: string, projectId: string): Promise<DiscoveredSchema> {
  const data = await gqlRequest<{ node: { fields: { nodes: GqlField[] } } | null }>(token, SCHEMA_QUERY, { id: projectId })
  if (!data.node) throw new Error(`kanban-sync: project ${projectId} not found (check id/token scope)`)
  const byName = new Map<string, GqlField>()
  for (const f of data.node.fields.nodes) if (f?.name) byName.set(f.name, f)

  const need = (name: string): GqlField => {
    const f = byName.get(name)
    if (!f) throw new Error(`kanban-sync: required project field "${name}" missing`)
    return f
  }
  const optMap = (f: GqlField): Map<string, string> => {
    const m = new Map<string, string>()
    for (const o of f.options ?? []) m.set(o.name, o.id)
    return m
  }

  const status = need(FIELD.status)
  const priority = need(FIELD.priority)
  return {
    statusFieldId: status.id,
    priorityFieldId: priority.id,
    assigneeFieldId: need(FIELD.assignee).id,
    projectFieldId: need(FIELD.project).id,
    dueFieldId: need(FIELD.due).id,
    statusOptionByLabel: optMap(status),
    priorityOptionByLabel: optMap(priority),
  }
}

// --- GraphQL documents ---

const SCHEMA_QUERY = `
query($id:ID!){
  node(id:$id){ ... on ProjectV2 {
    fields(first:50){ nodes {
      __typename
      ... on ProjectV2FieldCommon { id name dataType }
      ... on ProjectV2SingleSelectField { id name options { id name } }
    } }
  } }
}`

const LIST_ITEMS_QUERY = `
query($id:ID!,$cursor:String){
  node(id:$id){ ... on ProjectV2 {
    items(first:100, after:$cursor){
      pageInfo{ hasNextPage endCursor }
      nodes{
        id
        updatedAt
        content{
          ... on DraftIssue { title body }
          ... on Issue { title body }
          ... on PullRequest { title body }
        }
        fieldValues(first:30){ nodes{
          __typename
          ... on ProjectV2ItemFieldSingleSelectValue { name field{ ... on ProjectV2FieldCommon { id } } }
          ... on ProjectV2ItemFieldTextValue { text field{ ... on ProjectV2FieldCommon { id } } }
          ... on ProjectV2ItemFieldDateValue { date field{ ... on ProjectV2FieldCommon { id } } }
        } }
      }
    }
  } }
}`

const ITEM_CONTENT_QUERY = `
query($id:ID!){ node(id:$id){ ... on ProjectV2Item { content{ ... on DraftIssue { id } } } } }`

const CREATE_DRAFT_MUTATION = `
mutation($projectId:ID!,$title:String!,$body:String!){
  addProjectV2DraftIssue(input:{projectId:$projectId, title:$title, body:$body}){
    projectItem{ id content{ ... on DraftIssue { id } } }
  }
}`

const UPDATE_DRAFT_MUTATION = `
mutation($draftIssueId:ID!,$title:String!,$body:String!){
  updateProjectV2DraftIssue(input:{draftIssueId:$draftIssueId, title:$title, body:$body}){
    draftIssue{ id }
  }
}`

// value type varies by field (singleSelectOptionId/text are String, date is the
// Date scalar) -> both the value key and the variable type are built per call.
const SET_FIELD_MUTATION = (valueKey: 'singleSelectOptionId' | 'text' | 'date') => {
  const varType = valueKey === 'date' ? 'Date!' : 'String!'
  return `
mutation($projectId:ID!,$itemId:ID!,$fieldId:ID!,$value:${varType}){
  updateProjectV2ItemFieldValue(input:{
    projectId:$projectId, itemId:$itemId, fieldId:$fieldId, value:{ ${valueKey}:$value }
  }){ projectV2Item{ updatedAt } }
}`
}

const CLEAR_FIELD_MUTATION = `
mutation($projectId:ID!,$itemId:ID!,$fieldId:ID!){
  clearProjectV2ItemFieldValue(input:{ projectId:$projectId, itemId:$itemId, fieldId:$fieldId }){
    projectV2Item{ updatedAt }
  }
}`

const DELETE_ITEM_MUTATION = `
mutation($projectId:ID!,$itemId:ID!){
  deleteProjectV2Item(input:{ projectId:$projectId, itemId:$itemId }){ deletedItemId }
}`

// --- response shapes for list ---
interface FieldValueNode { __typename: string; name?: string; text?: string; date?: string; field?: { id: string } }
interface ItemNode {
  id: string
  updatedAt: string
  content: { title?: string; body?: string } | null
  fieldValues: { nodes: FieldValueNode[] }
}
interface ItemsPage { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: ItemNode[] }
