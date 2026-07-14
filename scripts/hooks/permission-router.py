#!/usr/bin/env python3
"""PreToolUse permission router (matcher "*").

Norbi model (2026-06-29): sub-agents auto-approve everything ROUTINE (no
Telegram permission prompt at all), and only genuinely CRITICAL / irreversible
/ outward / system actions are gated. A gated action is NOT prompted to Norbi;
instead it is routed to Orin (the main agent) via inter-agent message and the
tool call is DENIED. Orin decides: grant (write an approval token so the agent
can retry) or escalate to Norbi. This replaces the noisy native Telegram
permission UI for sub-agents.

Decision contract (Claude Code PreToolUse):
  stdout {"hookSpecificOutput":{"hookEventName":"PreToolUse",
          "permissionDecision":"allow"|"deny","permissionDecisionReason":...}}
  - "allow"  -> auto-approve, suppresses the permission prompt entirely
  - "deny"   -> block the tool call (used for critical-without-approval)
  - exit 0 with no/!json output -> defer to normal flow (we avoid this so
    routine never prompts)

Fail-open: any error -> allow, so a bug here never freezes an agent.
"""
import sys
import os
import re
import json
import time
import hashlib
import urllib.request

PROJECT_ROOT = "/home/karma/marveen"
# Branch-immune runtime copy of the critical hooks (see install-critical-hooks.sh).
# Orin's grant command must point here, not at PROJECT_ROOT/scripts/hooks: a repo
# branch-switch can delete scripts/hooks/grant-approval.py from disk mid-run, so
# the repo path is not safe to hand out. ~/.claude/hooks/ is branch-immune.
RUNTIME_HOOKS = os.path.join(os.path.expanduser("~"), ".claude", "hooks")
DASHBOARD = "http://localhost:3420"
APPROVAL_TTL = 900        # granted approval valid 15 min
NOTIFY_DEDUPE = 300       # don't re-ping Orin for same sig within 5 min
MAIN_AGENT = "orin"


def emit(decision, reason=None):
    o = {"hookSpecificOutput": {"hookEventName": "PreToolUse",
                                "permissionDecision": decision}}
    if reason:
        o["hookSpecificOutput"]["permissionDecisionReason"] = reason
    sys.stdout.write(json.dumps(o))
    sys.exit(0)


def allow():
    emit("allow")


# --- critical classification -------------------------------------------------
# Only genuinely irreversible / outward / system actions. Everything else is
# routine and auto-allowed. Keep this set TIGHT to avoid spamming Orin, but it
# MUST be a superset of the settings.json deny-list so an "allow" here can never
# silently bypass a hard deny.
CRITICAL_BASH = [
    r"\bsudo\b",
    r"\brm\s+-[a-zA-Z]*[rf]",                 # rm -r / -f (recursive/forced delete)
    r"(^|[;&|]\s*)rm\s+(?![^;&|]*?/tmp/)",     # any rm not clearly confined to /tmp
    r"\bgit\s+push\b",
    r"\bgit\s+reset\s+--hard\b",
    r"\bgit\s+clean\b",
    r"\bgit\s+branch\s+-D\b",
    r"\bgit\s+rebase\b",
    # only STATE-CHANGING systemctl is critical; read-only (is-active, status,
    # show, list-*, cat, is-enabled) is routine health-inspection.
    r"\bsystemctl\b[^\n]*\b(start|stop|restart|reload|reload-or-restart|enable|disable|mask|unmask|kill|daemon-reload|isolate|set-default)\b",
    r"\b(shutdown|reboot|halt|poweroff)\b",
    r"\bnpm\s+run\s+build\b",                  # rebuild-footgun -> would redeploy
    r"\bnpm\s+(ci|install)\b",                 # dep churn can break native bindings
    r"\b(kill|pkill|killall)\b",
    r"\b(mkfs|dd)\b",
    r"\bcrontab\b",
    r"\bchmod\b[^\n]*(/etc|/usr|\.ssh|\.aws|\.gnupg|\.claude)",
    r"\bchown\b",
    r"\bDROP\s+TABLE\b|\bDELETE\s+FROM\b|\bTRUNCATE\b",
    r"\.git-credentials|/\.ssh/|/\.aws/|/\.gnupg/",
    r">{1,2}\s*\S*/\.claude/",                 # writing into ~/.claude (settings/hooks)
    r"\bgit\s+config\b[^\n]*--global",
]


# Own-dashboard message/comment/memory endpoints: text sent HERE is data about
# work (status reports, kanban comments), not commands to execute. Only these
# endpoints get heredoc stripping -- a curl to any other host keeps its payload
# in the classified text. (2026-07-04, kanban 4b4d0e5a: a status report that
# MENTIONED "tmux kill-session" / "sudo" as topics was blocked for an hour.)
OWN_API_RX = re.compile(
    r"curl\b[^\n]*\bhttps?://(?:localhost|127\.0\.0\.1):3420/api/"
    r"(?:messages|kanban/[^/\s]+/comments|daily-log|memories)\b")
HEREDOC_BODY_RX = re.compile(r"(<<-?\s*(['\"]?)(\w+)\2).*?\n(\3)(?=\n|\s*$|\s*[;&|])", re.S)
# Known fleet message helpers: classify the command skeleton, not the free-text
# last argument. Targets are restricted to fleet sessions (orin-channels /
# agent-*) -- send-keys to any OTHER tmux session (e.g. a shell) keeps its
# payload classified.
FLEET_MSG_RX = re.compile(
    r"(\bfleet\.py\s+msg\s+\S+\s+\S+\s+)('(?:[^'])*'|\"(?:[^\"\\]|\\.)*\")")
SEND_KEYS_RX = re.compile(
    r"(\btmux\s+send-keys\s+-t\s+(?:orin-channels|agent-[\w-]+)\b[^\n;&|]*?-l\s+)"
    r"('(?:[^'])*'|\"(?:[^\"\\]|\\.)*\")")


def clean_cmd(cmd):
    # Drop curl/wget data payloads (-d/--data '...') before classifying: an
    # inter-agent message / memory / kanban POST carries arbitrary text in its
    # JSON body (e.g. a health report literally containing the word "restart"),
    # and matching critical patterns inside that DATA is a false positive. The
    # payload is data sent to our own dashboard, not an executed command.
    cmd = re.sub(r"(--data-raw|--data-binary|--data|-d)\s+'(?:[^'\\]|\\.)*'", r"\1 ''", cmd)
    cmd = re.sub(r'(--data-raw|--data-binary|--data|-d)\s+"(?:[^"\\]|\\.)*"', r'\1 ""', cmd)
    # Heredoc payload (curl -d @- <<'EOF' ... EOF) -- but ONLY when the command
    # curls our own dashboard message-ish API and pipes stdin data into it.
    # Trade-off (documented): a compound command that ALSO feeds a heredoc to a
    # shell would lose that body from classification too; the fleet's own
    # message flows never do this, and the hook is fail-open by design -- the
    # gate exists to catch accidents, not determined adversaries.
    if OWN_API_RX.search(cmd) and re.search(r"(?:--data(?:-raw|-binary)?|-d)\s+@-", cmd):
        cmd = HEREDOC_BODY_RX.sub(r"\1\n\4", cmd)
    # git commit -m "$(cat <<'EOF' ... EOF)" -- the commit MESSAGE is prose
    # about the change (it may well mention sudo/kill/rm as topics), not a
    # command. Same class as the API payloads above (4th shape, found while
    # committing this very fix).
    if re.search(r"\bgit\s+commit\b[^\n]*-m\s+\"\$\(\s*cat\s+<<", cmd):
        cmd = HEREDOC_BODY_RX.sub(r"\1\n\4", cmd)
    # Free-text single argument of known message helpers.
    cmd = FLEET_MSG_RX.sub(r"\1''", cmd)
    cmd = SEND_KEYS_RX.sub(r"\1''", cmd)
    # -d/--data-binary @<(printf '...') process-substitution payloads to our
    # own API: blank the QUOTED LITERALS inside the substitution (they are the
    # message text). Command WORDS inside <(...) stay -- `@<(sudo cat x)` is
    # real execution and must keep classifying.
    if OWN_API_RX.search(cmd):
        def _blank_quotes(m):
            inner = m.group(2)
            inner = re.sub(r"'(?:[^'])*'", "''", inner)
            inner = re.sub(r'"(?:[^"\\]|\\.)*"', '""', inner)
            return m.group(1) + inner + ")"
        cmd = re.sub(r"((?:--data(?:-raw|-binary)?|-d)\s+@<\()([^)]*)\)",
                     _blank_quotes, cmd)
    return cmd


# Write/Edit-style tools: the router was Bash-only, so a sub-agent that lost
# its permissive mode fell through to a NATIVE prompt at Norbi for sensitive
# file writes (Orin, 2026-06-30, kanban 8183dba9). Route those to Orin instead:
# home-level ~/.claude (hooks/settings of EVERY agent), any .claude/settings
# (permission profiles), and credential/system dirs.
CRITICAL_WRITE_PATH = [
    r"^/home/[^/]+/\.claude/",
    r"/\.claude/settings(\.local)?\.json$",
    r"/\.ssh/|/\.aws/|/\.gnupg/|\.git-credentials",
    r"^/etc/",
]
# Safe-write carve-out: agent MEMORY files live under .../projects/<proj>/memory/
# and every agent is explicitly instructed (CLAUDE.md memory system) to write
# them routinely. The main agent's memory dir is ~/.claude/projects/.../memory/,
# which sits INSIDE the ^/home/[^/]+/\.claude/ critical zone -- so without this
# exemption Orin's own memory writes get gated as critical and routed to itself
# (self-deadlock / noise). Matched on the NORMALIZED path (os.path.normpath) so a
# `.../memory/../../settings.json` traversal collapses out of the carve-out and
# re-enters the critical set. Kept tight: one flat filename directly in memory/.
SAFE_WRITE_PATH = [
    r"/projects/[^/]+/memory/[^/]+$",
]
WRITE_TOOLS = ("Write", "Edit", "MultiEdit", "NotebookEdit")


# --- external HTTP egress classification -------------------------------------
# CRITICAL_BASH had no HTTP-client pattern, so a sub-agent could curl/wget
# arbitrary data to ANY external host and it auto-allowed -- Orin never saw it
# (Nova finding, 2026-07-05). Rule: a curl/wget whose target host is NOT on this
# allowlist is critical (Orin-gate); allowlisted hosts stay routine. The scan
# runs on the CLEANED command (clean_cmd already blanks -d/--data payloads), so
# a URL sitting inside a POST body never triggers -- only the real target URL.
# The allowlist is the set of hosts the fleet ACTUALLY curls today (grepped),
# each verified as a real, in-use function -- not a guess.
HTTP_HOST_ALLOWLIST = [
    "localhost",
    "127.0.0.1",
    "github.com",                          # + api.github.com via suffix match
    "githubusercontent.com",               # raw./objects. github user content
    "api.telegram.org",                    # Telegram reply workaround curls
    "slack.com",                           # Slack channel provider
    "api.openai.com",                      # OpenAI / Codex
    "generativelanguage.googleapis.com",   # scripts/pre-pr-review.sh (Gemini)
    "api.resend.com",                      # email send (also under email-gate)
    "connectors.hu",                       # docs/connectors-hu.md MCP gateway
    "openrouter.ai",                       # OpenRouter free-layer draft (dex pilot)
]

_URL_HOST_RX = re.compile(r"https?://([^/:?#\s'\"]+)", re.I)


def _host_allowlisted(host):
    host = host.lower()
    for entry in HTTP_HOST_ALLOWLIST:
        if host == entry or host.endswith("." + entry):
            return True
    return False


# --- position-independent git subcommand detection --------------------------
# The CRITICAL_BASH patterns above match only when the subcommand immediately
# follows 'git'.  git -C <path> push / git -c user.name=x push break them
# because the global flag+value sits between 'git' and the subcommand.
# This set covers all flags that consume a following token as their value:
_GIT_SKIP_FLAGS = frozenset({
    '-C', '-c', '--git-dir', '--work-tree', '--namespace',
    '--exec-path', '--html-path', '--man-path', '--info-path',
})

# subcommand -> required extra flag (None = critical regardless of flags)
_GIT_CRITICAL_SUBCMDS = {
    'push':   None,
    'clean':  None,
    'rebase': None,
    'reset':  '--hard',
    'branch': '-D',
    'config': '--global',
}


def _extract_git_subcmds(cmd):
    """Return [(subcmd_lower, rest_tokens)] for every git invocation in cmd.

    Splits on shell separators first so a compound command yields each
    git call separately.  Skips git's global flags (both --flag value and
    --flag=value forms) to reach the actual subcommand.
    """
    results = []
    for segment in re.split(r'[;&|()`\n]', cmd):
        tokens = segment.split()
        for i, tok in enumerate(tokens):
            if tok != 'git':
                continue
            j = i + 1
            while j < len(tokens):
                t = tokens[j]
                if t in _GIT_SKIP_FLAGS:
                    j += 2          # flag + following value
                elif t.startswith('-'):
                    j += 1          # boolean flag or --flag=value one-token form
                else:
                    results.append((t.lower(), tokens[j + 1:]))
                    break
    return results


def git_subcmd_is_critical(cmd):
    """True if cmd contains a critical git subcommand, position-independently.

    Catches git -C <path> push (and similar) that the CRITICAL_BASH regexes
    miss because the global flag sits between 'git' and the subcommand.
    Works alongside the existing patterns (additive, no regressions).
    """
    for subcmd, rest in _extract_git_subcmds(cmd):
        required = _GIT_CRITICAL_SUBCMDS.get(subcmd)
        if subcmd not in _GIT_CRITICAL_SUBCMDS:
            continue
        if required is None:
            return True
        if re.search(re.escape(required) + r'\b', ' '.join(rest)):
            return True
    return False


def http_egress_critical(cmd):
    """True if cmd is a curl/wget to a non-allowlisted external host.

    curl/wget only. The sibling gate extra_egress_critical() extends the same
    host-allowlist model to interpreter fetches (python -c / node -e), raw
    sockets (nc/ncat) and httpie. The hook stays fail-open for anything it
    still can't parse.
    """
    if not re.search(r"\b(curl|wget)\b", cmd, re.I):
        return False
    hosts = _URL_HOST_RX.findall(cmd)
    if not hosts:
        # curl/wget present but no literal http(s):// host (URL built from a
        # variable, e.g. `curl "$U"`). FAIL-SECURE: cannot prove it is internal,
        # so gate it (Orin decision, 2026-07-05). The fleet's own curls are all
        # literal, so this rarely fires.
        return True
    return any(not _host_allowlisted(h) for h in hosts)


# --- extended egress: interpreters / raw sockets / httpie --------------------
# http_egress_critical only sees curl/wget, so an agent could exfiltrate via
# `python -c 'requests.get(...)'`, `node -e 'fetch(...)'`, `nc host port` or the
# httpie `http`/`https` CLI and auto-allow (F3 finding, Orin-approved 2026-07-14).
# extra_egress_critical() applies the SAME HTTP_HOST_ALLOWLIST gate to those
# vectors. Each call's hosts are scoped to that call (the interpreter's inline
# code argument, or the shell segment for nc/httpie) so a host in one call
# cannot mask a variable-host connection in another. It is deliberately
# fail-secure: a net-capable call
# whose target host cannot be PROVEN allowlisted is treated as critical (routed
# to Orin, never a deadlock). Scope stays honest: only INLINE interpreter code
# (-c / -e / -m module) is parsed, not `python script.py`; scheme-less host
# extraction for nc/httpie is coarse (a dotted filename argument can also trip
# the gate) -- fail-secure by design, since the fleet uses none of these for
# egress today. The hook remains fail-open on any parse error.

# Quoted hostname literal, e.g. socket.connect(("evil.com", 443)) or "localhost".
# Requires a dotted TLD or explicit loopback so quoted module names ("https",
# "node-fetch") and the URL string itself are not mistaken for a bare host.
_QUOTED_HOST_RX = re.compile(
    r"""['"]((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}|localhost|127\.0\.0\.1)['"]""",
    re.I)
# Scheme-less hostname anywhere in a segment (nc/httpie targets carry no
# http:// scheme). Same dotted-TLD-or-loopback shape.
_HOSTISH_RX = re.compile(
    r"\b((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}|localhost)\b", re.I)

# Python inline-code network capability. `requests`/`urllib`/... imply an HTTP
# client; bare `socket` is NOT enough (socket.gethostname() is local) -- require
# an actual outbound call so local diagnostics don't trip the gate.
_PY_NET_RX = re.compile(
    r"\b(?:urllib|urlopen|urlretrieve|requests|httpx|aiohttp|http\.client|"
    r"httplib|pycurl|websockets?|ftplib|smtplib)\b", re.I)
_PY_SOCKET_RX = re.compile(
    r"\bsocket\b.*?\.(?:connect|create_connection|sendto|sendall)\b", re.S | re.I)
# Node inline-code network capability.
_NODE_NET_RX = re.compile(
    r"""\bfetch\s*\(|"""
    r"""\bhttps?\s*\.\s*(?:get|request)\b|"""
    r"""\bnet\s*\.\s*(?:connect|createConnection)\b|"""
    r"""require\(\s*['"](?:node:)?(?:https?|net|tls|dgram|axios|node-fetch|got|undici|request)['"]\s*\)|"""
    r"""(?:import\b|from\b)[^;\n]*['"](?:node:)?(?:https?|net|axios|node-fetch|got|undici)['"]""",
    re.I)


def _egress_hosts(code):
    """Provable hosts in interpreter code: literal URLs + quoted names."""
    return _URL_HOST_RX.findall(code) + _QUOTED_HOST_RX.findall(code)


# Inline-code argument of an interpreter: the quoted string after -c / -e (or a
# single bare token). Matched WITHOUT splitting on ';' first, because Python's
# statement separator ';' lives inside that quoted code and must stay with it.
_INLINE_ARG = r"""('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|\S+)"""


def _py_code_args(cmd):
    return re.findall(r"\bpython[0-9.]*\b[^\n]*?\s-c\s+" + _INLINE_ARG, cmd, re.I)


def _node_code_args(cmd):
    return re.findall(
        r"\b(?:node|nodejs)\b[^\n]*?\s(?:-e|-p|--eval|--print)\s+" + _INLINE_ARG, cmd, re.I)


def _py_modules(cmd):
    # `python -m <module>`: classify the module name only, so `-m pip install
    # requests` (pip fetching a net-named package) is NOT read as net code.
    return re.findall(r"\bpython[0-9.]*\s+(?:-\S+\s+)*?-m\s+(\S+)", cmd, re.I)


def _nc_is_listener(seg):
    for tok in seg.split():
        if tok == "--listen":
            return True
        if re.fullmatch(r"-[a-z]*l[a-z]*", tok, re.I):  # -l, -lv, -lnvp ...
            return True
    return False


def _nc_seg_egress(seg):
    if not re.search(r"\b(?:nc|ncat|netcat)\b", seg, re.I):
        return False
    return not _nc_is_listener(seg)  # listener is inbound, not egress


def _scheme_less_hosts(seg):
    return _URL_HOST_RX.findall(seg) + _HOSTISH_RX.findall(seg)


def _httpie_seg(seg):
    # `http`/`https` as the command word. A URL is `http://...` (no space); the
    # httpie CLI is `http ` + args. Match only at segment start, after leading
    # sudo / VAR=val assignments -- never mid-command (curl https://... is safe).
    s = re.sub(r"^(?:sudo\s+|\w+=\S+\s+)+", "", seg.strip())
    return bool(re.match(r"https?\s+\S", s, re.I))


def _gate(hosts):
    # Fail-secure: no provable host, or any host off the allowlist -> critical.
    return not hosts or any(not _host_allowlisted(h) for h in hosts)


def extra_egress_critical(cmd):
    """Egress via interpreters / raw sockets / httpie -- same allowlist gate."""
    # Interpreter inline code: parsed whole (its own ';' must not be split on).
    for code in _py_code_args(cmd):
        if _PY_NET_RX.search(code) or _PY_SOCKET_RX.search(code):
            if _gate(_egress_hosts(code)):
                return True
    for code in _node_code_args(cmd):
        if _NODE_NET_RX.search(code):
            if _gate(_egress_hosts(code)):
                return True
    for mod in _py_modules(cmd):
        if _PY_NET_RX.search(mod) and _gate(_egress_hosts(cmd)):
            return True
    # nc / httpie: per shell-segment (their args carry no inner ';').
    for seg in re.split(r"[;&|\n]", cmd):
        if _nc_seg_egress(seg) or _httpie_seg(seg):
            if _gate(_scheme_less_hosts(seg)):
                return True
    return False


def is_critical(tool, ti):
    if re.search(r"send_email", tool, re.I):
        return ("email", "send_email")
    if tool == "Bash":
        raw = str(ti.get("command", "") or "")
        cmd = clean_cmd(raw)
        for p in CRITICAL_BASH:
            if re.search(p, cmd, re.I):
                return ("bash", raw)
        if git_subcmd_is_critical(cmd):
            return ("bash", raw)
        if http_egress_critical(cmd) or extra_egress_critical(cmd):
            return ("http_external", raw)
    if tool in WRITE_TOOLS:
        path = str(ti.get("file_path", "") or ti.get("notebook_path", "") or "")
        norm = os.path.normpath(path) if path else path
        # Safe-write carve-out wins over the critical-write gate: a memory-file
        # write is routine. Traversal is defeated by normpath above -- a path
        # that resolves out of .../memory/ no longer matches SAFE and falls
        # through to the critical check.
        if not any(re.search(p, norm) for p in SAFE_WRITE_PATH):
            for p in CRITICAL_WRITE_PATH:
                if re.search(p, norm):
                    return ("write", f"{tool} -> {path}")
    return None


def sig_for(tool, payload):
    h = hashlib.sha256((str(tool) + "\0" + str(payload)).encode("utf-8", "replace"))
    return h.hexdigest()[:12]


def approvals_path(agent, suffix):
    d = os.path.join(PROJECT_ROOT, "store", "approvals")
    try:
        os.makedirs(d, exist_ok=True)
    except Exception:
        pass
    return os.path.join(d, f"{agent}.{suffix}.json")


def cmd_snapshot_path(agent, sig):
    """On-disk full-payload snapshot for a pending critical action.

    The inline Orin ping is length-capped, so a dangerous tail past the cutoff
    could otherwise stay hidden from the grantor while the sig/grant still apply
    to the WHOLE command (GhostApproval pattern, Dex incident 2026-07-14).
    grant-approval.py reads this file back and echoes it before granting.
    """
    d = os.path.join(PROJECT_ROOT, "store", "approvals")
    try:
        os.makedirs(d, exist_ok=True)
    except Exception:
        pass
    return os.path.join(d, f"{agent}.{sig}.cmd")


def load_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return default


def save_json(path, data):
    try:
        with open(path, "w") as f:
            json.dump(data, f)
    except Exception:
        pass


def token():
    try:
        with open(os.path.join(PROJECT_ROOT, "store", ".dashboard-token")) as f:
            return f.read().strip()
    except Exception:
        return None


def ping_orin(agent, kind, payload, sig):
    tok = token()
    if not tok:
        return
    # Persist the FULL payload so Orin can review exactly what will run before
    # granting -- the inline ping below is length-capped and a dangerous tail
    # must never hide past the cutoff (GhostApproval defense, 2026-07-14).
    snap = cmd_snapshot_path(agent, sig)
    try:
        with open(snap, "w") as f:
            f.write(payload)
    except Exception:
        snap = None
    snap_ref = snap or f"store/approvals/{agent}.{sig}.cmd"
    LIMIT = 400
    if len(payload) <= LIMIT:
        short = payload
        tail_warn = ""
    else:
        short = payload[:LIMIT] + f"\n[TRUNCATED {len(payload) - LIMIT} char -- TELJES parancs: {snap_ref}]"
        tail_warn = (f"FIGYELEM: a parancs csonkolva -- grant ELOTT nezd meg a teljeset: "
                     f"cat {snap_ref}\n")
    content = (
        f"[Permission-kérés @{agent}] KRITIKUS művelet jóváhagyásra vár ({kind}). "
        f"sig={sig} (SHA-256[:12])\nParancs/tool:\n{short}\n\n{tail_warn}"
        f"Ha OK: futtasd `python3 {RUNTIME_HOOKS}/grant-approval.py {agent} {sig}` "
        f"(kiirja a TELJES parancsot ellenorzesre, jóváhagyja 15 percre + szól {agent}-nek hogy futtassa újra). "
        f"Kétes esetben kérdezd Norbi-t Telegramon, és csak az ő jóváhagyása után grantolj. "
        f"Default-deny: ha nem vagy biztos, NE grantolj."
    )
    data = json.dumps({"from": agent, "to": MAIN_AGENT, "content": content}).encode()
    req = urllib.request.Request(
        f"{DASHBOARD}/api/messages", data=data,
        headers={"Content-Type": "application/json",
                 "Authorization": f"Bearer {tok}"})
    try:
        urllib.request.urlopen(req, timeout=8)
    except Exception:
        pass


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)  # malformed -> defer, never break the agent

    tool = str(data.get("tool_name", ""))
    ti = data.get("tool_input", {}) or {}
    cwd = str(data.get("cwd", "") or "")

    agent = ""
    for src in (cwd, os.environ.get("CLAUDE_PROJECT_DIR", "")):
        m = re.search(r"/agents/([^/]+)", src or "")
        if m:
            agent = m.group(1)
            break
    if not agent:
        basename = os.path.basename(os.environ.get("CLAUDE_PROJECT_DIR", "")) or "unknown"
        # Main agent's PROJECT_DIR is the repo root (basename = "marveen"), not "orin"
        agent = MAIN_AGENT if basename == os.path.basename(PROJECT_ROOT) else basename

    crit = is_critical(tool, ti)
    if not crit:
        allow()

    kind, payload = crit
    sig = sig_for(tool, ti if tool != "Bash" else ti.get("command", ""))

    # 1) already granted (and unexpired)?
    appr_path = approvals_path(agent, "granted")
    appr = load_json(appr_path, {})
    now = time.time()
    ent = appr.get(sig)
    if isinstance(ent, dict) and ent.get("expires", 0) > now:
        # consume single-use so a granted token can't be reused indefinitely
        appr.pop(sig, None)
        save_json(appr_path, appr)
        try:
            os.remove(cmd_snapshot_path(agent, sig))
        except Exception:
            pass
        emit("allow")

    # 2) route to Orin, dedupe pings
    notif_path = approvals_path(agent, "notified")
    notif = load_json(notif_path, {})
    last = notif.get(sig, 0)
    if now - last > NOTIFY_DEDUPE:
        ping_orin(agent, kind, payload, sig)
        notif[sig] = now
        # prune old
        notif = {k: v for k, v in notif.items() if now - v < 3600}
        save_json(notif_path, notif)

    emit("deny",
         f"Kritikus muvelet (sig={sig}) -- Orin jovahagyasara var. "
         f"ALLJ MEG, NE ismeteld ujra automatikusan. Orin szol ha mehet, "
         f"akkor futtasd ujra UGYANEZT a parancsot.")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # absolute fail-open
        try:
            allow()
        except Exception:
            sys.exit(0)
