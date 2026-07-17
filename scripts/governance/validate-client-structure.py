#!/usr/bin/env python3
"""Read-only reporter for a client's numbered-taxonomy structure.

Reports which canonical zones are present/missing and flags unconventional
folders under clients/<Client>/. It NEVER writes and is NOT a gate: default exit
is 0 regardless of findings. Pass --strict to get a non-zero exit for CI when
anything is off (missing deliverable zone, unconventional folder).

    python3 scripts/governance/validate-client-structure.py [--strict] <client_dir>

See docs/client-deliverable-governance.md for the taxonomy. The four deliverable
zones are approved/fixed; other NN_Name folders are known-optional (reported,
never an error). Only non-numbered / unconventional folders are warned.
"""
import sys, os, re

# Approved, fixed deliverable zones -- the future write-gate scopes to these.
DELIVERABLE_ZONES = ("05_Website", "06_Video", "07_Social", "99_Deliverables")

# Proposed non-deliverable convention (informational only).
KNOWN_NON_DELIVERABLE = ("00_Brief", "01_Research", "02_Strategy", "03_Product_Bible", "04_Brand")

_NUMBERED = re.compile(r"^\d{2}_")


def analyze(subdirs):
    """Classify a client's immediate subdirectory names.

    Returns a dict: missing_deliverable, present_deliverable, known_optional,
    unconventional, has_brand_lock is decided by the caller (file, not dir).
    Pure -- takes a list of folder names, so it is unit-testable.
    """
    names = set(subdirs)
    present_deliverable = [z for z in DELIVERABLE_ZONES if z in names]
    missing_deliverable = [z for z in DELIVERABLE_ZONES if z not in names]
    known_optional = []
    unconventional = []
    for n in subdirs:
        if n in DELIVERABLE_ZONES:
            continue
        if _NUMBERED.match(n):
            known_optional.append(n)  # any other NN_ folder: fine, just noted
        else:
            unconventional.append(n)
    return {
        "present_deliverable": present_deliverable,
        "missing_deliverable": missing_deliverable,
        "known_optional": sorted(known_optional),
        "unconventional": sorted(unconventional),
    }


def _subdirs(client_dir):
    return sorted(
        n for n in os.listdir(client_dir)
        if os.path.isdir(os.path.join(client_dir, n)) and not n.startswith(".")
    )


def _find_brand_lock(client_dir):
    """First brand.lock.json under the client dir (client root or any zone)."""
    for dirpath, _dirs, files in os.walk(client_dir):
        if "brand.lock.json" in files:
            return os.path.relpath(os.path.join(dirpath, "brand.lock.json"), client_dir)
    return None


def main(argv):
    args = argv[1:]
    strict = False
    if args and args[0] == "--strict":
        strict, args = True, args[1:]
    if len(args) != 1:
        print("usage: validate-client-structure.py [--strict] <client_dir>", file=sys.stderr)
        return 1
    client_dir = args[0]
    if not os.path.isdir(client_dir):
        print(f"ERROR: not a directory: {client_dir}", file=sys.stderr)
        return 1

    r = analyze(_subdirs(client_dir))
    brand_lock = _find_brand_lock(client_dir)

    print(f"CLIENT STRUCTURE: {client_dir}")
    print(f"  deliverable zones present : {r['present_deliverable'] or '(none)'}")
    print(f"  deliverable zones missing : {r['missing_deliverable'] or '(none)'}")
    print(f"  other numbered zones      : {r['known_optional'] or '(none)'}")
    print(f"  unconventional folders    : {r['unconventional'] or '(none)'}")
    print(f"  brand.lock.json           : {brand_lock or '(missing)'}")

    off = bool(r["missing_deliverable"] or r["unconventional"])
    if strict and off:
        print("STRICT: structure has missing deliverable zones or unconventional folders", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
