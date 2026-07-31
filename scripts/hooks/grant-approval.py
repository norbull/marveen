#!/usr/bin/env python3
"""Orin grants a pending critical-action approval for a sub-agent.

Usage: grant-approval.py <agent> <sig>

Writes a single-use, 15-min approval token that permission-router.py will honor
on the agent's next identical tool call, then nudges the agent (inter-agent
message) to re-run the same command. Use ONLY after Orin has decided the action
is safe (or after Norbi approved a doubtful case).
"""
import sys
import os
import json
import time
import urllib.request

PROJECT_ROOT = "/home/karma/marveen"
DASHBOARD = "http://localhost:3420"
TTL = 900
MAIN_AGENT = "orin"


def token():
    with open(os.path.join(PROJECT_ROOT, "store", ".dashboard-token")) as f:
        return f.read().strip()


def main():
    if len(sys.argv) < 3:
        print("usage: grant-approval.py <agent> <sig>", file=sys.stderr)
        sys.exit(2)
    agent, sig = sys.argv[1], sys.argv[2]
    d = os.path.join(PROJECT_ROOT, "store", "approvals")
    os.makedirs(d, exist_ok=True)

    # Echo the FULL command snapshot the router persisted, so the grantor sees
    # exactly what will run -- including any tail that was truncated in the ping
    # (GhostApproval defense, 2026-07-14). No snapshot -> warn, grant proceeds on
    # the sig alone (back-compat: older pings had no snapshot).
    snap = os.path.join(d, f"{agent}.{sig}.cmd")
    try:
        with open(snap) as f:
            full = f.read()
        print(f"--- TELJES parancs jovahagyas elott (sig={sig}) ---\n{full}\n--- vege ---")
    except Exception:
        print(f"[figyelmeztetes] nincs parancs-snapshot ({snap}); grant a sig alapjan, vakon.",
              file=sys.stderr)

    path = os.path.join(d, f"{agent}.granted.json")
    try:
        with open(path) as f:
            appr = json.load(f)
    except Exception:
        appr = {}
    appr[sig] = {"expires": time.time() + TTL}
    with open(path, "w") as f:
        json.dump(appr, f)

    # nudge the agent to retry
    try:
        tok = token()
        content = (f"[Permission grant] Jovahagytam a kritikus muveletet (sig={sig}), "
                   f"15 percig ervenyes, egyszer hasznalhato. Futtasd UJRA UGYANAZT a parancsot.")
        data = json.dumps({"from": MAIN_AGENT, "to": agent, "content": content}).encode()
        req = urllib.request.Request(
            f"{DASHBOARD}/api/messages", data=data,
            headers={"Content-Type": "application/json",
                     "Authorization": f"Bearer {tok}"})
        urllib.request.urlopen(req, timeout=8)
    except Exception as e:
        print(f"granted, but nudge failed: {e}", file=sys.stderr)

    print(f"granted {agent} {sig} (TTL {TTL}s); agent nudged to retry")


if __name__ == "__main__":
    main()
