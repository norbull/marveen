#!/usr/bin/env bash
# Idempotent installer: wire the telegram-reply-guard Stop hook into the
# user-level ~/.claude/settings.json. Auto-run by scripts/sync-hooks.sh on update.
#
# The guard fires when a Telegram inbound turn ends without a channel send and
# injects a one-shot reminder to actually send the reply (kanban #66381411).
# See scripts/hooks/telegram-reply-guard.py for the full design.
#
# The hook is referenced in place under scripts/hooks/ (matching the
# permission-router / staleness-guard convention) so it tracks the repo — no
# copy into ~/.claude/hooks/ is needed.
#
# Idempotent: safe to re-run. Disable at runtime with MARVEEN_DISABLE_REPLY_GUARD=1.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOK="$ROOT/scripts/hooks/telegram-reply-guard.py"
SETTINGS="$HOME/.claude/settings.json"

if [ ! -f "$HOOK" ]; then
  echo "❌ Source hook not found: $HOOK" >&2
  exit 1
fi

PY="$(command -v python3 || true)"
if [ -z "$PY" ]; then
  echo "❌ python3 not found in PATH" >&2
  exit 1
fi

if [ ! -f "$SETTINGS" ]; then
  echo '{"hooks":{}}' > "$SETTINGS"
fi

"$PY" - "$SETTINGS" "$PY" "$HOOK" <<'PYEOF'
import json, sys

settings_path, py, hook = sys.argv[1:4]
command = f"{py} {hook}"

with open(settings_path) as f:
    cfg = json.load(f)
hooks = cfg.setdefault('hooks', {})

def has_command(group_list, cmd):
    for g in group_list:
        for h in g.get('hooks', []):
            if h.get('command') == cmd:
                return True
    return False

stop = hooks.setdefault('Stop', [])
if has_command(stop, command):
    print("⊙ settings.json already has the telegram-reply-guard Stop hook — skipping")
    sys.exit(0)

# Append to the first matcher-less Stop group, or create one.
grp = next((g for g in stop if 'matcher' not in g), None)
if grp is None:
    grp = {'hooks': []}
    stop.append(grp)
grp.setdefault('hooks', []).append(
    {'type': 'command', 'command': command, 'timeout': 15})

with open(settings_path, 'w') as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
print("✓ settings.json Stop hook patched (telegram-reply-guard)")
PYEOF

echo "✓ telegram-reply-guard: Stop hook installed."
