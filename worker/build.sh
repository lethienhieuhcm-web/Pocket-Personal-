#!/bin/bash
# Bundle worker/src/*.js into ../worker.js (Cloudflare Worker entry point)
# 8b (2026-10-11): Accept BUILD_ID as $1 for single release ID across
# manifest + worker. If not provided, generate timestamp (local dev fallback).
set -e
cd "$(dirname "$0")"
npx esbuild src/index.js --bundle --format=esm --outfile=../worker.js
# Replace __BUILD__ with the provided build ID (or timestamp if not given)
BUILD_TS="${1:-$(date +%Y%m%d%H%M%S)}"
sed -i "s/__BUILD__/${BUILD_TS}/g" ../worker.js
echo "Built ../worker.js (build ${BUILD_TS})"
