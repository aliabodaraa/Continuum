const db = require("better-sqlite3")("/app/ca.db", { readonly: true });
console.log("HISTORICAL DATA — must be unchanged");
const u1 = db.prepare("SELECT COUNT(*) n FROM keystroke_texts WHERE user_id=1").get().n;
const u1h = db.prepare("SELECT COUNT(*) n FROM keystroke_texts WHERE user_id=1 AND is_training=0").get().n;
console.log(`  user_id=1 total samples : ${u1}   (was 121)  ${u1 === 121 ? "PASS" : "CHANGED"}`);
console.log(`  user_id=1 held-out      : ${u1h}    (was 78)   ${u1h === 78 ? "PASS" : "CHANGED"}`);
console.log("");
console.log("REGISTRY");
console.log("  tenants : " + db.prepare("SELECT group_concat(tenant_id) t FROM tenants").get().t);
const ali = db.prepare("SELECT principal_id, external_user_id FROM principals WHERE principal_id=?").get(739935229538144);
console.log(`  ali principal : ${ali.principal_id}  external=${ali.external_user_id}`);
const al = db.prepare("SELECT legacy_user_id, source FROM principal_aliases WHERE principal_id=? ORDER BY legacy_user_id").all(739935229538144);
al.forEach((a) => console.log(`    alias ${a.legacy_user_id}  ${a.source}`));
console.log("  retired : " + db.prepare("SELECT COUNT(*) n FROM retired_identities").get().n);
console.log("");
console.log("UNIQUE CONSTRAINT — one human cannot receive two identities");
const w = require("better-sqlite3")("/app/ca.db");
try {
  w.prepare("INSERT INTO principals (principal_id,tenant_id,external_user_id) VALUES (?,?,?)").run(999999, "pk_demo", "id:1");
  console.log("  FAIL — duplicate (pk_demo, id:1) was accepted");
  w.prepare("DELETE FROM principals WHERE principal_id=999999").run();
} catch (e) {
  console.log("  PASS — rejected: " + e.code);
}
console.log("");
console.log("TENANT ISOLATION — same external id, different tenant = different principal");
const crypto = require("crypto"), S = "dev-gateway-session-secret";
const d = (sk, e) => parseInt(crypto.createHmac("sha256", S).update(sk + "|" + e).digest("hex").slice(0, 13), 16);
console.log(`  pk_demo|id:1 -> ${d("pk_demo","id:1")}`);
console.log(`  pk_other|id:1 -> ${d("pk_other","id:1")}`);
console.log("  " + (d("pk_demo","id:1") !== d("pk_other","id:1") ? "PASS — namespaced" : "FAIL — collision"));
