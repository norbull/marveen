#!/usr/bin/env bash
# Idempotent installer: run the ops-hook self-heal immediately after any branch
# switch (kanban #106, worktree-guard half). A `git checkout` to a PR/upstream
# branch that lacks the fork-only ops files deletes them from disk; this
# post-checkout hook re-heals them the instant the switch happens, instead of
# waiting for the next periodic timer sweep. Auto-run by scripts/sync-hooks.sh
# on update (matches the install-*hook*.sh glob).
#
# Composes with any existing post-checkout hook via a post-checkout.d/
# dispatcher, exactly like install-git-guard-hook.sh does for pre-push.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOK_DIR="$(cd "$(git -C "$ROOT" rev-parse --git-common-dir)" && pwd)/hooks"
DISPATCH="$HOOK_DIR/post-checkout"
GUARD="$HOOK_DIR/post-checkout.d/10-ops-hook-selfheal"
MARK="marveen-post-checkout-dispatcher"
mkdir -p "$HOOK_DIR/post-checkout.d"

# The main tree the self-heal must protect. Baked in at install time: the hook
# runs from a shared .git/hooks dir (all worktrees), but self-heal always
# targets the primary install tree, never a throwaway worktree.
MAIN_TREE="$ROOT"

# 1. Guard sub-hook: on a real branch switch ($3==1) run the self-heal.
cat > "$GUARD" <<EOF
#!/usr/bin/env bash
# post-checkout args: \$1 prev-HEAD \$2 new-HEAD \$3 branch-flag (1=branch switch)
set -uo pipefail
[ "\${3:-0}" = "1" ] || exit 0                     # ignore file (path) checkouts
SELFHEAL="$MAIN_TREE/scripts/ops-hook-selfheal.sh"
[ -x "\$SELFHEAL" ] || exit 0
bash "\$SELFHEAL" >/dev/null 2>&1 || true          # never block the checkout
exit 0
EOF
chmod +x "$GUARD"

# 2. Dispatcher post-checkout: replay args to every post-checkout.d/* hook.
if [ -f "$DISPATCH" ] && ! grep -q "$MARK" "$DISPATCH" 2>/dev/null; then
  # Preserve a pre-existing, non-dispatcher post-checkout under post-checkout.d.
  mv "$DISPATCH" "$HOOK_DIR/post-checkout.d/00-existing-postcheckout"
  chmod +x "$HOOK_DIR/post-checkout.d/00-existing-postcheckout"
  echo "  (preserved existing post-checkout as post-checkout.d/00-existing-postcheckout)"
fi
cat > "$DISPATCH" <<EOF
#!/usr/bin/env bash
# $MARK : run every executable in post-checkout.d/, passing all args to each.
set -uo pipefail
HOOK_DIR="\$(cd "\$(dirname "\$0")" && pwd)"
for h in "\$HOOK_DIR"/post-checkout.d/*; do
  [ -x "\$h" ] || continue
  "\$h" "\$@" || true
done
exit 0
EOF
chmod +x "$DISPATCH"

echo "✓ worktree-guard post-checkout hook installed ($GUARD)"
