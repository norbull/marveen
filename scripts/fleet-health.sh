#!/usr/bin/env bash
# Fleet health summary -- 6th pane of fleet.sh
# Shows: service state, token refresh, pending messages, in-progress kanban

MARVEEN_DIR="$HOME/marveen"
TOKEN=$(cat "$MARVEEN_DIR/store/.dashboard-token" 2>/dev/null)
BASE="http://localhost:3420"

echo "=== FLEET HEALTH  $(date '+%H:%M:%S') ==="
echo

# Service
SVC_STATUS=$(systemctl --user is-active orin-dashboard.service 2>/dev/null)
if [ "$SVC_STATUS" = "active" ]; then
  echo "  service : OK (orin-dashboard)"
else
  echo "  service : ** $SVC_STATUS **"
fi

# Token refresh
echo
echo "--- Token ---"
LAST_REFRESH=$(grep -h "proactive refresh succeeded\|refresh succeeded" \
  "$HOME/.local/share/claude-daemon/daemon.log" \
  "$MARVEEN_DIR/store/daemon.log" 2>/dev/null | tail -1)
if [ -n "$LAST_REFRESH" ]; then
  echo "  $LAST_REFRESH" | sed 's/.*\([0-9][0-9]:[0-9][0-9]:[0-9][0-9]\).*/  last refresh: \1/'
else
  echo "  (no refresh log found)"
fi

# Pending agent messages
echo
echo "--- Messages ---"
PENDING=$(curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/messages?status=pending" 2>/dev/null \
  | python3 -c "
import json,sys
try:
    d = json.load(sys.stdin)
    msgs = d if isinstance(d, list) else d.get('messages', [])
    print(f'  pending : {len(msgs)}')
except:
    print('  pending : ?')
" 2>/dev/null)
echo "${PENDING:-  pending : ?}"

# In-progress kanban
echo
echo "--- Kanban in_progress ---"
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/kanban" 2>/dev/null \
  | python3 -c "
import json,sys
try:
    cards = json.load(sys.stdin)
    ip = [c for c in cards if c['status']=='in_progress' and not c.get('archived_at')]
    if not ip:
        print('  (none)')
    for c in ip:
        a = c.get('assignee') or '?'
        t = c['title'][:45]
        print(f'  [{a}] {t}')
except Exception as e:
    print(f'  (error: {e})')
" 2>/dev/null

# Agents running
echo
echo "--- Sessions ---"
tmux list-sessions -F '  #{session_name}' 2>/dev/null | grep -E "agent-|orin-channels" || echo "  (none)"

# Backend log tail (Iris: channel-coordinator errors land here first)
echo
echo "--- Backend errors (utolsó 5 sor) ---"
tail -5 "$MARVEEN_DIR/store/dashboard.error.log" 2>/dev/null | sed 's/^/  /' || echo "  (üres)"
