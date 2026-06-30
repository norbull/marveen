// Unit tests for the live GitHubProjectsClient against a MOCKED fetch.
// No network, no token, no LLM -- validates schema discovery, list parsing,
// the label->option-id mapping on writes, and delete. (F4 mocked-GraphQL layer
// for the live client; the engine itself is covered in kanban-projects-sync.test.)
import { describe, it, expect, vi, afterEach } from 'vitest'
import { GitHubProjectsClient } from '../kanban-projects-client.js'
import type { SyncFields } from '../kanban-projects-sync.js'

const SCHEMA = { node: { fields: { nodes: [
  { __typename: 'ProjectV2FieldCommon', id: 'F_title', name: 'Title', dataType: 'TITLE' },
  { __typename: 'ProjectV2SingleSelectField', id: 'F_status', name: 'Status', dataType: 'SINGLE_SELECT',
    options: [{ id: 's_plan', name: 'Planned' }, { id: 's_prog', name: 'In Progress' }, { id: 's_wait', name: 'Waiting' }, { id: 's_done', name: 'Done' }] },
  { __typename: 'ProjectV2SingleSelectField', id: 'F_prio', name: 'Priority', dataType: 'SINGLE_SELECT',
    options: [{ id: 'p_low', name: 'Low' }, { id: 'p_norm', name: 'Normal' }, { id: 'p_high', name: 'High' }, { id: 'p_urg', name: 'Urgent' }] },
  { __typename: 'ProjectV2FieldCommon', id: 'F_agent', name: 'Agent', dataType: 'TEXT' },
  { __typename: 'ProjectV2FieldCommon', id: 'F_proj', name: 'Project', dataType: 'TEXT' },
  { __typename: 'ProjectV2FieldCommon', id: 'F_due', name: 'Due', dataType: 'DATE' },
] } } }

// Installs a mock fetch driven by a per-test query router. Returns the captured
// request log so assertions can inspect what mutations ran with what variables.
function install(router: (query: string, variables: any) => any) {
  const calls: { query: string; variables: any }[] = []
  const mock = vi.fn(async (_url: string, opts: any) => {
    const { query, variables } = JSON.parse(opts.body)
    calls.push({ query, variables })
    return { ok: true, status: 200, json: async () => ({ data: router(query, variables) }) } as any
  })
  vi.stubGlobal('fetch', mock)
  return calls
}

afterEach(() => vi.unstubAllGlobals())

const baseRouter = (query: string): any => {
  if (query.includes('fields(first:50)')) return SCHEMA
  throw new Error('unexpected query: ' + query.slice(0, 40))
}

describe('GitHubProjectsClient.create (schema discovery)', () => {
  it('discovers field ids by name', async () => {
    install(baseRouter)
    const client = await GitHubProjectsClient.create('tok', 'PROJ')
    expect(client).toBeInstanceOf(GitHubProjectsClient)
  })

  it('throws when a required field is missing', async () => {
    install((q) => {
      if (q.includes('fields(first:50)')) {
        return { node: { fields: { nodes: SCHEMA.node.fields.nodes.filter(f => f.name !== 'Priority') } } }
      }
      throw new Error('unexpected')
    })
    await expect(GitHubProjectsClient.create('tok', 'PROJ')).rejects.toThrow(/Priority/)
  })

  it('throws when the project node is null (bad id/scope)', async () => {
    install((q) => (q.includes('fields(first:50)') ? { node: null } : {}))
    await expect(GitHubProjectsClient.create('tok', 'PROJ')).rejects.toThrow(/not found/)
  })
})

describe('GitHubProjectsClient.listItems (parse)', () => {
  it('maps a draft item to canonical SyncFields', async () => {
    install((query) => {
      if (query.includes('fields(first:50)')) return SCHEMA
      if (query.includes('items(first:100')) return { node: { items: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [{
          id: 'item1', updatedAt: '2026-06-30T12:00:00Z',
          content: { title: 'card title', body: 'card body' },
          fieldValues: { nodes: [
            { __typename: 'ProjectV2ItemFieldSingleSelectValue', name: 'In Progress', field: { id: 'F_status' } },
            { __typename: 'ProjectV2ItemFieldSingleSelectValue', name: 'High', field: { id: 'F_prio' } },
            { __typename: 'ProjectV2ItemFieldTextValue', text: 'dex', field: { id: 'F_agent' } },
            { __typename: 'ProjectV2ItemFieldTextValue', text: 'kanban-sync', field: { id: 'F_proj' } },
            { __typename: 'ProjectV2ItemFieldDateValue', date: '2026-07-15', field: { id: 'F_due' } },
          ] },
        }],
      } } }
      throw new Error('unexpected')
    })
    const client = await GitHubProjectsClient.create('tok', 'PROJ')
    const items = await client.listItems()
    expect(items).toHaveLength(1)
    expect(items[0].itemId).toBe('item1')
    expect(items[0].updatedAt).toBe(Math.floor(Date.parse('2026-06-30T12:00:00Z') / 1000))
    expect(items[0].fields).toEqual<SyncFields>({
      title: 'card title', body: 'card body', status: 'In Progress', priority: 'High',
      assignee: 'dex', project: 'kanban-sync', due: '2026-07-15',
    })
  })

  it('paginates across pages', async () => {
    let page = 0
    install((query) => {
      if (query.includes('fields(first:50)')) return SCHEMA
      if (query.includes('items(first:100')) {
        page++
        return page === 1
          ? { node: { items: { pageInfo: { hasNextPage: true, endCursor: 'c1' }, nodes: [mkNode('a')] } } }
          : { node: { items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [mkNode('b')] } } }
      }
      throw new Error('unexpected')
    })
    const client = await GitHubProjectsClient.create('tok', 'PROJ')
    const items = await client.listItems()
    expect(items.map(i => i.itemId)).toEqual(['a', 'b'])
  })
})

describe('GitHubProjectsClient.upsertItem (label->option-id mapping)', () => {
  it('creates a draft and sets fields with resolved single-select option ids', async () => {
    const calls = install((query) => {
      if (query.includes('fields(first:50)')) return SCHEMA
      if (query.includes('addProjectV2DraftIssue')) return { addProjectV2DraftIssue: { projectItem: { id: 'newitem', content: { id: 'draft1' } } } }
      if (query.includes('updateProjectV2ItemFieldValue')) return { updateProjectV2ItemFieldValue: { projectV2Item: { updatedAt: '2026-06-30T13:00:00Z' } } }
      if (query.includes('clearProjectV2ItemFieldValue')) return { clearProjectV2ItemFieldValue: { projectV2Item: { updatedAt: '2026-06-30T13:00:00Z' } } }
      throw new Error('unexpected: ' + query.slice(0, 40))
    })
    const client = await GitHubProjectsClient.create('tok', 'PROJ')
    const fields: SyncFields = { title: 't', body: 'b', status: 'Waiting', priority: 'Urgent', assignee: 'dex', project: 'p', due: '2026-07-15' }
    const res = await client.upsertItem(fields, null)
    expect(res.itemId).toBe('newitem')
    expect(res.updatedAt).toBe(Math.floor(Date.parse('2026-06-30T13:00:00Z') / 1000))

    const setCalls = calls.filter(c => c.query.includes('updateProjectV2ItemFieldValue'))
    const statusSet = setCalls.find(c => c.variables.fieldId === 'F_status')
    const prioSet = setCalls.find(c => c.variables.fieldId === 'F_prio')
    const dueSet = setCalls.find(c => c.variables.fieldId === 'F_due')
    expect(statusSet?.variables.value).toBe('s_wait') // 'Waiting' -> option id
    expect(prioSet?.variables.value).toBe('p_urg')    // 'Urgent' -> option id
    expect(dueSet?.variables.value).toBe('2026-07-15')
  })

  it('clears the due date when due is null', async () => {
    const calls = install((query) => {
      if (query.includes('fields(first:50)')) return SCHEMA
      if (query.includes('addProjectV2DraftIssue')) return { addProjectV2DraftIssue: { projectItem: { id: 'i', content: { id: 'd' } } } }
      if (query.includes('updateProjectV2ItemFieldValue')) return { updateProjectV2ItemFieldValue: { projectV2Item: { updatedAt: '2026-06-30T13:00:00Z' } } }
      if (query.includes('clearProjectV2ItemFieldValue')) return { clearProjectV2ItemFieldValue: { projectV2Item: { updatedAt: '2026-06-30T13:00:00Z' } } }
      throw new Error('unexpected')
    })
    const client = await GitHubProjectsClient.create('tok', 'PROJ')
    const fields: SyncFields = { title: 't', body: 'b', status: 'Planned', priority: 'Low', assignee: '', project: '', due: null }
    await client.upsertItem(fields, null)
    expect(calls.some(c => c.query.includes('clearProjectV2ItemFieldValue') && c.variables.fieldId === 'F_due')).toBe(true)
  })
})

describe('GitHubProjectsClient.deleteItem', () => {
  it('issues deleteProjectV2Item with the item id', async () => {
    const calls = install((query) => {
      if (query.includes('fields(first:50)')) return SCHEMA
      if (query.includes('deleteProjectV2Item')) return { deleteProjectV2Item: { deletedItemId: 'gone' } }
      throw new Error('unexpected')
    })
    const client = await GitHubProjectsClient.create('tok', 'PROJ')
    await client.deleteItem('gone')
    expect(calls.some(c => c.query.includes('deleteProjectV2Item') && c.variables.itemId === 'gone')).toBe(true)
  })
})

function mkNode(id: string) {
  return {
    id, updatedAt: '2026-06-30T12:00:00Z',
    content: { title: id, body: '' },
    fieldValues: { nodes: [] },
  }
}
