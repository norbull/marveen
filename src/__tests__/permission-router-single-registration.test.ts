import { describe, it, expect } from 'vitest'
import {
  hooksBlockHasPermissionRouter,
  stripPermissionRouterHooks,
  PERMISSION_ROUTER_SCRIPT,
} from '../web/agent-scaffold.js'

// dupla-router root fix. The '*' permission-router consumes each grant
// single-use; it must be registered EXACTLY ONCE per agent process. The main
// agent's settings ARE user-global (~/.claude/settings.json) and every
// sub-agent process ALSO loads that same file, so a router in a sub-agent's
// agent-local settings runs a SECOND time -> grant-loop. The canonical rule is
// "router lives ONLY in user-global"; these tests pin the strip + detection
// helpers that enforce it for sub-agent agent-local settings.

const ROUTER_REPO = 'python3 /opt/app/scripts/hooks/permission-router.py'
const ROUTER_RUNTIME = 'python3 /home/u/.claude/hooks/permission-router.py'
const EMAIL_GATE = 'node /opt/app/scripts/email-send-gate.mjs'
const SELF_PACE = 'node /opt/app/scripts/self-pace-gate.mjs'

describe('PERMISSION_ROUTER_SCRIPT', () => {
  it('is the router script basename', () => {
    expect(PERMISSION_ROUTER_SCRIPT).toBe('permission-router.py')
  })
})

describe('hooksBlockHasPermissionRouter', () => {
  it('detects the router at the repo path', () => {
    const hooks = { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: ROUTER_REPO }] }] }
    expect(hooksBlockHasPermissionRouter(hooks)).toBe(true)
  })
  it('detects the router at the runtime path (path-independent)', () => {
    const hooks = { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: ROUTER_RUNTIME }] }] }
    expect(hooksBlockHasPermissionRouter(hooks)).toBe(true)
  })
  it('is false when only non-router gates are present', () => {
    const hooks = {
      PreToolUse: [
        { matcher: 'Bash|send_email', hooks: [{ type: 'command', command: EMAIL_GATE }] },
        { matcher: 'Bash', hooks: [{ type: 'command', command: SELF_PACE }] },
      ],
    }
    expect(hooksBlockHasPermissionRouter(hooks)).toBe(false)
  })
  it('is false for undefined / non-object / no PreToolUse', () => {
    expect(hooksBlockHasPermissionRouter(undefined)).toBe(false)
    expect(hooksBlockHasPermissionRouter(null)).toBe(false)
    expect(hooksBlockHasPermissionRouter('nope')).toBe(false)
    expect(hooksBlockHasPermissionRouter({})).toBe(false)
    expect(hooksBlockHasPermissionRouter({ PreToolUse: 'x' })).toBe(false)
  })
})

describe('stripPermissionRouterHooks', () => {
  it('removes a router that shares a group with other hooks, keeping the others', () => {
    const hooks: Record<string, unknown> = {
      PreToolUse: [
        {
          matcher: '*',
          hooks: [
            { type: 'command', command: ROUTER_REPO },
            { type: 'command', command: EMAIL_GATE },
          ],
        },
      ],
    }
    expect(stripPermissionRouterHooks(hooks)).toBe(true)
    const cmds = (hooks.PreToolUse as Array<{ hooks: Array<{ command: string }> }>)
      .flatMap((e) => e.hooks.map((h) => h.command))
    expect(cmds).toEqual([EMAIL_GATE])
  })

  it('drops a group that becomes empty after the router is removed', () => {
    const hooks: Record<string, unknown> = {
      PreToolUse: [
        { matcher: '*', hooks: [{ type: 'command', command: ROUTER_RUNTIME }] },
        { matcher: 'Bash|send_email', hooks: [{ type: 'command', command: EMAIL_GATE }] },
      ],
    }
    expect(stripPermissionRouterHooks(hooks)).toBe(true)
    const groups = hooks.PreToolUse as Array<{ matcher: string }>
    expect(groups).toHaveLength(1)
    expect(groups[0].matcher).toBe('Bash|send_email')
  })

  it('returns false and leaves the block untouched when no router is present', () => {
    const hooks: Record<string, unknown> = {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: SELF_PACE }] }],
    }
    expect(stripPermissionRouterHooks(hooks)).toBe(false)
    expect((hooks.PreToolUse as unknown[])).toHaveLength(1)
  })

  it('is idempotent: a second call is a no-op', () => {
    const hooks: Record<string, unknown> = {
      PreToolUse: [
        { matcher: '*', hooks: [{ type: 'command', command: ROUTER_REPO }] },
        { matcher: 'Bash', hooks: [{ type: 'command', command: SELF_PACE }] },
      ],
    }
    expect(stripPermissionRouterHooks(hooks)).toBe(true)
    expect(stripPermissionRouterHooks(hooks)).toBe(false)
    expect(hooksBlockHasPermissionRouter(hooks)).toBe(false)
  })

  it('returns false when there is no PreToolUse block', () => {
    const hooks: Record<string, unknown> = { PreCompact: [{ matcher: 'auto', hooks: [] }] }
    expect(stripPermissionRouterHooks(hooks)).toBe(false)
  })
})
