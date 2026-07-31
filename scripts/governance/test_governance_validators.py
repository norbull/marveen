#!/usr/bin/env python3
"""Self-tests for the governance validators.

Both validators have hyphenated filenames (can't be normal imports), so they
are loaded by path via importlib -- same pattern as test_permission_router.py.

    python3 scripts/governance/test_governance_validators.py

Exit 0 = all pass.
"""
import sys, os, importlib.util

_HERE = os.path.dirname(os.path.abspath(__file__))


def _load(fname, modname):
    spec = importlib.util.spec_from_file_location(modname, os.path.join(_HERE, fname))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


BL = _load("validate-brand-lock.py", "validate_brand_lock")
CS = _load("validate-client-structure.py", "validate_client_structure")

_fails = []


def check(label, cond):
    if not cond:
        _fails.append(label)
        print(f"  FAIL: {label}")
    else:
        print(f"  ok  : {label}")


def _valid_draft():
    return {
        "version": 1, "status": "draft",
        "master_refs": [{"path": "04_Brand/logo.png", "sha256": "a" * 64, "role": "logo"}],
        "validated_by": None, "validated_at": None,
    }


def _valid_validated():
    d = _valid_draft()
    d.update(status="validated", validated_by="orin", validated_at="2026-07-17T10:00:00")
    return d


# ---- brand.lock schema ------------------------------------------------------
print("brand.lock validate_schema:")
check("valid draft passes", BL.validate_schema(_valid_draft()) == [])
check("valid validated passes", BL.validate_schema(_valid_validated()) == [])
check("non-object rejected", BL.validate_schema([]) != [])

d = _valid_draft(); del d["version"]
check("missing version rejected", any("version" in e for e in BL.validate_schema(d)))

d = _valid_draft(); d["version"] = True
check("bool version rejected (not int)", any("version" in e for e in BL.validate_schema(d)))

d = _valid_draft(); d["status"] = "bogus"
check("bad status rejected", any("status" in e for e in BL.validate_schema(d)))

d = _valid_draft(); d["master_refs"] = "nope"
check("non-array master_refs rejected", any("master_refs" in e for e in BL.validate_schema(d)))

d = _valid_draft(); d["master_refs"][0]["path"] = "../escape.png"
check("path traversal rejected", any("client root" in e for e in BL.validate_schema(d)))

d = _valid_draft(); d["master_refs"][0]["path"] = "/abs/logo.png"
check("absolute path rejected", any("client root" in e for e in BL.validate_schema(d)))

d = _valid_draft(); d["master_refs"][0]["sha256"] = "XYZ"
check("bad sha256 rejected", any("sha256" in e for e in BL.validate_schema(d)))

d = _valid_draft(); del d["master_refs"][0]["role"]
check("missing role rejected", any("role" in e for e in BL.validate_schema(d)))

d = _valid_validated(); d["validated_by"] = None
check("validated w/o validated_by rejected", any("validated_by" in e for e in BL.validate_schema(d)))

d = _valid_validated(); d["validated_at"] = None
check("validated w/o validated_at rejected", any("validated_at" in e for e in BL.validate_schema(d)))

# ---- brand.lock optional QC block (Iris rubric) -----------------------------
print("brand.lock QC block:")
def _with_qc(qc):
    d = _valid_draft(); d["qc"] = qc; return d

good_qc = {
    "colors": [{"hex": "#1A2B3C", "deltaE_tolerance": 3.0}],
    "typography": {"families": ["Inter"], "weights": [400, 700]},
    "logo": {"required_variants": ["primary", "mono"], "placement_rules": {"min_clear_space": 16}},
    "prohibited_elements": ["drop_shadow"],
    "platform_ratios": {"instagram_post": "1:1", "story": "9:16"},
}
check("valid qc block passes", BL.validate_schema(_with_qc(good_qc)) == [])
check("qc absent is fine", BL.validate_schema(_valid_draft()) == [])
check("qc non-object rejected", any("qc:" in e for e in BL.validate_schema(_with_qc("nope"))))
check("bad hex color rejected", any("hex" in e for e in BL.validate_schema(_with_qc({"colors": [{"hex": "123456"}]}))))
check("negative deltaE rejected", any("deltaE" in e for e in BL.validate_schema(_with_qc({"colors": [{"hex": "#123456", "deltaE_tolerance": -1}]}))))
check("typography.families non-array rejected", any("families" in e for e in BL.validate_schema(_with_qc({"typography": {"families": "Inter"}}))))
check("prohibited_elements non-array rejected", any("prohibited_elements" in e for e in BL.validate_schema(_with_qc({"prohibited_elements": "x"}))))
check("platform_ratios non-object rejected", any("platform_ratios" in e for e in BL.validate_schema(_with_qc({"platform_ratios": ["1:1"]}))))

# ---- brand.lock drift -------------------------------------------------------
print("brand.lock check_drift:")
check("draft never drifts", BL.check_drift(_valid_draft(), lambda p: "deadbeef") == [])

matching = lambda p: "a" * 64
check("validated + matching sha -> no drift", BL.check_drift(_valid_validated(), matching) == [])

mismatch = lambda p: "b" * 64
check("validated + mismatched sha -> drift", len(BL.check_drift(_valid_validated(), mismatch)) == 1)

missing = lambda p: None
drift = BL.check_drift(_valid_validated(), missing)
check("validated + missing file -> drift", len(drift) == 1 and "missing" in drift[0])

frozen = _valid_validated(); frozen["status"] = "frozen"
check("frozen also drift-checked", len(BL.check_drift(frozen, mismatch)) == 1)

# ---- infer_client_root ------------------------------------------------------
print("brand.lock infer_client_root:")
check("numbered zone -> parent",
      BL.infer_client_root("/x/clients/Moonwright/04_Brand/brand.lock.json")
      == os.path.normpath("/x/clients/Moonwright"))
check("non-numbered -> lock dir",
      BL.infer_client_root("/x/clients/Moonwright/brand.lock.json")
      == os.path.normpath("/x/clients/Moonwright"))

# ---- client structure analyze ----------------------------------------------
print("client-structure analyze:")
full = ["00_Brief", "01_Research", "05_Website", "06_Video", "07_Social", "99_Deliverables"]
r = CS.analyze(full)
check("all deliverable zones present -> none missing", r["missing_deliverable"] == [])
check("present deliverable = 4", len(r["present_deliverable"]) == 4)
check("01_Research is known_optional", "01_Research" in r["known_optional"])

r2 = CS.analyze(["05_Website", "RandomFolder", "02_Strategy"])
check("missing deliverable zones detected", set(r2["missing_deliverable"]) == {"06_Video", "07_Social", "99_Deliverables"})
check("unconventional folder flagged", r2["unconventional"] == ["RandomFolder"])
check("02_Strategy is known_optional", r2["known_optional"] == ["02_Strategy"])

r3 = CS.analyze([])
check("empty client -> all deliverable zones missing", len(r3["missing_deliverable"]) == 4)

# ---- summary ----------------------------------------------------------------
if _fails:
    print(f"\n{len(_fails)} FAILED: {_fails}")
    sys.exit(1)
print("\nALL PASS")
sys.exit(0)
