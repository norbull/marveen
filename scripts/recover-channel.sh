#!/bin/bash
# Channel recovery EXECUTOR for the main channels session (kanban #e601c705).
#
# Spec owner: iris (telegram-watchdog-spec.md). Implemented by dex per fleet
# rule 4+7 (iris specs, dex codes). Called BOTH by the dashboard auto-recovery
# orchestrator (src/web/auto-recovery.ts, channel component) AND, as a fallback,
# by the independent channel-watchdog systemd timer. The two are made race-safe
# by a single flock over the whole recovery-critical section.
#
# Two-stage recovery (escalating):
#   1. respawn-pane (cheap)  -> VERIFY_GRACE -> verify-channels-health.sh
#   2. on verify FAIL, if the pane is IDLE: full `kill-session + new-session
#      --continue` (preserves Orin's conversation) -> FULL_RESTART_GRACE -> verify
#
# Anti-flap: respawn cap (shared with channel-watchdog) + a separate rolling
# full-restart cap. Past the full-restart cap, or on a rate-limit prompt, we do
# NOT restart -- the issue is systemic; we report it and back off.
#
# Idempotent + flock'd, so it is safe to call alongside the systemd timer.
#
# STRUCTURED EXIT CODES (canonical contract, iris<->dex 8.5):
#   0 = recovered   (healthy after action, or already healthy)
#   1 = failed      (acted but still unhealthy)
#   2 = deferred    (pane busy, or another recovery holds the lock -- retry later)
#   3 = systemic    (capped / rate-limited -- caller escalates to Norbi)
#
# Usage: recover-channel.sh [<session>] [--dry-run]
#   <session>  defaults to ${MAIN_AGENT_ID}-channels
#   --dry-run  detect + log what it WOULD do; no respawn/restart, no stamp writes

set -u

EXIT_RECOVERED=0
EXIT_FAILED=1
EXIT_DEFERRED=2
EXIT_SYSTEMIC=3

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STORE="$INSTALL_DIR/store"
LOG_TAG="recover-channel"

# Stamp files -- the respawn ones are shared with channel-watchdog.sh.
RESPAWN_STAMP="$STORE/.channel-last-respawn"
RESPAWN_COUNT_FILE="$STORE/.channel-watchdog-respawns"
FULL_RESTART_FILE="$STORE/.channel-full-restarts"
LOCK_FILE="$STORE/.channel-recovery.lock"

# Tunables (env-overridable; defaults from spec section 4).
VERIFY_GRACE="${VERIFY_GRACE:-20}"
FULL_RESTART_GRACE="${FULL_RESTART_GRACE:-30}"
MAX_CONSECUTIVE="${MAX_CONSECUTIVE:-3}"
MAX_FULL_RESTARTS="${MAX_FULL_RESTARTS:-2}"
FULL_RESTART_WINDOW="${FULL_RESTART_WINDOW:-$(( 60 * 60 ))}"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [$LOG_TAG] $*"; }

# --- args -----------------------------------------------------------------
DRY_RUN=0
SESSION=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -*) log "unknown flag: $arg"; exit "$EXIT_FAILED" ;;
    *) SESSION="$arg" ;;
  esac
done

# --- resolve session (same rule as the other channel scripts) -------------
MAIN_AGENT_ID="$(grep -E '^MAIN_AGENT_ID=' "$INSTALL_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2-)"
MAIN_AGENT_ID="${MAIN_AGENT_ID:-marveen}"
MAIN_AGENT_ID="${MAIN_AGENT_ID//[^a-zA-Z0-9_-]/}"
SESSION="${SESSION:-${MAIN_AGENT_ID}-channels}"

# NB: use TMUX_BIN, not TMUX -- the latter is tmux's own env var (socket,pid,
# session) and overwriting it breaks server detection when this script is run
# from inside a tmux pane (e.g. standalone --dry-run testing).
TMUX_BIN="$(command -v tmux)"
CLAUDE="$(command -v claude)"
VERIFY="$INSTALL_DIR/scripts/verify-channels-health.sh"
if [ -z "$TMUX_BIN" ] || [ -z "$CLAUDE" ]; then
  log "tmux or claude not on PATH; cannot act"
  exit "$EXIT_FAILED"
fi

# --- concurrency: one recovery at a time over the WHOLE section ------------
# Non-blocking: if another recovery (timer or orchestrator) holds the lock,
# defer rather than pile on -- the holder is already doing the work.
exec 200>"$LOCK_FILE" 2>/dev/null || { log "cannot open lock $LOCK_FILE"; exit "$EXIT_DEFERRED"; }
if [ "$DRY_RUN" -eq 0 ]; then
  if ! flock -n 200; then
    log "another recovery holds the lock -- deferring"
    exit "$EXIT_DEFERRED"
  fi
fi

now="$(date +%s)"

# --- verify helper --------------------------------------------------------
verify_healthy() {
  [ -x "$VERIFY" ] || { log "verify script missing/non-exec: $VERIFY"; return 1; }
  "$VERIFY" >/dev/null 2>&1
}

# --- build the claude launch command (respawn and full-restart variants) ---
MAIN_MODEL=""
if [ -f "$INSTALL_DIR/.claude/settings.json" ] && command -v jq >/dev/null 2>&1; then
  MAIN_MODEL="$(jq -r '.model // empty' "$INSTALL_DIR/.claude/settings.json" 2>/dev/null)"
fi
MODEL_FLAG=""
[ -n "$MAIN_MODEL" ] && MODEL_FLAG="--model '$MAIN_MODEL' "
# Full PATH with .bun/bin -- without it the respawned bun telegram bridge does
# not come up and the session is channel-less.
CHANNEL_PATH='export PATH="/opt/homebrew/bin:$HOME/.bun/bin:/home/linuxbrew/.linuxbrew/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"'
RESPAWN_CMD="$CHANNEL_PATH && $CLAUDE --dangerously-skip-permissions ${MODEL_FLAG}--channels plugin:telegram@claude-plugins-official"
# Full restart keeps Orin's conversation context: --continue is mandatory.
FULL_RESTART_CMD="$CHANNEL_PATH && $CLAUDE --continue --dangerously-skip-permissions ${MODEL_FLAG}--channels plugin:telegram@claude-plugins-official"

# --- gate: session must exist ---------------------------------------------
if ! "$TMUX_BIN" has-session -t "$SESSION" 2>/dev/null; then
  log "session $SESSION not present -- systemd marveen-channels.service owns (re)start; no-op"
  exit "$EXIT_DEFERRED"
fi

# --- gate: already healthy? -----------------------------------------------
if verify_healthy; then
  log "session $SESSION already healthy -- nothing to do"
  [ "$DRY_RUN" -eq 0 ] && rm -f "$RESPAWN_COUNT_FILE" "$FULL_RESTART_FILE" 2>/dev/null || true
  exit "$EXIT_RECOVERED"
fi

# --- rate-limit / interactive prompt = SYSTEMIC, not a disconnect ----------
# A worker "Stop and wait / Upgrade plan" prompt is not a plugin drop; a restart
# would lose context and not help. Surface as systemic so the caller escalates.
PANE_TAIL="$("$TMUX_BIN" capture-pane -p -t "$SESSION" 2>/dev/null | grep -v '^[[:space:]]*$' | tail -8)"
if echo "$PANE_TAIL" | grep -qiE 'stop and wait|upgrade plan|rate.?limit|usage limit'; then
  log "SYSTEMIC: rate-limit/usage prompt visible in $SESSION -- NOT restarting, escalate"
  exit "$EXIT_SYSTEMIC"
fi

# --- stage 1: respawn-pane -------------------------------------------------
respawn_count="$(cat "$RESPAWN_COUNT_FILE" 2>/dev/null || echo 0)"
case "$respawn_count" in (*[!0-9]*|'') respawn_count=0 ;; esac

if [ "$respawn_count" -ge "$MAX_CONSECUTIVE" ]; then
  log "SYSTEMIC: $respawn_count consecutive respawns without recovery -- backing off"
  exit "$EXIT_SYSTEMIC"
fi

if [ "$DRY_RUN" -eq 1 ]; then
  log "[DRY-RUN] would respawn-pane $SESSION (respawn #$((respawn_count+1))), wait ${VERIFY_GRACE}s, verify"
else
  log "stage 1: respawn-pane $SESSION (respawn #$((respawn_count+1)))"
  if "$TMUX_BIN" respawn-pane -k -t "$SESSION" "$RESPAWN_CMD" 2>/dev/null; then
    date +%s > "$RESPAWN_STAMP"
    echo $(( respawn_count + 1 )) > "$RESPAWN_COUNT_FILE"
  else
    log "respawn-pane FAILED for $SESSION"
    exit "$EXIT_FAILED"
  fi
  sleep "$VERIFY_GRACE"
  if verify_healthy; then
    log "verify after respawn: PASS -- recovered"
    rm -f "$RESPAWN_COUNT_FILE" "$FULL_RESTART_FILE" 2>/dev/null || true
    exit "$EXIT_RECOVERED"
  fi
  log "verify after respawn: FAIL -- escalating to full restart"
fi

# --- stage 2: full session restart (guarded) -------------------------------

# Idle-guard: kill-session interrupts Orin's running work. Only escalate to a
# full restart when the pane is idle (no spinner / "esc to interrupt").
if echo "$PANE_TAIL" | grep -qiE 'esc to interrupt|[✻✶✳✷⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]'; then
  log "deferred: pane busy (spinner/esc-to-interrupt) -- not full-restarting now"
  exit "$EXIT_DEFERRED"
fi

# Anti-flap: rolling full-restart cap over FULL_RESTART_WINDOW.
recent_full=0
if [ -f "$FULL_RESTART_FILE" ]; then
  while IFS= read -r ts; do
    case "$ts" in (*[!0-9]*|'') continue ;; esac
    [ $(( now - ts )) -lt "$FULL_RESTART_WINDOW" ] && recent_full=$(( recent_full + 1 ))
  done < "$FULL_RESTART_FILE"
fi
if [ "$recent_full" -ge "$MAX_FULL_RESTARTS" ]; then
  log "SYSTEMIC: $recent_full full restarts within window -- capped, NOT restarting, escalate"
  exit "$EXIT_SYSTEMIC"
fi

if [ "$DRY_RUN" -eq 1 ]; then
  log "[DRY-RUN] would full-restart $SESSION (kill-session + new-session --continue), wait ${FULL_RESTART_GRACE}s, verify"
  exit "$EXIT_RECOVERED"
fi

log "stage 2: full restart $SESSION (kill-session + new-session --continue)"
"$TMUX_BIN" kill-session -t "$SESSION" 2>/dev/null || true
sleep 1
if ! "$TMUX_BIN" new-session -d -s "$SESSION" -c "$INSTALL_DIR" "$FULL_RESTART_CMD" 2>/dev/null; then
  log "full restart: new-session FAILED for $SESSION"
  exit "$EXIT_FAILED"
fi
# Record the full-restart timestamp (append to the rolling window).
echo "$now" >> "$FULL_RESTART_FILE"
date +%s > "$RESPAWN_STAMP"

sleep "$FULL_RESTART_GRACE"
if verify_healthy; then
  log "full restart: PASS -- recovered"
  rm -f "$RESPAWN_COUNT_FILE" 2>/dev/null || true
  exit "$EXIT_RECOVERED"
fi
log "full restart: FAIL -- still unhealthy"
exit "$EXIT_FAILED"
