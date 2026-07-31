#!/usr/bin/env bash
# openrouter-draft.sh -- thin wrapper around scripts/openrouter-draft.py, the
# OpenRouter free-layer draft tool. A PLUS tool next to nyx-draft.sh (local
# Qwen, first stop) and codex-draft.sh -- it does NOT replace them and no
# default workflow routes here. Dex-only pilot.
#
# Same contract as nyx-draft.sh: resolve a prompt from a FILE, a literal ARG, or
# STDIN, hand it to the Python helper (which calls OpenRouter and prints the
# draft to stdout, meta to stderr). The draft is NEVER final -- a Claude agent
# must review it before use.
#
# Usage:
#   openrouter-draft.sh prompt.txt                  # prompt read from a file
#   openrouter-draft.sh "Write a function that..."  # prompt given literally
#   echo "Write a..." | openrouter-draft.sh         # prompt read from stdin
#   openrouter-draft.sh --model dex_code_fallback prompt.txt
#   openrouter-draft.sh --list                      # print alias table, exit
set -euo pipefail

# Resolve the directory of this script, following a symlink when realpath exists.
src="${BASH_SOURCE[0]}"
if command -v realpath >/dev/null 2>&1; then
  src="$(realpath "$src")"
fi
SCRIPT_DIR="$(cd "$(dirname "$src")" && pwd)"
HELPER="$SCRIPT_DIR/openrouter-draft.py"

usage() {
  cat <<'EOF'
Usage: openrouter-draft.sh [--model ALIAS] [--temp T] [--timeout N] [--list] [PROMPT|FILE]
  PROMPT|FILE   if a readable file path -> prompt is its contents;
                else the argument is the literal prompt; if omitted -> read stdin.
  --model       alias (dex_code_primary, ...) or full vendor/model id
  --list        print the resolved alias table and exit
  Flags (--model/--temp/--timeout/--list) are forwarded to openrouter-draft.py.
Output: drafted artifact on stdout, meta on stderr. REVIEW the draft before use.
EOF
}

# Separate forwarded flags (with their values) from the single prompt token.
passthrough=()
prompt_src=""
have_src=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage; exit 0 ;;
    --list)
      passthrough+=("$1"); shift ;;
    --model|--temp|--timeout)
      # These openrouter-draft.py options take a value -> consume the next token.
      passthrough+=("$1")
      if [[ $# -ge 2 ]]; then passthrough+=("$2"); shift; fi
      shift ;;
    --*=*)
      passthrough+=("$1"); shift ;;
    -*)
      passthrough+=("$1"); shift ;;
    *)
      if [[ $have_src -eq 0 ]]; then prompt_src="$1"; have_src=1; fi
      shift ;;
  esac
done

command -v python3 >/dev/null 2>&1 || { echo "error: python3 not found" >&2; exit 1; }
[[ -f "$HELPER" ]] || { echo "error: helper not found: $HELPER" >&2; exit 1; }

# --list needs no prompt -> forward straight through.
for arg in "${passthrough[@]:-}"; do
  if [[ "$arg" == "--list" ]]; then
    exec python3 "$HELPER" "${passthrough[@]}"
  fi
done

# Resolve the prompt: existing file -> contents; non-empty arg -> literal; else stdin.
if [[ $have_src -eq 1 && -r "$prompt_src" && -f "$prompt_src" ]]; then
  prompt="$(cat "$prompt_src")"
elif [[ $have_src -eq 1 ]]; then
  prompt="$prompt_src"
else
  prompt="$(cat)"
fi

# Empty after stripping all whitespace -> nothing to draft.
if [[ -z "${prompt//[[:space:]]/}" ]]; then
  echo "error: empty prompt" >&2
  exit 2
fi

# Forward to the helper; its exit code becomes ours (set -e propagates failures).
printf '%s' "$prompt" | python3 "$HELPER" "${passthrough[@]}"
