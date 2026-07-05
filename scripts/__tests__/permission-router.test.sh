#!/usr/bin/env bash
# Tests for scripts/hooks/permission-router.py classification (kanban 4b4d0e5a).
# Exercises clean_cmd() + is_critical() directly (no dashboard, no approvals I/O).
set -euo pipefail
cd "$(dirname "$0")/../.."

python3 - <<'PYEOF'
import importlib.util
import sys

spec = importlib.util.spec_from_file_location(
    "permission_router", "scripts/hooks/permission-router.py")
pr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pr)

def critical(cmd):
    return pr.is_critical("Bash", {"command": cmd}) is not None

FP_HEREDOC = """cd /home/karma/marveen && curl -s -X POST http://localhost:3420/api/messages \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $(cat store/.dashboard-token)" \\
  -d @- <<'EOF'
{"from":"dex","to":"orin","content":"tmux kill-session kell, sudo mar nem; systemctl restart temakent emlitve; rm -rf szoba kerult"}
EOF
echo"""

FP_KANBAN = """curl -s -X POST "http://localhost:3420/api/kanban/f130d597/comments" \\
  -H "Authorization: Bearer $(cat store/.dashboard-token)" \\
  -d @- <<'EOF'
{"author":"dex","content":"uv telepitve sudo nelkul; kill/pkill temak"}
EOF"""

FP_FLEET = 'python3 seed-skills/fleet-helper/scripts/fleet.py msg dex orin "sudo probe mar nem kell, tmux kill-session grant kene, git push majd kesobb"'

FP_SENDKEYS = 'tmux send-keys -t orin-channels -l " -- [Uzenet @dex-tol]: a sudo grant felesleges, a kill-session kene" && tmux send-keys -t orin-channels Enter'

cases = [
    # (name, command, expect_critical)
    ("fp: curl heredoc sajat API (messages)", FP_HEREDOC, False),
    ("fp: curl heredoc sajat API (kanban comments)", FP_KANBAN, False),
    ("fp: fleet.py msg szoveges payload", FP_FLEET, False),
    ("fp: tmux send-keys -l fleet sessionbe", FP_SENDKEYS, False),
    ("fp: inline -d payload sajat API (572d9b1 regressziozar)",
     "curl -s -X POST http://localhost:3420/api/memories -d '{\"content\":\"systemctl restart tanulsag\"}'", False),
    # true positives -- the guard must keep firing on these
    ("tp: sudo", "sudo apt install poppler-utils", True),
    ("tp: rm -rf", "rm -rf /home/karma/marveen/store", True),
    ("tp: git push", "git push origin develop", True),
    ("tp: kill parancskent", "kill -9 12345", True),
    ("tp: bash heredoc sudo-val (nincs sajat-API curl)",
     "bash <<'EOF'\nsudo rm -rf /\nEOF", True),
    ("tp: kulso hostra curl heredoc sudo-val",
     "curl -X POST https://example.com/api -d @- <<'EOF'\nsudo rm -rf /\nEOF", True),
    ("tp: send-keys NEM fleet sessionbe kritikus szoveggel",
     "tmux send-keys -t random-shell -l 'sudo rm -rf /' Enter", True),
    ("tp: heredoc-strip utan is kritikus a vaz",
     "curl http://localhost:3420/api/messages -d @- <<'EOF'\n{}\nEOF\nsudo reboot", True),
    ("tp: systemctl restart parancskent", "systemctl restart orin-dashboard", True),
    # 4th shape: commit message prose mentioning critical words as topics
    ("fp: git commit -m heredoc uzenettel",
     "git commit -m \"$(cat <<'EOF'\nfix: stop flagging sudo/kill/rm -rf words in payload text\nEOF\n)\"", False),
    ("tp: git commit heredoc utan sudo a vazban",
     "git commit -m \"$(cat <<'EOF'\nharmless\nEOF\n)\" && sudo reboot", True),
]

def wcritical(tool, path):
    return pr.is_critical(tool, {"file_path": path}) is not None

write_cases = [
    ("tp: Write ~/.claude ala", "Write", "/home/karma/.claude/hooks/evil.py", True),
    ("tp: Edit agent settings.json (permission profil)", "Edit",
     "/home/karma/marveen/agents/dex/.claude/settings.json", True),
    ("tp: Write /etc ala", "Write", "/etc/environment", True),
    ("tp: Edit .ssh", "Edit", "/home/karma/.ssh/authorized_keys", True),
    ("fp: Write projekt-fajl", "Write", "/home/karma/marveen/scripts/foo.sh", False),
    ("fp: Write agent memoria (.claude-config)", "Write",
     "/home/karma/marveen/agents/dex/.claude-config/projects/x/memory/y.md", False),
    ("fp: Write scratchpad", "Write", "/tmp/claude-1000/x/scratchpad/f.py", False),
]

PROCSUB = ("curl -s -X POST http://localhost:3420/api/messages "
           "--data-binary @<(printf '%s' 'statusz: sudo mar nem kell, kill-session kene')")
PROCSUB_EXEC = ("curl -s -X POST http://localhost:3420/api/messages "
                "--data-binary @<(sudo cat /etc/shadow)")
cases += [
    ("fp: --data-binary @<(printf 'szoveg') sajat API-ra", PROCSUB, False),
    ("tp: @<(sudo cat ...) valodi vegrehajtas a substitutionben", PROCSUB_EXEC, True),
]

failed = 0
for name, tool, path, expect in [(n, t, p, e) for n, t, p, e in write_cases]:
    got = wcritical(tool, path)
    ok = got == expect
    print(("PASS" if ok else "FAIL"), "|", name, "| expected critical =", expect, "got", got)
    if not ok:
        failed += 1

for name, cmd, expect in cases:
    got = critical(cmd)
    ok = got == expect
    print(("PASS" if ok else "FAIL"), "|", name, "| expected critical =", expect, "got", got)
    if not ok:
        failed += 1

sys.exit(1 if failed else 0)
PYEOF
echo "permission-router.test.sh: OK"
