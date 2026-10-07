#!/usr/bin/env node
// Move passkeys from one user id to another, from a JSON map { "<old id>": <new id>, ... }, in one
// transaction, then prove nothing was lost: the same credentials, each now under its new id, none left
// under an old one. Without --apply it only reports what it would do.
//
//   node scripts/rekey-users.js ids.json            # dry run
//   node scripts/rekey-users.js ids.json --apply
//
// Why it exists: the demo app's backend once called this service directly with its OWN user numbers;
// through the gateway the same people are Continuum users. A credential keeps its key and counter, so it
// signs in as before (same relying party), only under the right user. Pending challenges of the old ids
// are dropped (they last five minutes anyway).
const fs = require("fs");
const db = require("../db");

const file = process.argv[2];
const apply = process.argv.includes("--apply");
if (!file) { console.error("usage: node scripts/rekey-users.js <map.json> [--apply]"); process.exit(2); }

const map = Object.entries(JSON.parse(fs.readFileSync(file, "utf8"))).map(([from, to]) => [Number(from), Number(to)]);
const bad = map.filter(([f, t]) => !Number.isSafeInteger(f) || !Number.isSafeInteger(t) || f === t);
if (bad.length) { console.error(`refusing: bad pairs ${JSON.stringify(bad.slice(0, 5))}`); process.exit(1); }
const sources = new Set(map.map(([f]) => f));
const chained = map.filter(([, t]) => sources.has(t));
if (chained.length) { console.error(`refusing: a target is also a source ${JSON.stringify(chained.slice(0, 5))}`); process.exit(1); }

const count = (uid) => db.prepare("SELECT count(*) AS n FROM passkey_credentials WHERE user_id = ?").get(uid).n;
const allCreds = () => db.prepare("SELECT credential_id, public_key, counter FROM passkey_credentials ORDER BY credential_id").all();

const plan = map.map(([from, to]) => ({ from, to, moving: count(from), alreadyThere: count(to) })).filter((p) => p.moving > 0);
const before = allCreds();
console.log(`${plan.length} user(s) with passkeys to move, ${plan.reduce((a, p) => a + p.moving, 0)} credential(s); ${before.length} credentials in total`);
for (const p of plan) console.log(`  user ${p.from} -> ${p.to}: ${p.moving} credential(s)${p.alreadyThere ? ` (joins ${p.alreadyThere} already there)` : ""}`);
if (!apply) { console.log("dry run: nothing changed (add --apply)"); process.exit(0); }

// The move and its proof in one transaction: if the proof fails, nothing is changed.
try {
  db.transaction(() => {
    const mv = db.prepare("UPDATE passkey_credentials SET user_id = ? WHERE user_id = ?");
    const drop = db.prepare("DELETE FROM webauthn_challenges WHERE user_id = ?");
    for (const p of plan) { mv.run(p.to, p.from); drop.run(p.from); }
    const problems = [];
    if (JSON.stringify(allCreds()) !== JSON.stringify(before)) problems.push("the set of credentials (id, key, counter) changed");
    for (const p of plan) {
      if (count(p.from) !== 0) problems.push(`user ${p.from} still has credentials`);
      if (count(p.to) !== p.moving + p.alreadyThere) problems.push(`user ${p.to} has ${count(p.to)}, expected ${p.moving + p.alreadyThere}`);
    }
    if (problems.length) throw new Error(problems.join("; "));
  })();
} catch (e) {
  console.error(`NOT VERIFIED, nothing changed: ${e.message}`);
  process.exit(1);
}
console.log(`moved and verified: ${before.length} credentials, unchanged; every moved one under its new user`);
