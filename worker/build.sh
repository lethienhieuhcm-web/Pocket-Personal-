#!/bin/bash
# Bundle worker/src/*.js into ../worker.js (Cloudflare Worker entry point)
set -e
cd "$(dirname "$0")"
npx esbuild src/index.js --bundle --format=esm --outfile=../worker.js
# Replace __BUILD__ with timestamp for X-Build-Id header (cache-buster)
BUILD_TS=$(date +%Y%m%d%H%M%S)
sed -i "s/__BUILD__/${BUILD_TS}/g" ../worker.js
echo "Built ../worker.js (build ${BUILD_TS})"
