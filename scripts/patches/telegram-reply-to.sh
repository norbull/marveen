#!/usr/bin/env bash
# Patch: add reply_to_message_id to Telegram plugin channel meta
# Applies to: ~/.claude/plugins/cache/claude-plugins-official/telegram/0.0.6/server.ts
# Safe to re-run (idempotent).

PLUGIN="$HOME/.claude/plugins/cache/claude-plugins-official/telegram/0.0.6/server.ts"

if [ ! -f "$PLUGIN" ]; then
  echo "SKIP: plugin file not found at $PLUGIN"
  exit 0
fi

MARKER='reply_to_message?.message_id != null'
if grep -q "$MARKER" "$PLUGIN"; then
  echo "OK: patch already applied"
  exit 0
fi

NEEDLE='        \.\.\.(msgId != null ? { message_id: String(msgId) } : {}),'
PATCH='        ...(msgId != null ? { message_id: String(msgId) } : {}),\n        ...(ctx.message?.reply_to_message?.message_id != null ? { reply_to_message_id: String(ctx.message.reply_to_message.message_id) } : {}),'

sed -i "s/$NEEDLE/$PATCH/" "$PLUGIN"

if grep -q "$MARKER" "$PLUGIN"; then
  echo "OK: patch applied"
else
  echo "ERROR: patch failed -- apply manually"
  exit 1
fi
