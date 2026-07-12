#!/bin/bash
# channel-reply-guard — Stop hook
#
# When the last user message came from a channel (Telegram/Slack/Discord) but the
# turn ended WITHOUT a channel send-tool call, this hook blocks the stop and asks
# the model to actually send the reply — instead of only generating it as text
# into the CLI transcript, where the user never sees it.
#
# It ALSO enqueues a DEAD-time safety-net copy: when the turn DID call the reply
# tool but the channel plugin is DEAD, the reply is lost with no retry. The hook
# POSTs the reply to /api/channel/send, which is the DEDUP GATE -- it enqueues
# ONLY when the plugin is DEAD at that moment, so a reply that already went out
# while HEALTHY is never duplicated. The enqueue path is best-effort and fully
# fail-safe: any error there is swallowed and never affects the block decision
# or the turn (the at-most-once guarantee lives in the endpoint, not this hook).
#
# Reads the Stop event's stdin JSON for transcript_path, inspects the last user
# message and the assistant tool calls produced after it.

INPUT=$(cat)

# Liveness stamp: every run touches this file, so a monitor can tell whether the
# stop-hook is actually firing. If channel traffic is flowing but the stamp goes
# stale, the hook has silently died and the DEAD-time safety net is off. Cheap
# and fail-safe -- never let a stamp failure disturb the hook.
touch "${MARVEEN_ROOT:-/home/karma/marveen}/store/.reply-guard-last-run" 2>/dev/null || true

python3 - "$INPUT" << 'PYEOF'
import json, sys, os, re

try:
    data = json.loads(sys.argv[1])
except Exception:
    sys.exit(0)  # unparseable input -> do not block

transcript = data.get("transcript_path", "")
if not transcript or not os.path.exists(transcript):
    sys.exit(0)

# Tool-name fragments that mean an actual channel send
SEND_TOOLS = ("telegram", "reply", "slack", "discord")


def _queue_dead_time_reply(reply_args, transcript_path):
    # Best-effort DEAD-time safety net. Every failure is swallowed: this must
    # never break the hook or the turn. The endpoint dedups (enqueues only when
    # the plugin is DEAD), so posting a HEALTHY-time reply here is a harmless
    # no-op that the endpoint declines.
    try:
        import urllib.request

        chat_id = str(reply_args.get("chat_id") or "").strip()
        text = reply_args.get("text")
        if not chat_id or not text:
            return
        parse_mode = "MarkdownV2" if str(reply_args.get("format", "")).lower() == "markdownv2" else None

        # Derive the agent id + marveen root from the transcript path, e.g.
        #   .../projects/-home-karma-marveen-agents-dex/...   -> agent "dex"
        #   .../projects/-home-karma-marveen/...              -> main agent
        m = re.search(r"/projects/-home-karma-marveen(-agents-([a-z0-9_-]+))?", transcript_path)
        if not m:
            return
        agent_id = m.group(2) or os.environ.get("MAIN_AGENT_ID", "orin")
        marveen_root = os.environ.get("MARVEEN_ROOT", "/home/karma/marveen")

        token_path = os.path.join(marveen_root, "store", ".dashboard-token")
        with open(token_path, encoding="utf-8") as fh:
            token = fh.read().strip()

        body = {"agent_id": agent_id, "chat_id": chat_id, "text": text}
        if parse_mode:
            body["parse_mode"] = parse_mode
        req = urllib.request.Request(
            "http://localhost:3420/api/channel/send",
            data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=3).read()
    except Exception:
        return  # fail-safe: never disturb the turn


try:
    lines = open(transcript, encoding="utf-8").read().splitlines()
except Exception:
    sys.exit(0)

# Walk events; remember the index of the last user message.
events = []
last_user_idx = None
for ln in lines:
    if not ln.strip():
        continue
    try:
        ev = json.loads(ln)
    except Exception:
        continue
    events.append(ev)
    role = ev.get("message", {}).get("role") or ev.get("role")
    if role == "user":
        last_user_idx = len(events) - 1

if last_user_idx is None:
    sys.exit(0)

def text_of(ev):
    msg = ev.get("message", ev)
    c = msg.get("content", "")
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return " ".join(p.get("text", "") if isinstance(p, dict) else str(p) for p in c)
    return str(c)

user_text = text_of(events[last_user_idx])
is_channel = (
    'source="plugin:telegram' in user_text
    or '<channel source=' in user_text
    or '← telegram' in user_text  # "← telegram"
)
if not is_channel:
    sys.exit(0)  # not a channel message -> nothing to enforce

# Heartbeat / scheduled-task prompts may legitimately stay silent.
if (
    'scheduled-task:' in user_text
    or '[Heartbeat:' in user_text
    or 'untrusted source="scheduled-task' in user_text
):
    sys.exit(0)

# Was there a channel send-tool call after the last user message? Capture the
# LAST reply's args so a DEAD-time send can be queued as a safety net.
sent = False
reply_args = None
for ev in events[last_user_idx + 1:]:
    msg = ev.get("message", ev)
    content = msg.get("content", [])
    if isinstance(content, list):
        for part in content:
            if isinstance(part, dict) and part.get("type") == "tool_use":
                name = (part.get("name") or "").lower()
                if any(t in name for t in SEND_TOOLS):
                    sent = True
                    inp = part.get("input")
                    if isinstance(inp, dict) and inp.get("chat_id") and inp.get("text"):
                        reply_args = inp  # last one wins

if sent:
    # A reply tool was called. Queue a DEAD-time safety-net copy (endpoint
    # dedups; no-op while HEALTHY). Best-effort, never blocks.
    if reply_args is not None:
        _queue_dead_time_reply(reply_args, transcript)
    sys.exit(0)

# No channel send -> block and remind the model.
print(json.dumps({
    "decision": "block",
    "reason": (
        "The user's last message arrived from a channel (Telegram/Slack/Discord), "
        "but this turn did NOT call the channel send-tool (e.g. the telegram reply "
        "tool). Your text answer only went into the CLI transcript and never reached "
        "the user. Send the reply NOW via the channel send-tool (use the chat_id from "
        "the inbound <channel> tag)."
    )
}))
sys.exit(0)
PYEOF
