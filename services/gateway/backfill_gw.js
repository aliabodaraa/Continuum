// Bring the gateway's registry in line with the canonical principals table.
// Without this the gateway knows only the 8 identities it happened to resolve, and would
// allocate the other 37 by hash on first contact — which is exactly the behaviour the
// read-before-compute change was made to stop.
const fs = require("fs");
const FILE = "/app/identity.json";
const store = JSON.parse(fs.readFileSync(FILE, "utf8"));
const principals = JSON.parse(fs.readFileSync("/app/principals_seed.json", "utf8"));
let added = 0, already = 0, conflict = [];
for (const p of principals) {
  const key = `${p.tenant_id}|${p.external_user_id}`;
  const cur = store.users[key];
  if (!cur) {
    store.users[key] = { userId: p.principal_id, externalId: p.external_user_id, createdAt: new Date().toISOString(), seededFrom: "principals" };
    added++;
  } else if (cur.userId !== p.principal_id) {
    conflict.push({ key, gateway: cur.userId, registry: p.principal_id });
  } else already++;
}
if (conflict.length) {
  console.log("CONFLICTS — gateway and registry disagree, NOT written:");
  conflict.forEach((c) => console.log(`  ${c.key}  gateway=${c.gateway}  registry=${c.registry}`));
  process.exit(1);
}
fs.writeFileSync(FILE, JSON.stringify(store, null, 2));
console.log(`gateway registry: ${added} added, ${already} already matched, 0 conflicts`);
console.log(`total identities now known to the gateway: ${Object.keys(store.users).length}`);
