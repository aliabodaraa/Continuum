#!/usr/bin/env node
// Print, as JSON, which Continuum user each of this app's users is: { "<users.id>": <continuumUserId> }.
// Asked through the public API (/v1/resolve, with this organisation's identity tokens), as any tenant
// would; the gateway allocates an id the first time it sees a user. Read-only for this app's database.
//
// Used once, to move passkeys that were stored under this app's own user numbers (when its backend still
// called the passkey service directly) to the Continuum users they belong to:
//   node scripts/continuum-ids.js > /tmp/ids.json     (in the demo container)
//   then services/passkey-service/scripts/rekey-users.js with that file
const db = require("../db/init");
const { identityToken, GATEWAY_URL, SITE_KEY } = require("../services/continuumApi");

async function main() {
  const users = db.prepare("SELECT id FROM users ORDER BY id").all();
  const out = {};
  for (const { id } of users) {
    const r = await fetch(`${GATEWAY_URL}/v1/resolve`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ siteKey: SITE_KEY, identityToken: identityToken(id) }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.continuumUserId == null) throw new Error(`user ${id}: the gateway answered ${r.status} ${d.error || ""}`);
    out[id] = d.continuumUserId;
  }
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  console.error(`${users.length} users resolved`);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
