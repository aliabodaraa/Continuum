// Populate text_hash / char_count for rows written before the columns existed.
// Idempotent: only touches rows where text_hash IS NULL.
const crypto = require("crypto");
const db = require("better-sqlite3")("/app/ca.db");
const SALT = process.env.TEXT_HASH_SALT || "continuum-text-hash-salt";
const h = (t) => crypto.createHmac("sha256", SALT).update(String(t || "")).digest("hex");

const rows = db.prepare("SELECT id, text_content FROM keystroke_texts WHERE text_hash IS NULL").all();
const upd = db.prepare("UPDATE keystroke_texts SET text_hash = ?, char_count = ? WHERE id = ?");
const tx = db.transaction((rs) => { for (const r of rs) upd.run(h(r.text_content), String(r.text_content || "").length, r.id); });
tx(rows);
const left = db.prepare("SELECT COUNT(*) n FROM keystroke_texts WHERE text_hash IS NULL").get().n;
const tot = db.prepare("SELECT COUNT(*) n FROM keystroke_texts").get().n;
console.log(`backfilled ${rows.length} rows; ${tot - left}/${tot} now have a hash`);
