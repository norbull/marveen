#!/usr/bin/env python3
"""OpenRouter free-layer draft tool. A PLUS tool next to Nyx and Codex.

Same contract as scripts/local-codegen.py (Nyx): this calls a cheap external
model and prints a DRAFT to stdout -- a Claude agent (Dex) MUST review it before
anything ships. It does NOT replace Nyx (local Qwen, zero cost, first stop) or
Codex; no default workflow routes here automatically. Dex-only pilot.

Model selection is by ALIAS resolved from the alias table (seed-config/
openrouter-models.json, or store/openrouter-models.json if present), so model
ids never get baked into agent prompts:
  dex_code_primary -> poolside/laguna-xs-2.1:free   (etc.)
A full model id (contains "/") is also accepted verbatim.

Auth: OPENROUTER_API_KEY env, else store/.openrouter-api-key (0600). The wrapper
REFUSES to run without a key instead of burning a confusing mid-loop failure.

Rate limits are FLEET-wide (20 rpm, 50/day under 10 USD credit) -- this tool does
not throttle; a 429 just exits non-zero so the caller falls back to Claude.

Usage:
  scripts/openrouter-draft.py "Write a function that ..."
  echo "prompt..." | scripts/openrouter-draft.py
  scripts/openrouter-draft.py --model dex_code_fallback --temp 0.3 "..."
  scripts/openrouter-draft.py --list        # print resolved alias table, exit

Exit 0 on success; non-zero on missing key / bad alias / HTTP or timeout error
(caller falls back to generating directly on Claude).
"""
import os
import sys
import json
import time
import argparse
import urllib.request
import urllib.error

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API_URL = "https://openrouter.ai/api/v1/chat/completions"
CONFIG_PATHS = [
    os.path.join(PROJECT_ROOT, "store", "openrouter-models.json"),      # runtime override
    os.path.join(PROJECT_ROOT, "seed-config", "openrouter-models.json"),  # versioned default
]
KEY_PATH = os.path.join(PROJECT_ROOT, "store", ".openrouter-api-key")


def load_config():
    for p in CONFIG_PATHS:
        try:
            with open(p) as f:
                return json.load(f)
        except FileNotFoundError:
            continue
        except Exception as e:
            print(f"error: alias table {p} is unreadable ({e}).", file=sys.stderr)
            sys.exit(2)
    print("error: no alias table found (seed-config/openrouter-models.json).",
          file=sys.stderr)
    sys.exit(2)


def read_key():
    env = os.environ.get("OPENROUTER_API_KEY")
    if env and env.strip():
        return env.strip()
    try:
        with open(KEY_PATH) as f:
            k = f.read().strip()
            if k:
                return k
    except Exception:
        pass
    return None


def resolve_model(name, cfg):
    models = cfg.get("models", {})
    if name in models:
        return models[name]
    if "/" in name:          # already a full model id (e.g. vendor/model:free)
        return name
    valid = ", ".join(sorted(models))
    print(f"error: unknown model alias '{name}'. Known aliases: {valid} "
          f"(or pass a full 'vendor/model' id).", file=sys.stderr)
    sys.exit(2)


def call_once(model, prompt, key, temp, timeout):
    sys_hint = ("You are a code/text drafting assistant. Output ONLY the "
                "requested artifact (no preamble, no markdown fences). Be "
                "correct and explicit about edge cases. This is a DRAFT that a "
                "senior reviewer will check.")
    body = json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": sys_hint},
            {"role": "user", "content": prompt},
        ],
        "temperature": temp,
    }).encode()
    req = urllib.request.Request(API_URL, data=body, headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {key}",
        # OpenRouter attribution headers (recommended, harmless if unlisted).
        "HTTP-Referer": "https://github.com/norbull/moonwright",
        "X-Title": "Moonwright free-layer draft",
    })
    r = json.loads(urllib.request.urlopen(req, timeout=timeout).read())
    # OpenRouter can return an error object with HTTP 200.
    if isinstance(r, dict) and r.get("error"):
        raise RuntimeError(str(r["error"]))
    return r


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("prompt", nargs="?", help="prompt (else read stdin)")
    ap.add_argument("--model", default=None, help="alias or full model id")
    ap.add_argument("--temp", type=float, default=0.2)
    ap.add_argument("--timeout", type=int, default=45)
    ap.add_argument("--list", action="store_true", help="print alias table and exit")
    a = ap.parse_args()

    cfg = load_config()
    if a.list:
        for alias, mid in sorted(cfg.get("models", {}).items()):
            mark = "  (default)" if alias == cfg.get("default") else ""
            print(f"{alias:20} -> {mid}{mark}")
        sys.exit(0)

    model = resolve_model(a.model or cfg.get("default", ""), cfg)

    # Preflight guard: refuse cleanly without a key (like codex-draft's login
    # guard) so the failure is legible, not a cryptic mid-run 401.
    key = read_key()
    if not key:
        print(f"error: no OpenRouter API key (set OPENROUTER_API_KEY or write "
              f"{KEY_PATH}, mode 0600).", file=sys.stderr)
        sys.exit(3)

    prompt = a.prompt if a.prompt else sys.stdin.read()
    if not prompt.strip():
        print("error: empty prompt", file=sys.stderr)
        sys.exit(2)

    # One retry on transient failure (429 / 5xx / timeout), then give up so the
    # caller falls back to Claude. Free capacity is flaky by design.
    last_err = None
    for attempt in (1, 2):
        try:
            t0 = time.time()
            r = call_once(model, prompt, key, a.temp, a.timeout)
            dt = time.time() - t0
            break
        except urllib.error.HTTPError as e:
            last_err = f"HTTP {e.code}"
            if e.code in (429, 500, 502, 503, 504) and attempt == 1:
                time.sleep(2)
                continue
            print(f"error: OpenRouter {last_err} for model={model}. Fall back to "
                  f"Claude.", file=sys.stderr)
            sys.exit(1)
        except Exception as e:
            last_err = str(e)
            if attempt == 1:
                time.sleep(2)
                continue
            print(f"error: OpenRouter unreachable ({last_err}). Fall back to "
                  f"Claude.", file=sys.stderr)
            sys.exit(1)

    try:
        out = r["choices"][0]["message"]["content"]
    except Exception:
        print(f"error: unexpected response shape from {model}. Fall back to "
              f"Claude.", file=sys.stderr)
        sys.exit(1)

    # Strip accidental markdown fences (some models add them despite the hint).
    s = out.strip()
    if s.startswith("```"):
        lines = s.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        out = "\n".join(lines)

    usage = r.get("usage", {}) or {}
    ct = usage.get("completion_tokens", 0)
    print(out)
    print(f"[openrouter-draft] model={model} wall={dt:.1f}s "
          f"out_tokens={ct} -- REVIEW THIS DRAFT before use.", file=sys.stderr)


if __name__ == "__main__":
    main()
