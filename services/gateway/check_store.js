// Check the gateway's tenant-registry storage (TODO §1) on a scratch instance, never the live one.
// Starts server.js with DATA_DIR in /tmp on port 8099, then: a fresh boot seeds pk_demo; a
// registration is saved atomically; a failed save returns 500 and keeps nothing; a corrupt
// tenants.json stops the boot with a clear message. Run inside the gateway container:
//   docker exec -w /app continuum-gateway-1 node check_store.js
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const DATA = "/tmp/gwt-" + process.pid;
const PORT = 8099;
const URL = `http://127.0.0.1:${PORT}`;
const TFILE = path.join(DATA, "tenants.json");
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function start() {
  const env = { ...process.env, DATA_DIR: DATA, PORT: String(PORT), GATEWAY_ADMIN_KEY: "" };
  const child = spawn("node", ["/app/server.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
  child.out = "";
  child.stdout.on("data", (d) => (child.out += d));
  child.stderr.on("data", (d) => (child.out += d));
  child.exited = new Promise((r) => child.on("exit", (code) => r(code)));
  return child;
}
async function up() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(URL + "/.well-known/jwks.json")).ok) return true; } catch (e) { /* not yet */ }
    await sleep(200);
  }
  return false;
}
const register = (name) => fetch(URL + "/v1/tenants", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name, origins: ["https://example.test"] }),
});

(async () => {
  fs.mkdirSync(DATA, { recursive: true });
  let gw = start();
  try {
    check("fresh boot comes up", await up());
    const seeded = JSON.parse(fs.readFileSync(TFILE, "utf8"));
    check("fresh boot seeds pk_demo into a valid tenants.json", !!seeded.tenants.pk_demo);
    check("the missing admin key is warned about", /GATEWAY_ADMIN_KEY is not set/.test(gw.out));

    const r1 = await register("store-check");
    const b1 = await r1.json();
    const saved = JSON.parse(fs.readFileSync(TFILE, "utf8"));
    check("a registration is saved", r1.status === 200 && !!saved.tenants[b1.siteKey], `status ${r1.status}`);
    check("no temporary file is left behind", !fs.existsSync(TFILE + ".tmp"));

    fs.mkdirSync(TFILE + ".tmp");                       // the next write cannot create its temp file
    const r2 = await register("unsaved");
    const b2 = await r2.json();
    const list = await (await fetch(URL + "/v1/tenants")).json();
    check("a failed save returns 500 and no credentials", r2.status === 500 && !b2.secret, `${r2.status} ${JSON.stringify(b2)}`);
    check("the unsaved tenant is not kept in memory", !list.tenants.some((t) => t.name === "unsaved"));
    check("the registry on disk is intact", !!JSON.parse(fs.readFileSync(TFILE, "utf8")).tenants[b1.siteKey]);
    fs.rmdirSync(TFILE + ".tmp");
  } finally {
    gw.kill("SIGTERM");
    await gw.exited;
  }

  fs.writeFileSync(TFILE, '{"tenants": {"pk_demo": ');   // truncated, as after a crash mid-write
  gw = start();
  const code = await Promise.race([gw.exited, sleep(8000).then(() => "running")]);
  if (code === "running") { gw.kill("SIGTERM"); await gw.exited; }
  check("a corrupt tenants.json stops the boot", code !== "running" && code !== 0, `exit ${code}`);
  check("with a message naming the file", /tenants\.json is not valid JSON/.test(gw.out));
  check("and the file is left as it was for recovery", fs.readFileSync(TFILE, "utf8") === '{"tenants": {"pk_demo": ');

  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(failures ? `${failures} CHECK(S) FAILED` : "ALL GATEWAY STORE CHECKS PASSED");
  process.exit(failures ? 1 : 0);
})();
