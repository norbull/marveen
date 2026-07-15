#!/usr/bin/env bash
# Ops-hook self-heal guard (kanban #106).
#
# Guarantees the critical fork-only ops files exist AND are the real versions
# (not a stub / truncated copy). If one is missing or looks like a stub, it is
# restored from the `develop` branch (git checkout develop -- <path>).
#
# ROOT CAUSE this defends against: the main marveen tree once switched to a
# PR/upstream branch (feat/graphify) that does not carry the 58 fork-only ops
# files -> the checkout deleted them from disk mid-run, the PreToolUse
# permission-router vanished, and every agent tool call deadlocked (silent
# Telegram). See install-critical-hooks.sh (the runtime-copy prevention) and
# memory upstream-branch-switch-deletes-hooks-deadlock.
#
# This script is the detection + repair half:
#   1) Self-heal: check each critical ops file, restore from develop on miss/stub.
#   2) Worktree-guard: warn if the main tree is on a detached HEAD / upstream ref
#      (the exact state that strips the fork-only files).
#
# SAFETY: a file is only restored when MISSING or a STUB (line count below a
# per-file floor). A real file that merely differs from develop (e.g. an active
# router refactor on a feature branch) is left untouched -- this never clobbers
# legit work, it only rescues a deadlock.
#
# Idempotent + boot/cron/timer-safe. No -e: one file's failure must not abort
# the sweep. Always exits 0 so a scheduler never flaps on it.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$ROOT/logs"
LOG="$LOG_DIR/ops-hook-selfheal.log"
mkdir -p "$LOG_DIR"

healed=0
failed=0

ts()   { date '+%Y-%m-%d %H:%M:%S'; }
log()  { echo "[$(ts)] $*"    | tee -a "$LOG" >&2; }
ok()   { echo "[$(ts)] OK   $*" >> "$LOG"; }
warn() { echo "[$(ts)] WARN $*" | tee -a "$LOG" >&2; }
err()  { echo "[$(ts)] ERR  $*" | tee -a "$LOG" >&2; }

# --- critical fork-only files: "relpath|min_lines|kind" ----------------------
# kind: regular = restore via git checkout; symlink = expect a symlink whose
# target is a real file (runtime pull-model), never overwrite the link content.
# min_lines is a stub floor, well below the real size, well above a passthrough
# stub (~7 lines). Extend this list for more fleet-critical scripts.
CRITICAL=(
  "scripts/hooks/permission-router.py|100|regular"   # real ~606, deadlock source
  "scripts/hooks/grant-approval.py|30|regular"       # real ~77
  "scripts/hooks/telegram-reply-guard.py|80|regular" # real ~210
  "scripts/hooks/permission-notify.py|20|regular"    # real ~47
  "scripts/hooks/channel-inbox-drain.py|50|symlink"  # symlink -> ~/.claude/hooks (real ~204)
)

# Restore a path from develop without leaving it staged in the main tree's
# index (the main tree may be on a live feature branch mid-edit).
restore_from_develop() {
  local relpath="$1"
  if ! git -C "$ROOT" cat-file -e "develop:$relpath" 2>/dev/null; then
    err "$relpath not present in develop either -- cannot restore"
    failed=$((failed + 1))
    return 1
  fi
  if git -C "$ROOT" checkout develop -- "$relpath" 2>/dev/null; then
    git -C "$ROOT" reset -q HEAD -- "$relpath" 2>/dev/null || true
    healed=$((healed + 1))
    warn "RESTORED $relpath from develop"
    return 0
  fi
  err "$relpath restore FAILED (git checkout)"
  failed=$((failed + 1))
  return 1
}

check_regular() {
  local relpath="$1" min="$2" abs="$ROOT/$1"
  if [ -f "$abs" ] && [ ! -L "$abs" ]; then
    local n; n=$(wc -l < "$abs" 2>/dev/null || echo 0)
    if [ "$n" -ge "$min" ]; then
      ok "$relpath ($n lines)"
      return 0
    fi
    warn "$relpath STUB/truncated ($n lines < $min) -> restore"
  elif [ -L "$abs" ]; then
    warn "$relpath is a symlink but a regular file is expected -> restore"
  else
    warn "$relpath MISSING -> restore"
  fi
  restore_from_develop "$relpath"
}

# Symlink hook (channel-inbox-drain): the repo entry must be a symlink; its
# target must be a real file. A missing/converted link is git-restorable; a
# broken/stub TARGET is not (git only restores the link, not the pointee) and
# is escalated to the sub-agent-channel-recovery skill's territory.
check_symlink() {
  local relpath="$1" min="$2" abs="$ROOT/$1"
  if [ -L "$abs" ]; then
    if [ -e "$abs" ]; then
      local n; n=$(wc -l < "$abs" 2>/dev/null || echo 0)
      if [ "$n" -ge "$min" ]; then
        ok "$relpath -> $(readlink "$abs") ($n lines)"
        return 0
      fi
      warn "$relpath symlink TARGET truncated ($n lines < $min) -- run sub-agent-channel-recovery; git checkout will NOT fix the target"
      failed=$((failed + 1))
      return 1
    fi
    warn "$relpath BROKEN symlink (target gone: $(readlink "$abs")) -- run sub-agent-channel-recovery; git checkout will NOT fix the target"
    failed=$((failed + 1))
    return 1
  fi
  # Not a symlink (lost or replaced by a regular stub) -> git restores the link.
  warn "$relpath is not a symlink (expected one) -> restore link from develop"
  restore_from_develop "$relpath"
}

# --- worktree-guard: is the main tree in the danger zone? --------------------
worktree_guard() {
  local br; br="$(git -C "$ROOT" branch --show-current 2>/dev/null || true)"
  if [ -z "$br" ]; then
    local head; head="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo '?')"
    warn "WORKTREE-GUARD: main tree is on a DETACHED HEAD ($head) -- typical of a PR/upstream checkout that strips fork-only files. Self-heal is active; switch back with: git checkout develop"
  elif [ "$br" = "develop" ]; then
    ok "WORKTREE-GUARD: main tree on develop"
  else
    log "WORKTREE-GUARD: main tree on '$br' (not develop). Fine for a local feature branch; self-heal keeps the hooks alive regardless."
  fi
}

# --- run --------------------------------------------------------------------
log "ops-hook-selfheal start (ROOT=$ROOT)"
worktree_guard

for entry in "${CRITICAL[@]}"; do
  IFS='|' read -r relpath min kind <<< "$entry"
  case "$kind" in
    symlink) check_symlink "$relpath" "$min" ;;
    *)       check_regular "$relpath" "$min" ;;
  esac
done

# If anything was restored, refresh the branch-immune runtime copies too so the
# ~/.claude/hooks/ path (used by the settings.json hook commands) matches.
# SELFHEAL_NO_RUNTIME_SYNC=1 skips this (tests, dry runs against a non-live tree).
if [ "$healed" -gt 0 ] && [ "${SELFHEAL_NO_RUNTIME_SYNC:-0}" != "1" ] \
   && [ -x "$ROOT/scripts/install-critical-hooks.sh" ]; then
  log "healed=$healed -> refreshing runtime hook copies (install-critical-hooks.sh)"
  bash "$ROOT/scripts/install-critical-hooks.sh" >> "$LOG" 2>&1 \
    || warn "install-critical-hooks.sh returned non-zero (continuing)"
fi

log "ops-hook-selfheal done (healed=$healed failed=$failed)"
exit 0
