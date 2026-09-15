#!/usr/bin/env bash
# One-time: move the OpenRouter keys out of brain's Cloudflare KV and into the
# gateway, so there is one place holding them instead of two.
#
# The keys are piped straight from wrangler into the gateway's API. They are
# never printed, never written to a file, and never land in shell history.
#
#   GATEWAY_URL=https://your-gateway ADMIN_TOKEN=... \
#   KV_NAMESPACE_ID=... ./scripts/import-from-brain-kv.sh
#
# Afterwards, verify the count at $GATEWAY_URL, then delete the KV entry:
#   npx wrangler kv key delete "openrouter:keys" --namespace-id "$KV_NAMESPACE_ID" --remote

set -euo pipefail

: "${GATEWAY_URL:?set GATEWAY_URL}"
: "${ADMIN_TOKEN:?set ADMIN_TOKEN}"
: "${KV_NAMESPACE_ID:?set KV_NAMESPACE_ID}"
BRAIN_DIR="${BRAIN_DIR:-$HOME/Desktop/SELF/brain}"

echo "Reading keys from brain's KV..."
payload=$(
  cd "$BRAIN_DIR" && npx wrangler kv key get "openrouter:keys" \
    --namespace-id "$KV_NAMESPACE_ID" --remote 2>/dev/null |
  python3 -c '
import json, sys
stored = json.load(sys.stdin)
# Only the values are needed; the masked forms and fingerprints are brains own
# bookkeeping and the gateway derives its own.
keys = [entry["key"] for entry in stored if entry.get("key")]
print(json.dumps({"keys": "\n".join(keys), "label": "migrated from brain KV"}))
'
)

count=$(printf '%s' "$payload" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["keys"].split()))')
echo "Found $count key(s). Sending to $GATEWAY_URL ..."

printf '%s' "$payload" | curl -sS -X POST "$GATEWAY_URL/v1/keys" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @- |
python3 -c '
import json, sys
r = json.load(sys.stdin)
added, skipped = r.get("added", []), r.get("skipped", [])
print(f"  added {len(added)}: " + ", ".join(a["masked"] for a in added))
for s in skipped:
    print(f"  skipped: {s}")
'

echo
echo "Now confirm at $GATEWAY_URL, then remove them from brain:"
echo "  cd $BRAIN_DIR && npx wrangler kv key delete \"openrouter:keys\" --namespace-id $KV_NAMESPACE_ID --remote"
