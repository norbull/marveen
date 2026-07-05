#!/usr/bin/env bash
# nyx-draft.sh -- thin wrapper around scripts/local-codegen.py (the "Nyx" local
# Qwen2.5-Coder drafter on the GPU). Resolves a prompt from a FILE, a literal
# ARG, or STDIN, then hands it to the Python helper which calls Ollama and prints
# the draft to stdout (timing to stderr). The draft is NEVER final -- a Claude
# agent must review it before use.
#
# Usage:
#   nyx-draft.sh prompt.txt                 # prompt read from a file
#   nyx-draft.sh "Write a function that..." # prompt given literally
#   echo "Write a..." | nyx-draft.sh        # prompt read from stdin
#   nyx-draft.sh --temp 0.3 prompt.txt      # flags forwarded to local-codegen.py
set -euo pipefail

# Resolve the directory of this script, following a symlink when realpath exists.
src="${BASH_SOURCE[0]}"
if command -v realpath >/dev/null 2>&1; then
  src="$(realpath "$src")"
fi
SCRIPT_DIR="$(cd "$(dirname "$src")" && pwd)"
HELPER="$SCRIPT_DIR/local-codegen.py"

usage() {
  cat <<'EOF'
Usage: nyx-draft.sh [--model M] [--temp T] [--timeout N] [PROMPT|FILE]
  PROMPT|FILE   if a readable file path -> prompt is its contents;
                else the argument is the literal prompt; if omitted -> read stdin.
  Flags (--model/--temp/--timeout) are forwarded to local-codegen.py.
Output: drafted code on stdout, timing on stderr. REVIEW the draft before use.
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
    --model|--temp|--timeout)
      # These local-codegen.py options take a value -> consume the next token too.
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
