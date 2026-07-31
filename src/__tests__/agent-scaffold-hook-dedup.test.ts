import { describe, it, expect } from 'vitest'
import { hookScriptBasename, mergeHookBlocks } from '../web/agent-scaffold.js'

// 2026-07-17 dupla-router incident. install-critical-hooks.sh rewrites the
// router/notify command path in settings.json from the repo path
// ($ROOT/scripts/hooks/permission-router.py) to the runtime path
// ($HOME/.claude/hooks/permission-router.py) for branch immunity. The template
// still carries the repo path. The old exact-command-string dedup saw the two
// as different commands -> re-added the template router on every scaffold /
// ensureAgentHooks run -> two PreToolUse '*' routers -> every grant blocked.
// These tests pin the path-INDEPENDENT (basename) dedup that fixes it.

const ROUTER_REPO = 'python3 /opt/app/scripts/hooks/permission-router.py'
const ROUTER_RUNTIME = 'python3 /home/u/.claude/hooks/permission-router.py'

function routerCount(existing: Record<string, unknown>): { command: string }[] {
  return (existing.PreToolUse as Array<{ hooks: Array<{ command: string }> }>)
    .flatMap((e) => e.hooks)
    .filter((h) => h.command.includes('permission-router.py'))
}

describe('hookScriptBasename', () => {
  it('extracts the script basename from a python command', () => {
    expect(hookScriptBasename(ROUTER_RUNTIME)).toBe('permission-router.py')
  })
  it('extracts from a node .mjs command', () => {
    expect(hookScriptBasename('node /opt/app/scripts/email-send-gate.mjs')).toBe('email-send-gate.mjs')
  })
  it('ignores trailing args after the script path', () => {
    expect(hookScriptBasename('python3 /a/b/grant-approval.py --check now')).toBe('grant-approval.py')
  })
  it('returns null for an inline command with no script file', () => {
    expect(hookScriptBasename('echo hello && true')).toBeNull()
  })
})

describe('mergeHookBlocks -- dupla-router regression', () => {
  it('does NOT add the template router when a same-name router exists at a different path', () => {
    const existing: Record<string, unknown> = {
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: ROUTER_RUNTIME, timeout: 30 }] }],
    }
    const tpl = {
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: ROUTER_REPO, timeout: 30 }] }],
    }
    const changed = mergeHookBlocks(existing, tpl)
    expect(changed).toBe(false)
    const routers = routerCount(existing)
    expect(routers).toHaveLength(1) // consolidated to ONE, not two
    expect(routers[0].command).toBe(ROUTER_RUNTIME) // the runtime-path one is kept
  })

  it('is idempotent: re-merging the two different-path routers never re-adds', () => {
    const existing: Record<string, unknown> = {
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: ROUTER_RUNTIME }] }],
    }
    const tpl = { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: ROUTER_REPO }] }] }
    expect(mergeHookBlocks(existing, tpl)).toBe(false)
    expect(mergeHookBlocks(existing, tpl)).toBe(false)
    expect(routerCount(existing)).toHaveLength(1)
  })

  it('exact-command dedup still works (same path)', () => {
    const existing: Record<string, unknown> = {
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: ROUTER_REPO }] }],
    }
    const tpl = { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: ROUTER_REPO }] }] }
    expect(mergeHookBlocks(existing, tpl)).toBe(false)
    expect(routerCount(existing)).toHaveLength(1)
  })

  it('still adds a genuinely new hook (different script) to an existing event', () => {
    const existing: Record<string, unknown> = {
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: ROUTER_RUNTIME }] }],
    }
    const tpl = {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node /opt/app/scripts/email-send-gate.mjs' }] }],
    }
    const changed = mergeHookBlocks(existing, tpl)
    expect(changed).toBe(true)
    const cmds = (existing.PreToolUse as Array<{ hooks: Array<{ command: string }> }>)
      .flatMap((e) => e.hooks.map((h) => h.command))
    expect(cmds).toContain('node /opt/app/scripts/email-send-gate.mjs')
  })

  it('adds a whole event block when the event is missing', () => {
    const existing: Record<string, unknown> = {}
    const tpl = { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: ROUTER_REPO }] }] }
    expect(mergeHookBlocks(existing, tpl)).toBe(true)
    expect(existing.PreToolUse).toBeDefined()
    expect(routerCount(existing)).toHaveLength(1)
  })

  it('falls back to exact-string dedup for inline (non-script) commands', () => {
    const existing: Record<string, unknown> = {
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo a' }] }],
    }
    const tpl = { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo b' }] }] }
    // Different inline commands -> the new one IS added (no basename to collide on).
    expect(mergeHookBlocks(existing, tpl)).toBe(true)
    const cmds = (existing.PreToolUse as Array<{ hooks: Array<{ command: string }> }>)
      .flatMap((e) => e.hooks.map((h) => h.command))
    expect(cmds).toEqual(['echo a', 'echo b'])
  })

  it('syncs a stale timeout on an exact-command match', () => {
    const existing: Record<string, unknown> = {
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: ROUTER_REPO, timeout: 10 }] }],
    }
    const tpl = { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: ROUTER_REPO, timeout: 30 }] }] }
    expect(mergeHookBlocks(existing, tpl)).toBe(true)
    const h = (existing.PreToolUse as Array<{ hooks: Array<{ timeout: number }> }>)[0].hooks[0]
    expect(h.timeout).toBe(30)
  })
})
