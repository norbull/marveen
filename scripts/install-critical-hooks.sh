#!/usr/bin/env bash
# Idempotent installer: make the branch-critical hooks survive upstream branch
# switches by running them from ~/.claude/hooks/ instead of the repo working
# tree. A checkout that changes scripts/hooks/ (or a stray `git checkout
# develop`) can delete the repo copy from disk mid-run and deadlock the whole
# fleet (every PreToolUse call blocks on the missing permission-router). The
# runtime copy under ~/.claude/hooks/ is branch-immune.
#
# What it does:
#   1) Copy the 3 critical hooks into ~/.claude/hooks/ (+ chmod +x):
#        permission-router.py  (PreToolUse * matcher -- the deadlock source)
#        permission-notify.py  (PostToolUse notifier)
#        grant-approval.py      (invoked out-of-band by Orin; kept in sync so
#                                the runtime path is available branch-immune)
#   2a) Rewrite the router + notify command paths from the repo path to the
#       ~/.claude/hooks/ path -- in the USER-GLOBAL ~/.claude/settings.json ONLY.
#       Only those two exact commands are touched; every other hook is left
#       untouched.
#   2b) STRIP the '*' permission-router from each sub-agent's agent-local
#       settings.json. The router must run EXACTLY ONCE per tool call. Every
#       sub-agent process inherits the user-global settings.json (Claude Code
#       layers user settings over the cwd's project settings), so the router
#       there already covers them. A duplicate in the agent-local file runs the
#       router a SECOND time; the router consumes each grant single-use, so the
#       2nd run sees an emptied store and denies -> permanent grant-loop (the
#       recurring dupla-router incident). permission-notify.py is PostToolUse
#       and not single-use, so it is left untouched.
#
# grant-approval.py is not wired as a hook in any settings.json (Orin runs it
# from the router's instruction string), so it is copied but no settings path
# is rewritten for it.
#
# Idempotent: safe to re-run. Copies only on md5 mismatch; the user-global
# rewrite is a no-op once the path already points at ~/.claude/hooks/; the
# sub-agent strip is a no-op once no permission-router remains agent-locally.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC_DIR="$ROOT/scripts/hooks"
RUNTIME_DIR="$HOME/.claude/hooks"

CRITICAL_HOOKS=(permission-router.py permission-notify.py grant-approval.py)
# Hooks whose settings.json command path must be rewritten to the runtime dir.
SETTINGS_REWRITE_HOOKS=(permission-router.py permission-notify.py)

# The router lives ONLY in user-global (every sub-agent inherits it); this is
# the sole file whose router/notify path is rewritten to the runtime dir.
USER_SETTINGS="$HOME/.claude/settings.json"
# Sub-agent agent-local settings.json files: the '*' permission-router is
# STRIPPED from these (they inherit it from USER_SETTINGS) so it never
# double-registers -> grant-loop.
SUBAGENT_SETTINGS=(
  "$ROOT/agents/atlas/.claude/settings.json"
  "$ROOT/agents/dex/.claude/settings.json"
  "$ROOT/agents/nova/.claude/settings.json"
  "$ROOT/agents/iris/.claude/settings.json"
)

mkdir -p "$RUNTIME_DIR"

# --- 1) copy hooks into runtime dir -----------------------------------------
for hook in "${CRITICAL_HOOKS[@]}"; do
  src="$SRC_DIR/$hook"
  dst="$RUNTIME_DIR/$hook"
  if [ ! -f "$src" ]; then
    echo "❌ Source hook not found: $src" >&2
    exit 1
  fi
  if [ -f "$dst" ] && cmp -s "$src" "$dst"; then
    echo "⊙ $hook already up to date in $RUNTIME_DIR"
  else
    cp "$src" "$dst"
    echo "✓ copied $hook -> $RUNTIME_DIR"
  fi
  chmod +x "$dst"
done

# --- 2a) rewrite router + notify command paths -- USER-GLOBAL ONLY ----------
if [ ! -f "$USER_SETTINGS" ]; then
  echo "⊙ user-global settings not found, skipping rewrite: $USER_SETTINGS"
else
  changed=0
  for hook in "${SETTINGS_REWRITE_HOOKS[@]}"; do
    old="$SRC_DIR/$hook"
    new="$RUNTIME_DIR/$hook"
    if grep -qF "$old" "$USER_SETTINGS"; then
      # In-place replace of the exact repo path with the runtime path.
      python3 - "$USER_SETTINGS" "$old" "$new" <<'PYEOF'
import sys
path, old, new = sys.argv[1:4]
with open(path) as f:
    data = f.read()
data2 = data.replace(old, new)
if data2 != data:
    with open(path, 'w') as f:
        f.write(data2)
PYEOF
      echo "✓ $USER_SETTINGS: $hook path -> runtime"
      changed=1
    fi
  done
  [ "$changed" -eq 0 ] && echo "⊙ $USER_SETTINGS: router/notify already runtime (or absent)"
fi

# --- 2b) strip the '*' permission-router from SUB-AGENT settings ------------
# A sub-agent inherits the router from user-global; a duplicate here runs it a
# second time and consumes the grant single-use -> grant-loop. Remove any
# permission-router hook (any path) from the agent-local PreToolUse block,
# dropping a group left empty. Unparseable files are never rewritten.
for settings in "${SUBAGENT_SETTINGS[@]}"; do
  if [ ! -f "$settings" ]; then
    echo "⊙ settings not found, skipping: $settings"
    continue
  fi
  status="$(python3 - "$settings" <<'PYEOF'
import json, sys
path = sys.argv[1]
try:
    with open(path) as f:
        data = json.load(f)
except Exception:
    print("unparseable (left untouched)"); sys.exit(0)
hooks = data.get("hooks")
pre = hooks.get("PreToolUse") if isinstance(hooks, dict) else None
status = "clean (no router)"
if isinstance(pre, list):
    kept_groups = []
    changed = False
    for g in pre:
        if not isinstance(g, dict) or not isinstance(g.get("hooks"), list):
            kept_groups.append(g); continue
        kept = [h for h in g["hooks"]
                if not (isinstance(h, dict) and isinstance(h.get("command"), str)
                        and "permission-router.py" in h["command"])]
        if len(kept) == len(g["hooks"]):
            kept_groups.append(g)
        else:
            changed = True
            if kept:
                g2 = dict(g); g2["hooks"] = kept; kept_groups.append(g2)
            # else: group emptied by the strip -> drop it
    if changed:
        hooks["PreToolUse"] = kept_groups
        with open(path, "w") as f:
            json.dump(data, f, indent=2)
        status = "router stripped"
print(status)
PYEOF
)"
  echo "✓ $settings: $status"
done

echo "✓ install-critical-hooks: done."
