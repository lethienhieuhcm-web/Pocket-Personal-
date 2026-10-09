#!/bin/bash
# Health check for Pocket Personal - runs every 15 min via cron
# Alerts via Telegram on failure
set -u

BASE="https://lethanhdong.one"
FAILURES=""

check() {
  local name="$1" url="$2" expect="$3"
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 "$url" 2>/dev/null || echo "000")
  if [ "$code" != "$expect" ]; then
    FAILURES="${FAILURES}❌ ${name}: got ${code}, want ${expect}\n"
  fi
}

check "hub"          "$BASE/hub"              "200"
check "upgrade"      "$BASE/upgrade"          "200"
check "login page"   "$BASE/login"            "200"
check "english app"  "$BASE/english/"         "200"
check "stocks app"   "$BASE/stocks/"          "200"
check "api no-auth"  "$BASE/api/auth/me"      "401"

if [ -n "$FAILURES" ]; then
  # Send Telegram alert
  ENV_FILE="/home/hatch/workspace/shopee-deal-hunter/.env"
  if [ -f "$ENV_FILE" ]; then
    # shellcheck disable=SC1090
    set -a; . "$ENV_FILE"; set +a
    MSG="🚨 <b>Pocket Personal health check FAILED</b>%0A%0A$(echo -e "$FAILURES" | sed 's/ /%20/g' | tr '\n' '%')"
    curl -s -o /dev/null --max-time 10 \
      "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      -d "chat_id=${TELEGRAM_CHAT_ID}&text=${MSG}&parse_mode=HTML" 2>/dev/null
  fi
  echo "FAILURES detected"
  exit 1
fi
echo "OK"
