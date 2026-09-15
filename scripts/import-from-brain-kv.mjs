// One-time: move the OpenRouter keys out of brain's Cloudflare KV and into the
// gateway, so one place holds them instead of two.
//
// The keys are piped from wrangler straight into the gateway's API. They are
// never printed, never written to a file, and never land in shell history.
//
//   GATEWAY_URL=https://llm-gateway.example.workers.dev \
//   ADMIN_TOKEN=... KV_NAMESPACE_ID=... BRAIN_DIR=~/Desktop/SELF/brain \
//   node scripts/import-from-brain-kv.mjs
import { execFileSync } from "node:child_process";

const { GATEWAY_URL, ADMIN_TOKEN, KV_NAMESPACE_ID } = process.env;
const BRAIN_DIR = process.env.BRAIN_DIR ?? `${process.env.HOME}/Desktop/SELF/brain`;

for (const [name, value] of Object.entries({ GATEWAY_URL, ADMIN_TOKEN, KV_NAMESPACE_ID })) {
  if (!value) {
    console.error(`set ${name}`);
    process.exit(1);
  }
}

console.log("Reading keys from brain's KV…");
const raw = execFileSync(
  "npx",
  ["wrangler", "kv", "key", "get", "openrouter:keys", "--namespace-id", KV_NAMESPACE_ID, "--remote"],
  { cwd: BRAIN_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
);

const stored = JSON.parse(raw);
const keys = stored.map((entry) => entry.key).filter(Boolean);
console.log(`Found ${keys.length} key(s). Sending to ${GATEWAY_URL} …`);

const res = await fetch(`${GATEWAY_URL}/v1/keys`, {
  method: "POST",
  headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ keys: keys.join("\n"), label: "migrated from brain KV" }),
});
const body = await res.json();

for (const k of body.added ?? []) console.log(`  added   ${k.masked}`);
for (const s of body.skipped ?? []) console.log(`  skipped ${s}`);

if (!res.ok && !(body.added ?? []).length) {
  console.error("\nNothing was stored. The old copy in KV is untouched.");
  process.exit(1);
}

console.log(`\nConfirm the count at ${GATEWAY_URL}, then remove the old copy:`);
console.log(`  cd ${BRAIN_DIR} && npx wrangler kv key delete "openrouter:keys" --namespace-id ${KV_NAMESPACE_ID} --remote`);
