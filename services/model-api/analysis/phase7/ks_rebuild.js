// Rebuilds each KeyRecs participant's key events from the digraph timings and builds the windows with the RUNNING
// ca-service's own code (its lib/keystrokeSecurity.js, cut before the first require so it runs without the database
// and model clients), i.e. exactly the windows the live server would build if that person typed on the page.
//   node ks_rebuild.js <free-text.csv> <out prefix> [keystrokeSecurity.js]
//     -> <prefix>.f32 (N x 50 x 6 float32) + <prefix>.json (index, stats)
// Default module: the repo's services/ca-service/lib/keystrokeSecurity.js; for the running service's copy use
// kubectl -n continuum exec deploy/ca-service -- cat /app/lib/keystrokeSecurity.js > ks.js (MSYS_NO_PATHCONV=1 on Git Bash).
const fs = require("fs");
const path = require("path");
const [src, out, ksFile] = process.argv.slice(2);
const ksText = fs.readFileSync(ksFile || path.join(__dirname, "..", "..", "..", "ca-service", "lib", "keystrokeSecurity.js"), "utf8");
const cut = ksText.indexOf('const { postModelApi } = require("./modelClient");');
if (cut < 0) throw new Error("keystrokeSecurity.js layout changed: the modelClient require was not found");
const ksTmp = path.join(require("os").tmpdir(), `ks_live_windows_${process.pid}.js`);
fs.writeFileSync(ksTmp, ksText.slice(0, cut) + "\nmodule.exports = { featureWindowsWithKeys };\n");
const ks = require(ksTmp);
fs.unlinkSync(ksTmp);

// keyrecs_to_windows.keycode_of, ported (unmapped -> 0, counted)
const NAMED = { space: 32, backspace: 8, shift: 16, control: 17, ctrl: 17, alt: 18, enter: 13, return: 13, tab: 9,
  capslock: 20, escape: 27, esc: 27, arrowleft: 37, arrowup: 38, arrowright: 39, arrowdown: 40, delete: 46, home: 36,
  end: 35, pageup: 33, pagedown: 34, meta: 91 };
const PUNCT = { ";": 186, ":": 186, "=": 187, "+": 187, ",": 188, "<": 188, "-": 189, _: 189, ".": 190, ">": 190,
  "/": 191, "?": 191, "`": 192, "~": 192, "[": 219, "{": 219, "\\": 220, "|": 220, "]": 221, "}": 221, "'": 222,
  '"': 222, "!": 49, "@": 50, "#": 51, $: 52, "%": 53, "^": 54, "&": 55, "*": 56, "(": 57, ")": 48 };
let unmapped = 0, mapped = 0;
function keyCode(name) {
  const n = (name || "").trim();
  if (!n) { unmapped++; return 0; }
  const low = n.toLowerCase();
  let c = null;
  if (low in NAMED) c = NAMED[low];
  else if (n.length === 1) {
    if (/[a-z]/i.test(n)) c = n.toUpperCase().charCodeAt(0);
    else if (/[0-9]/.test(n)) c = n.charCodeAt(0);
    else if (n in PUNCT) c = PUNCT[n];
  }
  if (c == null) { unmapped++; return 0; } mapped++; return c;
}

const lines = fs.readFileSync(src, "utf8").split(/\r?\n/);
const head = lines[0].split(",").map((s) => s.trim());
const col = (name) => head.indexOf(name);
const iP = col("participant"), iS = col("session"), iK1 = col("key1"), iK2 = col("key2"), iDw = col("DU.key1.key1"),
  iDD = col("DD.key1.key2"), iUD = col("UD.key1.key2"), iUU = col("UU.key1.key2");
const groups = new Map();
for (let i = 1; i < lines.length; i++) {
  if (!lines[i]) continue;
  const f = lines[i].split(",");
  const k = f[iP] + "|" + f[iS];
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(f);
}

let chainBreaks = 0;
const index = [], chunks = [];
let total = 0;
for (const [k, rows] of groups) {
  const [p, s] = k.split("|");
  const events = [];
  let t = 0, prevKey2 = null, curDown = null;   // curDown: the open key (down time) of the chain
  for (let r = 0; r < rows.length; r++) {
    const f = rows[r];
    const k1 = f[iK1], k2 = f[iK2];
    const dwell1 = Number(f[iDw]), dd = Number(f[iDD]), ud = Number(f[iUD]), uu = Number(f[iUU]);
    if (![dwell1, dd, ud, uu].every(Number.isFinite)) { prevKey2 = null; continue; }
    if (prevKey2 === null || k1 !== prevKey2) {       // a new chain: key1 starts it, 5 s after the last event
      if (prevKey2 !== null) chainBreaks++;
      t = (events.length ? Math.max(...events.slice(-4).map((e) => e.timestampRelative)) / 1000 : 0) + 5;
      curDown = t;
    }
    // key1 (down at curDown) is released after dwell1; key2 goes down dd after key1
    events.push({ keyCode: keyCode(k1), eventType: "keydown", timestampRelative: curDown * 1000, fieldName: "f" });
    events.push({ keyCode: keyCode(k1), eventType: "keyup", timestampRelative: (curDown + dwell1) * 1000, fieldName: "f" });
    const next = curDown + dd;
    const nextRow = rows[r + 1];
    const chainEnds = !nextRow || nextRow[iK1] !== k2;
    if (chainEnds) {                                    // the last key of the chain: dwell2 = UU - UD
      events.push({ keyCode: keyCode(k2), eventType: "keydown", timestampRelative: next * 1000, fieldName: "f" });
      events.push({ keyCode: keyCode(k2), eventType: "keyup", timestampRelative: (next + (uu - ud)) * 1000, fieldName: "f" });
    }
    curDown = next;
    prevKey2 = k2;
  }
  // the live server receives timestamps relative to the page; keep them non-negative
  const t0 = Math.min(...events.map((e) => e.timestampRelative));
  for (const e of events) e.timestampRelative -= t0;
  const { windows } = ks.featureWindowsWithKeys(events);
  const buf = new Float32Array(windows.length * 50 * 6);
  let o = 0;
  for (const w of windows) for (const row of w) for (const v of row) buf[o++] = v;
  chunks.push(Buffer.from(buf.buffer));
  index.push({ participant: p, session: s, windows: windows.length, digraphRows: rows.length });
  total += windows.length;
}
fs.writeFileSync(out + ".f32", Buffer.concat(chunks));
fs.writeFileSync(out + ".json", JSON.stringify({ index, total, chainBreaks, keysMapped: mapped, keysUnmapped: unmapped }, null, 1));
console.log(`groups ${index.length}, windows ${total}, chain breaks ${chainBreaks}, unmapped key share ${(100 * unmapped / (mapped + unmapped)).toFixed(2)}%`);
