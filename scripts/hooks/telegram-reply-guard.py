#!/usr/bin/env python3
"""telegram-reply-guard — Stop hook.

Catches a recurring *per-turn reflex* bug: when the user's last message came in
from Telegram, the agent sometimes writes its answer only as transcript text and
forgets to actually send it through the channel reply tool. The text lands in the
CLI transcript and never reaches the user (see the `telegram-reply-tool-not-transcript`
memory). Memory + a standing promise do NOT fix this, because it is a reflex, not
a knowledge gap — so we enforce it at the harness level.

Design (per kanban #66381411, approved by Orin):
  - This is a *reminder injection*, not an aggressive hard-block. On a Telegram
    inbound turn that ended WITHOUT a channel send, we emit a single
    {"decision":"block","reason":...} to nudge the agent to send the reply now.
  - It fires AT MOST ONCE per turn: when the Stop event arrives with
    `stop_hook_active` true (i.e. this Stop is already a continuation caused by a
    previous Stop-hook block), we stay silent and let the turn end. That prevents
    an endless block loop when the agent legitimately has nothing to send (e.g. it
    pinged another agent and is waiting).

Delivery is recognised as EITHER:
  - a channel reply/send/edit tool call (the mcp telegram `reply` tool, whose name
    matches `telegram.*reply`; also slack/discord send tools), OR
  - a `curl` to the Telegram Bot API send endpoint inside a Bash tool call — this
    is the main agent's documented workaround for the reply tool returning 404
    (see the `telegram-reply-tool-404` memory). Without this branch the guard
    would false-positive on the main agent every time.

Reading the transcript never logs its contents (Telegram text is PII); the hook
only ever emits the fixed reminder string. Any parse/IO failure fails OPEN
(exit 0, no block) so a malformed transcript can never wedge a turn.

Disable with:  MARVEEN_DISABLE_REPLY_GUARD=1
"""
import json
import os
import re
import sys

TAIL_BYTES = 512 * 1024  # only inspect the last 512 KB of the transcript

# Telegram Bot API send methods that count as "the reply actually went out"
# when issued via curl in a Bash tool call (main-agent 404 workaround).
_TG_SEND_METHODS = (
    "sendmessage",
    "sendphoto",
    "senddocument",
    "sendvoice",
    "sendaudio",
    "sendvideo",
    "copymessage",
    "editmessagetext",
)


def _text_of(message):
    """Flatten a message's content to a single string."""
    if not isinstance(message, dict):
        return ""
    content = message.get("content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for p in content:
            if isinstance(p, dict) and p.get("type") == "text":
                parts.append(p.get("text", ""))
            elif isinstance(p, dict) and "text" in p:
                parts.append(str(p.get("text", "")))
            elif isinstance(p, str):
                parts.append(p)
        return " ".join(parts)
    return str(content)


def _role_of(ev):
    msg = ev.get("message")
    if isinstance(msg, dict) and msg.get("role"):
        return msg.get("role")
    return ev.get("role")


def _is_telegram_inbound(text):
    """True when the text carries an inbound Telegram channel tag.

    Matches both `source="telegram"` and `source="plugin:telegram"`.
    """
    if "<channel source=" not in text:
        return False
    return bool(re.search(r'<channel source="[^"]*telegram', text))


def _is_delivery(part):
    """True when a tool_use part represents an actual channel send."""
    if not isinstance(part, dict) or part.get("type") != "tool_use":
        return False
    name = (part.get("name") or "").lower()

    # Native channel send/reply/edit tools (mcp telegram `reply` / `edit_message`,
    # slack/discord send). The mcp reply tool name matches `telegram.*reply`.
    if "reply" in name:
        return True
    if ("telegram" in name or "slack" in name or "discord" in name) and (
        "send" in name or "edit_message" in name
    ):
        return True

    # Main-agent curl workaround: Bash call hitting the Telegram Bot API send API.
    if name == "bash":
        cmd = ""
        inp = part.get("input")
        if isinstance(inp, dict):
            cmd = str(inp.get("command", ""))
        low = cmd.lower()
        if "api.telegram.org" in low and any(m in low for m in _TG_SEND_METHODS):
            return True

    return False


def _load_events(transcript_path):
    """Tail-read the transcript and return parsed JSONL events (best effort)."""
    try:
        size = os.path.getsize(transcript_path)
        with open(transcript_path, "rb") as fh:
            if size > TAIL_BYTES:
                fh.seek(size - TAIL_BYTES)
            raw = fh.read()
    except OSError:
        return []
    text = raw.decode("utf-8", errors="replace")
    # If we started mid-file, drop the possibly-partial first line.
    if size > TAIL_BYTES:
        nl = text.find("\n")
        if nl >= 0:
            text = text[nl + 1:]
    events = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except (ValueError, TypeError):
            continue
    return events


def main():
    if os.environ.get("MARVEEN_DISABLE_REPLY_GUARD") == "1":
        return 0

    try:
        data = json.load(sys.stdin)
    except (ValueError, TypeError):
        return 0  # unparseable event -> fail open

    # Fire at most once per turn: a continuation Stop (we already reminded) must
    # not block again, or a genuinely-silent turn would loop forever.
    if data.get("stop_hook_active"):
        return 0

    transcript = data.get("transcript_path", "")
    if not transcript or not os.path.exists(transcript):
        return 0

    events = _load_events(transcript)
    if not events:
        return 0

    # Find the LAST genuine Telegram inbound user message. Tool results are also
    # role=="user" in the transcript, so we key on the channel tag, not the role
    # alone — otherwise a trailing tool_result would be mistaken for the inbound.
    last_inbound_idx = None
    for i, ev in enumerate(events):
        if _role_of(ev) != "user":
            continue
        if _is_telegram_inbound(_text_of(ev.get("message", ev))):
            last_inbound_idx = i

    if last_inbound_idx is None:
        return 0  # not a Telegram inbound turn -> nothing to enforce

    # Was there a channel send anywhere after that inbound message?
    for ev in events[last_inbound_idx + 1:]:
        msg = ev.get("message", ev)
        content = msg.get("content", []) if isinstance(msg, dict) else []
        if isinstance(content, list):
            for part in content:
                if _is_delivery(part):
                    return 0  # reply was sent -> all good

    # No send -> inject a single gentle reminder.
    print(json.dumps({
        "decision": "block",
        "reason": (
            "Reminder: the user's last message came from Telegram, but this turn "
            "did not send anything back through the channel. Your text answer only "
            "went into the CLI transcript, so the user never saw it. Send your reply "
            "now via the Telegram reply tool (or the curl workaround if the reply "
            "tool 404s), using the chat_id from the inbound <channel> tag. If you "
            "truly have nothing to send yet (e.g. you are waiting on another agent), "
            "a brief acknowledgement to the user is still expected."
        ),
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
