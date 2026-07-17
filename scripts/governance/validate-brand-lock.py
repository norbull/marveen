#!/usr/bin/env python3
"""Standalone validator for a client's brand.lock.json.

Read-only: it never writes, and it is NOT wired into any runtime gate. It
validates the schema (see docs/client-deliverable-governance.md) and, for a
validated/frozen lock, detects master-reference drift by comparing each
recorded sha256 against the current on-disk hash.

    python3 scripts/governance/validate-brand-lock.py [--root <client_root>] <path/to/brand.lock.json>

master_refs paths are client-root-relative. If --root is omitted, the client
root is inferred: the lock's directory, or its parent when the lock sits in a
numbered zone folder (e.g. 04_Brand/brand.lock.json -> client root is the
parent of 04_Brand).

Exit codes:
    0  valid, no drift
    1  schema error (or file missing / unreadable / bad JSON)
    2  schema ok but master drift detected (a validated/frozen lock is stale)

The pure functions (validate_schema, check_drift) take already-parsed data and
a resolver, so the self-tests can drive them without touching the filesystem.
"""
import sys, os, json, hashlib, re

VALID_STATUSES = ("draft", "validated", "frozen")
SCHEMA_VERSION = 1


def validate_schema(data):
    """Return a list of human-readable schema errors ([] == valid)."""
    errors = []
    if not isinstance(data, dict):
        return ["top-level value must be a JSON object"]

    ver = data.get("version")
    if not isinstance(ver, int) or isinstance(ver, bool):
        errors.append("version: required int")
    elif ver != SCHEMA_VERSION:
        errors.append(f"version: unsupported {ver!r} (expected {SCHEMA_VERSION})")

    status = data.get("status")
    if status not in VALID_STATUSES:
        errors.append(f"status: required one of {VALID_STATUSES}, got {status!r}")

    refs = data.get("master_refs")
    if not isinstance(refs, list):
        errors.append("master_refs: required array")
    else:
        for i, ref in enumerate(refs):
            if not isinstance(ref, dict):
                errors.append(f"master_refs[{i}]: must be an object")
                continue
            path = ref.get("path")
            if not isinstance(path, str) or not path:
                errors.append(f"master_refs[{i}].path: required non-empty string")
            elif os.path.isabs(path) or ".." in path.replace("\\", "/").split("/"):
                errors.append(f"master_refs[{i}].path: must stay inside client root (no abs / '..'): {path!r}")
            sha = ref.get("sha256")
            if not isinstance(sha, str) or not _is_hex_sha256(sha):
                errors.append(f"master_refs[{i}].sha256: required 64-char lowercase hex")
            role = ref.get("role")
            if not isinstance(role, str) or not role:
                errors.append(f"master_refs[{i}].role: required non-empty string")

    # validated_by / validated_at are mandatory once the lock leaves draft.
    if status in ("validated", "frozen"):
        if not data.get("validated_by"):
            errors.append("validated_by: required when status is validated/frozen")
        if not data.get("validated_at"):
            errors.append("validated_at: required when status is validated/frozen")

    # Optional QC block (Iris rubric parameters). Structurally checked only when
    # present -- the rubric evolves, so unknown keys are tolerated, but a present
    # field must carry the right shape so the PR#5 QC-gate can measure against it.
    if "qc" in data:
        _validate_qc(data["qc"], errors)

    return errors


_HEX_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")


def _validate_qc(qc, errors):
    """Validate the optional QC-rubric block (colors, typography, logo,
    prohibited_elements, platform_ratios). Permissive: every field is optional,
    but a present field must be the right type."""
    if not isinstance(qc, dict):
        errors.append("qc: must be an object")
        return

    colors = qc.get("colors")
    if colors is not None:
        if not isinstance(colors, list):
            errors.append("qc.colors: must be an array")
        else:
            for i, c in enumerate(colors):
                if not isinstance(c, dict):
                    errors.append(f"qc.colors[{i}]: must be an object")
                    continue
                if not isinstance(c.get("hex"), str) or not _HEX_COLOR.match(c.get("hex", "")):
                    errors.append(f"qc.colors[{i}].hex: required '#RRGGBB'")
                tol = c.get("deltaE_tolerance")
                if tol is not None and (not isinstance(tol, (int, float)) or isinstance(tol, bool) or tol < 0):
                    errors.append(f"qc.colors[{i}].deltaE_tolerance: must be a number >= 0")

    typo = qc.get("typography")
    if typo is not None:
        if not isinstance(typo, dict):
            errors.append("qc.typography: must be an object")
        else:
            for key in ("families", "weights"):
                v = typo.get(key)
                if v is not None and not isinstance(v, list):
                    errors.append(f"qc.typography.{key}: must be an array")

    logo = qc.get("logo")
    if logo is not None:
        if not isinstance(logo, dict):
            errors.append("qc.logo: must be an object")
        else:
            rv = logo.get("required_variants")
            if rv is not None and not isinstance(rv, list):
                errors.append("qc.logo.required_variants: must be an array")

    prohibited = qc.get("prohibited_elements")
    if prohibited is not None and not isinstance(prohibited, list):
        errors.append("qc.prohibited_elements: must be an array")

    ratios = qc.get("platform_ratios")
    if ratios is not None and not isinstance(ratios, dict):
        errors.append("qc.platform_ratios: must be an object of name -> 'W:H'")


def _is_hex_sha256(s):
    if len(s) != 64:
        return False
    return all(c in "0123456789abcdef" for c in s)


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def check_drift(data, resolve):
    """Compare each recorded sha256 to the current hash.

    `resolve(path)` maps a client-root-relative path to the current on-disk
    sha256, or None if the file is missing. Drift is only meaningful for a
    validated/frozen lock; a draft lock returns [] (nothing pinned yet).
    Returns a list of drift descriptions ([] == no drift).
    """
    if data.get("status") not in ("validated", "frozen"):
        return []
    drift = []
    for ref in data.get("master_refs", []):
        path, recorded = ref.get("path"), ref.get("sha256")
        current = resolve(path)
        if current is None:
            drift.append(f"{path}: master file missing on disk")
        elif current != recorded:
            drift.append(f"{path}: sha256 drift (recorded {recorded[:12]}.., disk {current[:12]}..)")
    return drift


def _resolver(client_root):
    def resolve(rel):
        p = os.path.normpath(os.path.join(client_root, rel))
        return sha256_file(p) if os.path.isfile(p) else None
    return resolve


def _is_numbered_zone(name):
    return bool(re.match(r"^\d{2}_", name))


def infer_client_root(lock_path):
    """Client root = the lock's directory, or its parent when the lock sits in
    a numbered zone folder (04_Brand/brand.lock.json -> parent of 04_Brand)."""
    lock_dir = os.path.dirname(os.path.abspath(lock_path))
    if _is_numbered_zone(os.path.basename(lock_dir)):
        return os.path.dirname(lock_dir)
    return lock_dir


def main(argv):
    args = argv[1:]
    root_override = None
    if len(args) >= 2 and args[0] == "--root":
        root_override, args = args[1], args[2:]
    if len(args) != 1:
        print("usage: validate-brand-lock.py [--root <client_root>] <path/to/brand.lock.json>",
              file=sys.stderr)
        return 1
    lock_path = args[0]
    try:
        with open(lock_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        print(f"ERROR: not found: {lock_path}", file=sys.stderr)
        return 1
    except (OSError, json.JSONDecodeError) as e:
        print(f"ERROR: cannot read {lock_path}: {e}", file=sys.stderr)
        return 1

    errors = validate_schema(data)
    if errors:
        print(f"SCHEMA INVALID: {lock_path}")
        for e in errors:
            print(f"  - {e}")
        return 1

    client_root = root_override or infer_client_root(lock_path)
    drift = check_drift(data, _resolver(client_root))
    if drift:
        print(f"DRIFT: {lock_path} (status={data.get('status')}, root={client_root})")
        for d in drift:
            print(f"  - {d}")
        return 2

    print(f"OK: {lock_path} (status={data.get('status')}, {len(data.get('master_refs', []))} master_refs)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
