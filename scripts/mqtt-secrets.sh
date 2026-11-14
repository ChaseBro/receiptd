#!/usr/bin/env bash
# Set up the CloudPRNT MQTT secrets for receiptd-cprnt and receiptd-booth
# without the values ever being printed or written to disk.
#
#   1. Generates a random password for the EMQX user `printer-prod-3838`
#      and copies it to the clipboard — paste it into EMQX's
#      Access Control → Authentication → Add dialog and Confirm.
#   2. Asks for the EMQX Deployment API Key (App ID + App Secret).
#   3. Stores MQTT_APP_KEY, MQTT_APP_SECRET, MQTT_PRINTER_PASSWORD as
#      Worker secrets on receiptd-cprnt (worker/) and receiptd-booth
#      (photobooth/, prod + staging).
set -euo pipefail
cd "$(dirname "$0")/.."

PRINTER_PW="$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)"
printf %s "$PRINTER_PW" | pbcopy
echo "✓ Printer password copied to the clipboard."
echo "  In EMQX: paste it into the Password field for printer-prod-3838, click Confirm."
read -r -p "  Press Enter once it's saved in EMQX… " _

echo
echo "Now in EMQX: Deployment Overview → Deployment API Key → New API Key."
read -r -p "  App ID: " APP_ID
read -r -s -p "  App Secret (hidden): " APP_SECRET; echo
[ -n "$APP_ID" ] && [ -n "$APP_SECRET" ] || { echo "App ID/Secret required"; exit 1; }

put() { # dir name value [env]
  local dir=$1 name=$2 value=$3 env=${4:-}
  (cd "$dir" && printf %s "$value" | wrangler secret put "$name" ${env:+--env "$env"} >/dev/null) \
    && echo "  ✓ $name → $dir${env:+ ($env)}"
}
echo
echo "Storing Worker secrets…"
for target in "worker:" "photobooth:" "photobooth:staging"; do
  dir=${target%%:*}; env=${target#*:}
  put "$dir" MQTT_APP_KEY "$APP_ID" "$env"
  put "$dir" MQTT_APP_SECRET "$APP_SECRET" "$env"
  put "$dir" MQTT_PRINTER_PASSWORD "$PRINTER_PW" "$env"
done
printf '' | pbcopy
unset PRINTER_PW APP_ID APP_SECRET
echo
echo "Done (clipboard cleared). Tell Claude: \"secrets are in\" — MQTT is still switched off until then."
