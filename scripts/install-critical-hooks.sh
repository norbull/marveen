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
#   2) Rewrite the router + notify command paths in the fleet settings.json
#      files from the repo path to the ~/.claude/hooks/ path. Only those two
#      exact commands are touched; every other hook is left untouched.
#
# grant-approval.py is not wired as a hook in any settings.json (Orin runs it
# from the router's instruction string), so it is copied but no settings path
# is rewritten for it.
#
# Idempotent: safe to re-run. Copies only on md5 mismatch; settings rewrite is
# a no-op once the path already points at ~/.claude/hooks/.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC_DIR="$ROOT/scripts/hooks"
RUNTIME_DIR="$HOME/.claude/hooks"

CRITICAL_HOOKS=(permission-router.py permission-notify.py grant-approval.py)
# Hooks whose settings.json command path must be rewritten to the runtime dir.
SETTINGS_REWRITE_HOOKS=(permission-router.py permission-notify.py)

SETTINGS_FILES=(
  "$HOME/.claude/settings.json"
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

# --- 2) rewrite router + notify command paths in settings.json --------------
for settings in "${SETTINGS_FILES[@]}"; do
  if [ ! -f "$settings" ]; then
    echo "⊙ settings not found, skipping: $settings"
    continue
  fi
  changed=0
  for hook in "${SETTINGS_REWRITE_HOOKS[@]}"; do
    old="$SRC_DIR/$hook"
    new="$RUNTIME_DIR/$hook"
    if grep -qF "$old" "$settings"; then
      # In-place replace of the exact repo path with the runtime path.
      python3 - "$settings" "$old" "$new" <<'PYEOF'
import sys
path, old, new = sys.argv[1:4]
with open(path) as f:
    data = f.read()
data2 = data.replace(old, new)
if data2 != data:
    with open(path, 'w') as f:
        f.write(data2)
PYEOF
      echo "✓ $settings: $hook path -> runtime"
      changed=1
    fi
  done
  [ "$changed" -eq 0 ] && echo "⊙ $settings: router/notify already runtime (or absent)"
done

echo "✓ install-critical-hooks: done."
