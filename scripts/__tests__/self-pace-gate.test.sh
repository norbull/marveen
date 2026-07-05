#!/usr/bin/env bash
# Tests for scripts/self-pace-gate.mjs payload-vs-command classification.
set -euo pipefail
cd "$(dirname "$0")/../.."

run_gate() {
  local cmd="$1"
  printf '%s' "$cmd" |
    node -e 'const fs = require("node:fs"); const command = fs.readFileSync(0, "utf8"); process.stdout.write(JSON.stringify({tool_name:"Bash",tool_input:{command}}));' |
    node scripts/self-pace-gate.mjs
}

is_denied() {
  local cmd="$1"
  local out
  out="$(run_gate "$cmd")"
  [[ "$out" == *'"permissionDecision":"deny"'* ]]
}

expect_allow() {
  local name="$1"
  local cmd="$2"
  if is_denied "$cmd"; then
    echo "FAIL | $name | expected allow, got deny"
    return 1
  fi
  echo "PASS | $name | expected allow"
}

expect_deny() {
  local name="$1"
  local cmd="$2"
  if is_denied "$cmd"; then
    echo "PASS | $name | expected deny"
    return 0
  fi
  echo "FAIL | $name | expected deny, got allow"
  return 1
}

FP_CURL_HEREDOC="$(cat <<'EOF'
curl -s -X POST http://localhost:3420/api/kanban/xyz/comments -d @- <<'PAYLOAD'
{"content":"discusses tmux send-keys as a TOPIC, not as an invocation"}
PAYLOAD
EOF
)"

FP_GIT_COMMIT_HEREDOC="$(cat <<'EOF'
git commit -m "$(cat <<'MSG'
fix: stop flagging tmux send-keys mentions in commit messages
MSG
)"
EOF
)"

TP_BASH_HEREDOC="$(cat <<'EOF'
bash <<'SCRIPT'
tmux send-keys -t agent-x 'hi' Enter
SCRIPT
EOF
)"

TP_PYTHON_HEREDOC="$(cat <<'EOF'
python3 <<'PY'
print("tmux send-keys -t agent-x hi Enter")
PY
EOF
)"

TP_PAYLOAD_THEN_REAL_TMUX="$(cat <<'EOF'
curl -s -X POST http://localhost:3420/api/kanban/xyz/comments -d @- <<'PAYLOAD'
{"content":"tmux send-keys as prose only"}
PAYLOAD
tmux send-keys -t agent-x 'hi' Enter
EOF
)"

TP_PAYLOAD_THEN_BASH_HEREDOC="$(cat <<'EOF'
curl -s -X POST http://127.0.0.1:3420/api/kanban/xyz/comments --data-binary @- <<'PAYLOAD'
{"content":"tmux send-keys as prose only"}
PAYLOAD
bash <<'SCRIPT'
tmux send-keys -t agent-x 'hi' Enter
SCRIPT
EOF
)"

TP_SCHEDULES_POST="curl -s -X POST http://localhost:3420/api/schedules -d '{}'"

failed=0
expect_allow "fp: own API curl heredoc prose" "$FP_CURL_HEREDOC" || failed=1
expect_allow "fp: git commit -m heredoc prose" "$FP_GIT_COMMIT_HEREDOC" || failed=1
expect_deny "tp: bash heredoc remains executable input" "$TP_BASH_HEREDOC" || failed=1
expect_deny "tp: python heredoc remains visible" "$TP_PYTHON_HEREDOC" || failed=1
expect_deny "tp: prose heredoc followed by real tmux" "$TP_PAYLOAD_THEN_REAL_TMUX" || failed=1
expect_deny "tp: later bash heredoc remains visible" "$TP_PAYLOAD_THEN_BASH_HEREDOC" || failed=1
expect_deny "tp: plain schedules POST still blocks" "$TP_SCHEDULES_POST" || failed=1

if [[ "$failed" -ne 0 ]]; then
  exit 1
fi
echo "self-pace-gate.test.sh: OK"
