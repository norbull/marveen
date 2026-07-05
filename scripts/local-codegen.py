#!/usr/bin/env python3
"""Local-model draft codegen via Ollama (GPU). Token-cost saver.

The fleet offloads BULK / boilerplate / scaffold code drafting to a local
Qwen2.5-Coder running on the RTX 4060 (zero API token cost), then a Claude
agent (Dex/Orin) REVIEWS + corrects before the code is used. The local model
is fast but makes correctness mistakes -- its output is a DRAFT, never accepted
unverified.

Usage:
  scripts/local-codegen.py "Write a Python function that ..."
  echo "prompt..." | scripts/local-codegen.py
  scripts/local-codegen.py --model qwen2.5-coder:7b --temp 0.2 "..."

Prints the generated code to stdout; timing/speed to stderr. Exit 0 on success,
non-zero if Ollama is unreachable or the model is missing (caller falls back to
generating directly on Claude).
"""
import sys
import json
import time
import argparse
import urllib.request

OLLAMA = "http://localhost:11434"
DEFAULT_MODEL = "qwen2.5-coder:7b"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("prompt", nargs="?", help="coding prompt (else read stdin)")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--temp", type=float, default=0.2)
    ap.add_argument("--timeout", type=int, default=180)
    a = ap.parse_args()
    prompt = a.prompt if a.prompt else sys.stdin.read()
    if not prompt.strip():
        print("error: empty prompt", file=sys.stderr)
        sys.exit(2)

    # A standing instruction so the draft is paste-ready and review-friendly.
    sys_hint = ("You are a code drafting assistant. Output ONLY code (no prose, "
                "no markdown fences). Include type hints and a short docstring. "
                "Handle edge cases and invalid input explicitly.")
    body = json.dumps({
        "model": a.model,
        "prompt": prompt,
        "system": sys_hint,
        "stream": False,
        "options": {"temperature": a.temp},
    }).encode()
    req = urllib.request.Request(f"{OLLAMA}/api/generate", data=body,
                                 headers={"Content-Type": "application/json"})
    try:
        t0 = time.time()
        r = json.loads(urllib.request.urlopen(req, timeout=a.timeout).read())
        dt = time.time() - t0
    except Exception as e:
        print(f"error: local model unreachable ({e}). Fall back to Claude codegen.",
              file=sys.stderr)
        sys.exit(1)

    out = r.get("response", "")
    # strip accidental markdown fences if the model added them anyway
    if out.strip().startswith("```"):
        lines = out.strip().splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        out = "\n".join(lines)
    ec = r.get("eval_count", 0)
    ed = (r.get("eval_duration", 0) or 0) / 1e9
    speed = round(ec / ed, 1) if ed else 0
    print(out)
    print(f"[local-codegen] model={a.model} wall={dt:.1f}s out_tokens={ec} "
          f"speed={speed}tok/s -- REVIEW THIS DRAFT before use.", file=sys.stderr)


if __name__ == "__main__":
    main()
