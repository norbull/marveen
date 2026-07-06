#!/usr/bin/env python3
"""End-to-end regression test for telegram-reply-guard.py.

Drives the hook as a subprocess with a synthetic Stop event on stdin and a
synthetic JSONL transcript on disk, asserting whether it injects a reminder
(decision:block) or stays silent. Run:

    python3 scripts/hooks/test_telegram_reply_guard.py

Exit 0 = all pass. Kept next to the hook so a future edit that breaks the
detection logic fails loudly here.
"""
import json
import os
import subprocess
import sys
import tempfile

_HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "telegram-reply-guard.py")


def _user(text):
    return {"type": "user", "message": {"role": "user", "content": text}}


def _tool_result(text="ok"):
    # Tool results are role=="user" in the transcript — the guard must not treat
    # them as the inbound message.
    return {"type": "user", "message": {"role": "user", "content": [
        {"type": "tool_result", "content": text}]}}


def _reply_tool():
    return {"type": "assistant", "message": {"role": "assistant", "content": [
        {"type": "tool_use", "name": "mcp__plugin_telegram_telegram__reply",
         "input": {"chat_id": 0, "text": "hi"}}]}}


def _edit_tool():
    return {"type": "assistant", "message": {"role": "assistant", "content": [
        {"type": "tool_use", "name": "mcp__plugin_telegram_telegram__edit_message",
         "input": {"chat_id": 0, "message_id": 1, "text": "hi"}}]}}


def _curl_send():
    return {"type": "assistant", "message": {"role": "assistant", "content": [
        {"type": "tool_use", "name": "Bash", "input": {
            "command": "curl -s https://api.telegram.org/bot123:abc/sendMessage "
                       "-d chat_id=5757969209 -d text=hi"}}]}}


def _text_only():
    return {"type": "assistant", "message": {"role": "assistant", "content": [
        {"type": "text", "text": "Here is the answer to your question."}]}}


TG_IN = _user('<channel source="telegram" chat_id="5757969209" user="Norbi">szia</channel>')
TG_PLUGIN_IN = _user('<channel source="plugin:telegram" chat_id="5757969209">szia</channel>')
PLAIN_IN = _user("just a normal CLI prompt, no channel tag")


def run_case(events, stop_hook_active=False, env_extra=None):
    """Return True if the hook injected a block, False otherwise."""
    with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False) as tf:
        for ev in events:
            tf.write(json.dumps(ev) + "\n")
        path = tf.name
    try:
        payload = {"transcript_path": path, "stop_hook_active": stop_hook_active}
        env = dict(os.environ)
        if env_extra:
            env.update(env_extra)
        proc = subprocess.run(
            [sys.executable, _HOOK],
            input=json.dumps(payload),
            capture_output=True, text=True, env=env, timeout=15,
        )
        out = proc.stdout.strip()
        if not out:
            return False
        try:
            return json.loads(out).get("decision") == "block"
        except ValueError:
            return False
    finally:
        os.unlink(path)


# (label, events, kwargs, expected_block)
CASES = [
    ("tg inbound, no reply -> block", [TG_IN, _text_only()], {}, True),
    ("tg inbound, reply tool -> ok", [TG_IN, _reply_tool()], {}, False),
    ("tg inbound, curl send -> ok", [TG_IN, _text_only(), _curl_send()], {}, False),
    ("tg inbound, edit_message -> ok", [TG_IN, _edit_tool()], {}, False),
    ("plugin:telegram inbound, no reply -> block", [TG_PLUGIN_IN, _text_only()], {}, True),
    ("non-channel prompt -> ok", [PLAIN_IN, _text_only()], {}, False),
    ("stop_hook_active guard -> ok", [TG_IN, _text_only()], {"stop_hook_active": True}, False),
    ("trailing tool_result not mistaken for inbound -> ok",
     [TG_IN, _reply_tool(), _tool_result()], {}, False),
    ("two turns, last unanswered -> block",
     [TG_IN, _reply_tool(), TG_IN, _text_only()], {}, True),
    ("two turns, last answered -> ok",
     [TG_IN, _text_only(), TG_IN, _reply_tool()], {}, False),
    ("disabled via env -> ok",
     [TG_IN, _text_only()], {"env_extra": {"MARVEEN_DISABLE_REPLY_GUARD": "1"}}, False),
]


def main():
    failures = 0
    for label, events, kwargs, expected in CASES:
        got = run_case(events, **kwargs)
        ok = got == expected
        print(f"{'✓' if ok else '✗'} {label}  (block={got}, expected={expected})")
        if not ok:
            failures += 1
    print()
    if failures:
        print(f"FAIL: {failures}/{len(CASES)} case(s) failed")
        return 1
    print(f"PASS: all {len(CASES)} cases")
    return 0


if __name__ == "__main__":
    sys.exit(main())
