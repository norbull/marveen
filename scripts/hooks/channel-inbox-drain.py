#!/usr/bin/env python3
"""UserPromptSubmit hook: drain Telegram channel notifications into the prompt.

Telegram sub-agents load the official channel plugin as a plain MCP server to
avoid the plugin in_use lock. Claude Code ignores that server's channel
notifications, so scripts/channel-inbound-tee.mjs persists them to a local JSONL
inbox. This hook pulls that local queue into the next prompt, using the same
<channel> framing the --channels path would have produced.

FLEET NOTE (fork-specific): this template is shared with the MAIN agent (orin).
In this fleet the main agent receives inter-agent + Telegram traffic via the
PULL model (this drain hook), NOT via a --channels push into a derived inbox --
so the MAIN session MUST drain too. Therefore, unlike the upstream sub-agent-only
variant, we deliberately do NOT hard-exit on _is_main_session; the robust main
detector is kept available (see main()) but is intentionally non-gating. When a
drain yields content we also emit the [orin-wake] reminder that wakes the main
agent to process pending inter-agent messages. When no local derived inbox
exists the hook exits silently. All errors are fail-open so prompt submission is
never blocked.
"""
import glob
import html
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    import ledger_lib  # noqa: E402
    _HAS_LEDGER = True
except ImportError:
    _HAS_LEDGER = False


PREFIX = "[Telegram inbox drain -- %d fuggoben levo uzenet erkezett mikozben a session masszal foglalkozott:]"


def _load_payload():
    try:
        return json.load(sys.stdin)
    except Exception:
        return None


def _is_main_session(payload):
    """Return True when running inside the main agent session.

    Resolution order (mirrors inbox-drain.py / ledger_lib.agent_id_from_cwd):
    1. ledger_lib.agent_id_from_cwd + main_agent_id() comparison (preferred).
    2. Fallback: MAIN_AGENT_ID env var vs cwd-derived agent name.

    NOTE: kept available as a robust detector, but this fleet's main agent (orin)
    relies on the PULL drain, so main() does NOT gate the drain on this. Upstream
    uses it for a sub-agent-only hard-exit; we intentionally do not.
    """
    cwd = (payload or {}).get("cwd") or ""
    if _HAS_LEDGER:
        try:
            agent_id = ledger_lib.agent_id_from_cwd(cwd)
            return agent_id == ledger_lib.main_agent_id()
        except Exception:
            pass
    # Fallback without ledger_lib: cwd inside agents/<name>/ means sub-agent.
    main_id = os.environ.get("MAIN_AGENT_ID", "")
    if not cwd or not main_id:
        return False
    agents_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(cwd))), "agents")
    return not cwd.startswith(agents_dir)


def _state_dir(payload):
    env_dir = os.environ.get("TELEGRAM_STATE_DIR")
    if env_dir:
        return env_dir
    cwd = ""
    if isinstance(payload, dict):
        cwd = payload.get("cwd") or ""
    if not cwd:
        return ""
    return os.path.join(cwd, ".claude", "channels", "telegram")


def _claim_one(state_dir):
    pending = os.path.join(state_dir, "inbox-pending.jsonl")
    draining = sorted(
        glob.glob(os.path.join(state_dir, "inbox-draining-*.jsonl")),
        key=lambda p: (os.path.getmtime(p), p),
    )
    for path in draining + [pending]:
        try:
            if not os.path.exists(path) or os.path.getsize(path) == 0:
                continue
            if os.path.basename(path).startswith("inbox-draining-"):
                return path
            claimed = os.path.join(state_dir, "inbox-draining-%d.jsonl" % os.getpid())
            os.rename(path, claimed)
            return claimed
        except FileNotFoundError:
            return None
        except Exception:
            return None
    return None


def _attr(value):
    return html.escape(str(value), quote=True)


def _format_entry(entry):
    params = entry.get("params") if isinstance(entry, dict) else None
    if not isinstance(params, dict):
        return None
    meta = params.get("meta") if isinstance(params.get("meta"), dict) else {}
    content = params.get("content")
    if content is None:
        content = ""
    body = str(content).replace("</channel>", "")

    attrs = [('source', 'telegram')]
    for key in ("chat_id", "message_id", "user", "ts", "image_path"):
        if key in meta and meta.get(key) is not None:
            attrs.append((key, meta.get(key)))
    for key in sorted(meta.keys()):
        if key.startswith("attachment_") and meta.get(key) is not None:
            attrs.append((key, meta.get(key)))

    attr_text = " ".join('%s="%s"' % (key, _attr(value)) for key, value in attrs)
    return "<channel %s>%s</channel>" % (attr_text, body)


def _read_entries(path):
    out = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                formatted = _format_entry(json.loads(line))
                if formatted:
                    out.append(formatted)
            except Exception:
                continue
    return out


def drain(payload):
    state_dir = _state_dir(payload)
    if not state_dir or not os.path.isdir(state_dir):
        return ""
    claimed = _claim_one(state_dir)
    if not claimed:
        return ""

    entries = _read_entries(claimed)
    if not entries:
        try:
            os.unlink(claimed)
        except Exception:
            pass
        return ""

    text = PREFIX % len(entries) + "\n" + "\n".join(entries)
    # Fork-specific: wake the main agent (orin) to process the pulled messages.
    # This reminder is the mechanism the main agent sees to process pending
    # inter-agent traffic; dropping it silently breaks fleet coordination.
    reminder = (
        "\n[orin-wake] Bejövő inter-agent üzenet(ek) várnak a soron;"
        " a drain hook behúzta őket a kontextusba fentebb."
        " Dolgozd fel és válaszolj."
    )
    sys.stdout.write(text)
    sys.stdout.write(reminder)
    sys.stdout.write("\n")
    os.unlink(claimed)
    return text


def self_test():
    with tempfile.TemporaryDirectory() as td:
        state = os.path.join(td, ".claude", "channels", "telegram")
        os.makedirs(state)
        pending = os.path.join(state, "inbox-pending.jsonl")
        entries = [
            {
                "receivedAt": 1,
                "params": {
                    "content": "hello </channel> world",
                    "meta": {
                        "chat_id": "c1",
                        "message_id": "m1",
                        "user": "u1",
                        "ts": "123",
                        "image_path": "/tmp/img.png",
                        "attachment_0_name": "a.png",
                    },
                },
            },
            {"receivedAt": 2, "params": {"content": "second", "meta": {"chat_id": "c2"}}},
        ]
        with open(pending, "w", encoding="utf-8") as f:
            f.write(json.dumps(entries[0]) + "\n")
            f.write("{malformed\n")
            f.write(json.dumps(entries[1]) + "\n")

        old_stdout = sys.stdout
        capture = tempfile.TemporaryFile("w+", encoding="utf-8")
        try:
            sys.stdout = capture
            os.environ["TELEGRAM_STATE_DIR"] = state
            drain({"cwd": td})
            capture.seek(0)
            out = capture.read()
        finally:
            sys.stdout = old_stdout
            os.environ.pop("TELEGRAM_STATE_DIR", None)
            capture.close()

        assert "2 fuggoben levo uzenet" in out
        assert "hello  world</channel>" in out
        assert out.count("<channel ") == 2
        assert 'image_path="/tmp/img.png"' in out
        assert 'attachment_0_name="a.png"' in out
        # Fork-specific: the [orin-wake] reminder MUST survive (fleet wake mechanism).
        assert "[orin-wake]" in out
        assert not os.path.exists(pending)
        assert not glob.glob(os.path.join(state, "inbox-draining-*.jsonl"))
    print("channel-inbox-drain self-test passed")


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--self-test":
        self_test()
        sys.exit(0)
    payload = _load_payload()
    if payload is None:
        sys.exit(0)
    # Upstream hard-exits here for the main session (sub-agent-only drain). This
    # fleet's MAIN agent (orin) receives inter-agent + Telegram via the PULL model
    # (this hook), so the main session MUST drain too. The robust detector stays
    # available but is intentionally NON-gating -- do not add a main hard-exit.
    _is_main = _is_main_session(payload)  # noqa: F841  (available; intentionally non-gating)
    try:
        drain(payload)
    except Exception:
        pass
    sys.exit(0)


if __name__ == "__main__":
    main()
