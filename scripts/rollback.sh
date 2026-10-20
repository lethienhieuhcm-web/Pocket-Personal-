#!/usr/bin/env bash
# Rollback worker ve mot git ref (commit/tag) — stockui Dot C4.
# Dung worktree tam tai ref do roi deploy tu do, KHONG dong vao working tree hien tai.
# Usage: scripts/rollback.sh <git-ref> [--staging]
set -euo pipefail
REF="${1:?usage: rollback.sh <git-ref> [--staging]}"
MODE="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WT="/tmp/rollback-wt-$$"
cd "$ROOT"
git rev-parse --verify "$REF" >/dev/null
git worktree add --detach "$WT" "$REF" >/dev/null
cleanup() { git worktree remove --force "$WT" >/dev/null 2>&1 || true; }
trap cleanup EXIT
echo "[rollback] deploy $REF tu worktree tam..."
if [ "$MODE" = "--staging" ]; then
  CF_DEPLOY_SRC="$WT" CF_WORKER_NAME=fancy-wood-2b3c-staging \
  CF_D1_ID=79d8f828-cd52-418a-9f45-d5eb6556ebc8 \
  CF_VERIFY_HOST=staging.lethanhdong.one CF_PURGE=0 CF_DRIFT=0 \
    python3 "$WT/scripts/cf_deploy.py"
else
  CF_DEPLOY_SRC="$WT" python3 "$WT/scripts/cf_deploy.py"
fi
echo "[rollback] xong: da deploy ref $REF (verify LIVE trong output tren)."
