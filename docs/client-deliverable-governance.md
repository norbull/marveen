# Client Deliverable Governance

Canonical structure and integrity contract for Moonwright client work under
`clients/<ClientName>/`. This document is the single source of truth for the
numbered taxonomy and the `brand.lock.json` schema. Two standalone validators
enforce it (both read-only, zero side effects):

- `scripts/governance/validate-client-structure.py` -- reports taxonomy drift.
- `scripts/governance/validate-brand-lock.py` -- validates a brand.lock file
  and detects master-reference drift.

Neither validator is wired into any runtime gate in this PR. The permission
router write-gate (a later phase) will reuse the same schema and hashing rules.

## Numbered taxonomy

Client work lives under numbered zones so ordering, tooling and the write-gate
scope are unambiguous. `clients/` is canonical; the old `projects/` tree is
retired.

| Zone               | Purpose                                   | Deliverable zone |
|--------------------|-------------------------------------------|:----------------:|
| `00_Brief`         | Intake, scope, client brief               |                  |
| `01_Research`      | Market/competitor research, benchmarks    |                  |
| `02_Strategy`      | Positioning, concept, direction           |                  |
| `03_Product_Bible` | Product master views, spec renders        |                  |
| `04_Brand`         | Brand masters + `brand.lock.json`         |                  |
| `05_Website`       | Website deliverables                      |        yes        |
| `06_Video`         | Video deliverables                        |        yes        |
| `07_Social`        | Social deliverables                       |        yes        |
| `99_Deliverables`  | Final packaged exports                     |        yes        |

**Approval status.** The four deliverable zones (`05_Website`, `06_Video`,
`07_Social`, `99_Deliverables`) are approved and fixed -- the write-gate will
scope to exactly these. The non-deliverable zones (`00`-`04`) are the proposed
convention; the validator treats any other numbered `NN_Name` folder as a
known-optional zone (reported, never an error) so the taxonomy can be finalized
without churning this PR. Only non-numbered / unconventional folders are warned.

## brand.lock.json schema

One `brand.lock.json` per client, conventionally at `04_Brand/brand.lock.json`
(the validator accepts it anywhere under the client root). It has **two parts**:

1. **`master_refs`** -- pins the approved brand masters by content hash, so the
   permission-router write-gate (PR#2) can prove a deliverable is built against
   the validated masters, not drifted copies.
2. **`qc`** (optional) -- the QC-rubric parameters (Iris) the PR#5 QC-gate
   measures a deliverable against: allowed colors, typography, logo rules,
   prohibited elements, platform aspect ratios. Without these the QC-gate has
   nothing to measure, so a client under QC governance carries this block.

```json
{
  "version": 1,
  "status": "draft",
  "master_refs": [
    { "path": "04_Brand/logo_primary.png", "sha256": "<hex>", "role": "logo" }
  ],
  "qc": {
    "colors": [ { "hex": "#1A2B3C", "deltaE_tolerance": 3.0 } ],
    "typography": { "families": ["Inter"], "weights": [400, 700] },
    "logo": { "required_variants": ["primary", "mono"], "placement_rules": { "min_clear_space": 16 } },
    "prohibited_elements": ["drop_shadow"],
    "platform_ratios": { "instagram_post": "1:1", "story": "9:16" }
  },
  "validated_by": null,
  "validated_at": null
}
```

### Fields

- `version` (int, required) -- schema version, currently `1`.
- `status` (enum, required) -- one of:
  - `draft` -- work in progress, masters not yet approved.
  - `validated` -- masters approved and hash-pinned. Flipping to this status is
    an Orin-only action (enforced by the write-gate in a later phase).
  - `frozen` -- locked; no further master changes expected.
- `master_refs` (array, required) -- each entry:
  - `path` (string, required) -- client-root-relative path to the master file.
    Must not escape the client root (no `..` traversal, no absolute path).
  - `sha256` (string, required) -- lowercase hex sha256 of the master file as
    recorded at approval time.
  - `role` (string, required) -- free-form label (`logo`, `color`,
    `typography`, `product_master`, ...).
- `validated_by` (string, required when `status` != `draft`) -- actor that
  validated (e.g. `orin`).
- `validated_at` (string, required when `status` != `draft`) -- ISO 8601 or unix
  timestamp of validation.
- `qc` (object, optional) -- QC-rubric parameters. Every field is optional and
  the rubric may add keys over time, but a present field is shape-checked:
  - `colors` (array) -- each `{ hex: "#RRGGBB", deltaE_tolerance?: number>=0 }`.
    Allowed brand colors and the perceptual tolerance for a QC color match.
  - `typography` (object) -- `{ families?: string[], weights?: (string|int)[] }`.
  - `logo` (object) -- `{ required_variants?: string[], placement_rules?: any }`.
  - `prohibited_elements` (string[]) -- disallowed visual elements.
  - `platform_ratios` (object) -- name -> `"W:H"` aspect ratio per platform.

The `qc` block does not participate in the write-gate (that only reads
`master_refs` + `status`); it is consumed by the PR#5 QC-gate.

### Drift semantics

When `status` is `validated` or `frozen`, every `master_refs[].sha256` must
equal the **current on-disk** sha256 of the referenced file. A mismatch means
the pinned master changed after approval -- the validated status is stale. The
validator flags this as drift (exit code 2); the future write-gate treats drift
as "not validated" and blocks deliverable writes until re-validation.

## Usage

```bash
# Report taxonomy for a client (read-only; exit 0 always, --strict for CI)
python3 scripts/governance/validate-client-structure.py clients/Moonwright
python3 scripts/governance/validate-client-structure.py --strict clients/Moonwright

# Validate a brand.lock file (schema + drift). Exit 0 ok, 1 schema error, 2 drift
python3 scripts/governance/validate-brand-lock.py clients/Moonwright/04_Brand/brand.lock.json

# Run the validator self-tests
python3 scripts/governance/test_governance_validators.py
```
