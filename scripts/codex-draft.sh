#!/usr/bin/env bash
# codex-draft.sh -- thin wrapper around the OpenAI Codex CLI's headless
# `codex exec` mode, the second draft tool next to nyx-draft.sh (kanban
# b6a0ea24). Same contract as Nyx: the output is a DRAFT and a Claude agent
# (dex) MUST review it before anything ships.
#
# Division of labor (Norbi/Orin decision, 2026-07-04):
#   - Nyx  (nyx-draft.sh): local Qwen2.5-Coder on the GPU, free -> bulk /
#     boilerplate / single-function drafts, output on stdout.
#   - Codex (this): runs on Norbi's ChatGPT Plus quota (finite!) -> reserve for
#     BIGGER, genuinely multi-step tasks on a real workspace (it edits files,
#     git-aware). The deliverable is the resulting git diff, which dex/Orin
#     review before merge.
#
# Usage:
#   codex-draft.sh task.txt                     # task read from a file
#   codex-draft.sh "Refactor X to do Y..."      # task given literally
#   echo "task" | codex-draft.sh                # task read from stdin
#   codex-draft.sh --dir /path/to/worktree task.txt   # workspace (default: cwd)
#   codex-draft.sh --read-only "Analyze..."     # no file edits, answer only
#   codex-draft.sh --model gpt-5-codex task.txt # model override
#
# Auth: one-time `codex login` with Norbi's ChatGPT account (interactive,
# browser). This wrapper refuses to run unauthenticated instead of burning a
# confusing failure inside the agent loop.
set -euo pipefail

CODEX_BIN="${CODEX_BIN:-$HOME/.local/bin/codex}"

usage() {
  cat <<'EOF'
Usage: codex-draft.sh [--dir DIR] [--model M] [--read-only] [PROMPT|FILE]
  PROMPT|FILE   if a readable file path -> task is its contents;
                else the argument is the literal task; if omitted -> read stdin.
  --dir DIR     workspace codex works in (default: current directory)
  --model M     model override (default: codex CLI's configured default)
  --read-only   sandbox=read-only: no file edits, analysis/draft to stdout only
Output: codex's final message on stdout; on workspace-write runs the git diff
of DIR is the actual deliverable. REVIEW the diff before anything ships.
EOF
}

workdir="$PWD"
model=""
sandbox="workspace-write"
prompt_src=""
have_src=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --dir)   workdir="${2:?--dir needs a value}"; shift 2 ;;
    --model) model="${2:?--model needs a value}"; shift 2 ;;
    --read-only) sandbox="read-only"; shift ;;
    -*) echo "error: unknown flag: $1" >&2; usage >&2; exit 2 ;;
    *)
      if [[ $have_src -eq 0 ]]; then prompt_src="$1"; have_src=1; fi
      shift ;;
  esac
done

[[ -x "$CODEX_BIN" ]] || { echo "error: codex CLI not found at $CODEX_BIN (set CODEX_BIN or install to ~/.local/bin/codex)" >&2; exit 1; }
[[ -d "$workdir" ]] || { echo "error: workspace dir does not exist: $workdir" >&2; exit 1; }

# Refuse unauthenticated: `codex login` is a one-time interactive step on
# Norbi's ChatGPT Plus account; failing here with a clear message beats a
# cryptic mid-run error.
if ! "$CODEX_BIN" login status >/dev/null 2>&1; then
  echo "error: codex is not logged in. One-time setup: run \`codex login\` (Norbi's ChatGPT Plus account)." >&2
  exit 3
fi

# Resolve the task: existing file -> contents; non-empty arg -> literal; else stdin.
if [[ $have_src -eq 1 && -r "$prompt_src" && -f "$prompt_src" ]]; then
  prompt="$(cat "$prompt_src")"
elif [[ $have_src -eq 1 ]]; then
  prompt="$prompt_src"
else
  prompt="$(cat)"
fi

if [[ -z "${prompt//[[:space:]]/}" ]]; then
  echo "error: empty task" >&2
  exit 2
fi

# NOTE: `codex exec` is inherently non-interactive -- no --ask-for-approval
# flag exists there (that is the TUI's flag; found out on the first pilot run).
args=(exec --cd "$workdir" --sandbox "$sandbox")
[[ -n "$model" ]] && args+=(--model "$model")

# Plus-quota guard: log every run so usage stays visible (cost_log-style).
echo "[codex-draft] $(date '+%F %T') sandbox=$sandbox dir=$workdir task: $(printf '%s' "$prompt" | head -c 120)" >&2

printf '%s' "$prompt" | "$CODEX_BIN" "${args[@]}" -
rc=$?

# The diff is the deliverable on workspace-write runs -- surface what changed.
if [[ "$sandbox" == "workspace-write" ]] && git -C "$workdir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "--- changed files (REVIEW BEFORE USE): ---" >&2
  git -C "$workdir" status --short >&2 || true
fi
exit $rc
