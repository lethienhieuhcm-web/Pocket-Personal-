#!/bin/bash
# Bundle worker/src/*.js into ../worker.js (Cloudflare Worker entry point)
set -e
cd "$(dirname "$0")"
npx esbuild src/index.js --bundle --format=esm --outfile=../worker.js
# Replace __BUILD__ with timestamp for X-Build-Id header (cache-buster).
# cf_deploy.py passes BUILD_ID as $1 and via env (either works).
# The bundle ID must match the deploy's build_id, otherwise verify_live_build
# can never match -> false "DEPLOY FAILED".
BUILD_TS="${1:-${BUILD_ID:-$(date +%Y%m%d%H%M%S)}}"
sed -i "s/__BUILD__/${BUILD_TS}/g" ../worker.js
echo "Built ../worker.js (build ${BUILD_TS})"
