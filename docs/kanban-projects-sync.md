# Kanban ↔ GitHub Projects v2 sync

Two-way sync between the dashboard kanban (`kanban_cards` in SQLite) and a private
GitHub Projects v2 board, so the board (and edits) are reachable from the GitHub
mobile app. **Deterministic, zero runtime LLM tokens** — plain GraphQL + a poll
loop; it never calls an agent.

## Why

Norbi can't see the localhost dashboard kanban from mobile. A private user-owned
GitHub Project mirrors the kanban both ways: changes on either side propagate.
Development cost is a one-time token spend; runtime is free Node code in the
marveen service.

## Architecture

Four layers, each independently testable:

| Layer | File | Responsibility |
|---|---|---|
| Pure mapping | `kanban-sync-mapping.ts` | field ⇄ field transforms, content hash, conflict resolution. No I/O. |
| Persistence | `db.ts` (`kanban_sync_*`) | transactional **outbox** + per-card **sync state**, suppress flag. |
| Engine | `kanban-projects-sync.ts` | `drainForward` (outbox → GitHub) + `pollBackward` (GitHub → SQLite); lifecycle. |
| Live client | `kanban-projects-client.ts` | the GraphQL `ProjectsClient` impl (`listItems`/`upsertItem`/`deleteItem`). |

The engine talks to GitHub only through the injectable `ProjectsClient`
interface, so the hot logic is unit-tested with a mock (no token, no network).

### Forward path (kanban → GitHub)

The kanban writer functions in `db.ts` (`createKanbanCard`, `updateKanbanCard`,
`moveKanbanCard`, `archiveKanbanCard`, delete) enqueue a row into
`kanban_sync_outbox` **in the same write** (transactional outbox — crash-safe,
decoupled from the API call). `drainForward` pops rows in order, upserts/deletes
the draft item via the client, records the result in `kanban_sync_state`, and
deletes the outbox row. A failed row stays for the next tick (at-least-once).

### Backward path (GitHub → kanban)

No webhook (the dashboard is localhost-only, no public surface). Instead
`pollBackward` lists the Project items every ~45s, diffs each against the stored
fingerprint (`last_synced_hash`), and applies genuine changes via
`updateKanbanCard` / `createKanbanCard`.

### Echo avoidance

A backward write must not re-enqueue a forward sync. `pollBackward` wraps its DB
writes in `setKanbanSyncSuppressed(true)`, and `enqueueKanbanSync` no-ops while
suppressed (mirrors the store-watcher write-actor pattern).

### Conflict resolution

V1 = **last-write-wins** by timestamp (SQLite `updated_at` vs Project
`updatedAt`, both UTC). The poll only fires when the remote fingerprint actually
moved, so most changes apply cleanly; a genuine both-sides edit resolves to the
fresher timestamp (tie → local). Field-level merge is a possible V2.

## Project schema

The board is a private user-owned ProjectV2 on `norbull`. The live client
discovers field + single-select option IDs **at boot by field name**, so renaming
or recreating the project (or regenerating option IDs) needs no code change.

| kanban_cards | Project field | Type |
|---|---|---|
| title | Title | draft issue title |
| description | (draft issue body) | text |
| status | Status | single-select: Planned / In Progress / Waiting / Done |
| priority | Priority | single-select: Low / Normal / High / Urgent |
| assignee | **Agent** | text (`Assignee` is a reserved field name on GitHub) |
| project | Project | text |
| due_date | Due | date |

> The built-in Status options (`Todo/In Progress/Done`) are retargeted to the
> kanban set via `updateProjectV2Field` so the board columns match.

## Configuration & feature flag

The sync is **off by default**. It starts only when both files exist in `store/`:

- `store/.github-project-token` — a GitHub PAT with `project` scope (classic) or a
  fine-grained token with Projects read+write. `0600`, gitignored, never logged.
- `store/.github-project-id` — the ProjectV2 node id (e.g. `PVT_kwHOAF9Bgc4BcGeJ`).

`buildKanbanProjectsClient()` returns `null` if either is missing → the engine
logs `sync disabled` and never starts the loop. Shipping the code does **not**
enable the sync.

## Activation (canary)

1. Write the project id to `store/.github-project-id` (token already present).
2. Restart the marveen service.
3. Confirm the boot log: `kanban-sync: GitHub Projects schema discovered` then
   `kanban-sync: started`. A missing/invalid token logs `client boot failed` and
   the rest of the service is unaffected.
4. Create one throwaway kanban card; within ~45s it appears as a draft item on the
   board. Edit a field on the board; within ~45s it reflects back in the kanban.
5. Remove the test card.

To disable: delete `store/.github-project-id` and restart.

## Token scope

ProjectsV2 is GraphQL-only and needs `project` scope. Verify a token's scope
without printing it:

```bash
curl -sI -H "Authorization: token $(cat store/.github-project-token)" https://api.github.com/ | grep -i x-oauth-scopes
```

## Tests

`src/__tests__/kanban-sync-mapping.test.ts`, `kanban-sync-outbox.test.ts`,
`kanban-projects-sync.test.ts` (engine, mocked client), and
`kanban-projects-client.test.ts` (live client against a mocked `fetch`). All run
with no token and no network.
