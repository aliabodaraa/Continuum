// Fires the "Server errors" alert on purpose, end to end, on the running stack (2026-11-12): a throwaway participant of
// the study-e2e tenant gets a typing profile whose model file does not exist, so two typing checks get the real
// "no verdict" 503 (ca-service refuses to answer). Grafana's rule (base/observability/alerting) then fires within about
// two minutes and scripts/alert-notifier.ps1 shows the Windows notification; this script waits for the rule to fire and
// for the notifier's log line, then removes the participant. Nothing else is touched.
//   node extension/scripts/e2e_alert_fire.mjs      (CONTINUUM_GATEWAY as the other suites; the operator area as in them)
import os from "node:os"; import path from "node:path"; import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { inService, psql, operatorUrl, stackSecret, K8S } from "./lib/stack.mjs";
const GW = process.env.CONTINUUM_GATEWAY || "http://localhost:8080";
const ADMIN_KEY = stackSecret("GATEWAY_ADMIN_KEY", "");
const OP = await operatorUrl(GW);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (n, c, d) => { console.log((c ? "  PASS  " : "  FAIL  ") + n + (d ? " — " + d : "")); if (!c) bad++; };
let token = null, userId = null;
async function gw(p, body, method = "POST") {
  const r = await fetch((p.startsWith("/v1/tenants") ? OP : GW) + p, { method, headers: { "Content-Type": "application/json", Origin: GW, ...(token ? { Authorization: "Bearer " + token } : {}),
    ...(p.startsWith("/v1/tenants") ? { "X-Admin-Key": ADMIN_KEY } : {}) }, body: method === "GET" ? undefined : JSON.stringify(body || {}) });
  return { status: r.status, d: await r.json().catch(() => ({})) };
}
function typing(n, seed) {
  let t = 0, s = seed; const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  const text = "the quick brown fox jumps over the lazy dog while a small bird sings near the old river bank today ".repeat(4).slice(0, n);
  const ev = [];
  for (const ch of text) {
    const kc = ch === " " ? 32 : ch.toUpperCase().charCodeAt(0);
    const dwell = 70 + rnd() * 60;
    ev.push({ keyCode: kc, eventType: "keydown", timestampRelative: Math.round(t), fieldName: "e2e", fieldType: "textarea" });
    ev.push({ keyCode: kc, eventType: "keyup", timestampRelative: Math.round(t + dwell), fieldName: "e2e", fieldType: "textarea" });
    t += dwell + 60 + rnd() * 140;
  }
  return { text, ev };
}
// Grafana's view of its rules, through the pod (Grafana is reached only from inside the cluster or a port-forward).
const ruleStates = () => JSON.parse(inService("otel-lgtm", ["sh", "-c", 'curl -s -u "admin:$GF_SECURITY_ADMIN_PASSWORD" localhost:3000/api/prometheus/grafana/api/v1/rules']))
  .data.groups.flatMap((g) => g.rules).map((r) => [r.name, r.state]);
const notifierLog = () => { try { return fs.readFileSync(path.join(process.env.LOCALAPPDATA || "", "Continuum", "alerts.log"), "utf8"); } catch { return ""; } };

try {
  const ten = ((await gw("/v1/tenants", null, "GET")).d.tenants || []).find((t) => t.name === "study-e2e");
  if (!ten) throw new Error("study-e2e tenant missing: run e2e_headless_study.mjs once first");
  const P = "ALERT" + Date.now().toString(36).toUpperCase();
  const ses = await gw("/v1/sdk/session", { siteKey: ten.siteKey, externalId: "study:" + P });
  token = ses.d.token; userId = ses.d.userId;
  if (!userId) throw new Error("no session: " + JSON.stringify(ses.d));
  // A "trained" profile whose model is missing: the check must then refuse to answer (503, no verdict).
  const model = JSON.stringify({ version: 3, type: "per-user-cnn-lstm", modelPath: `/app/artifacts/users/user-${userId}-missing/final_model`, inputShape: [50, 6], threshold: 0.5, sampleCount: 5 });
  psql("ca", `INSERT INTO user_typing_profiles (user_id, model_json, sample_count, trained_at) VALUES (${userId}, '${model}', 5, now()) ON CONFLICT (user_id) DO UPDATE SET model_json = EXCLUDED.model_json`);
  const before = notifierLog().split("\n").length;
  const codes = [];
  for (let i = 0; i < 3; i++) { const { ev } = typing(380, 11 + i); const r = await gw("/v1/sdk/keystroke/check", { textLength: 380, keystrokeEvents: ev, hasPasskey: false }); codes.push(r.status + " " + (r.d.error || "")); await sleep(1500); }
  ok("typing checks for a profile whose model is missing get the real 'no verdict' 503", codes.every((c) => c.startsWith("503")), codes.join(", "));

  let fired = false, t0 = Date.now();
  while (Date.now() - t0 < 6 * 60 * 1000 && !fired) { await sleep(10000); fired = ruleStates().some(([n, s]) => n === "Server errors" && s === "firing"); }
  ok("Grafana's 'Server errors' rule fires", fired, `${Math.round((Date.now() - t0) / 1000)} s; states ${JSON.stringify(ruleStates())}`);
  let shown = false; t0 = Date.now();
  while (Date.now() - t0 < 3 * 60 * 1000 && !shown) { await sleep(5000); shown = /firing: Server errors/.test(notifierLog().split("\n").slice(before - 1).join("\n")); }
  ok("the notifier on this PC received it and showed the notification", shown, `${Math.round((Date.now() - t0) / 1000)} s after the rule fired`);
} catch (e) {
  ok("run completed", false, e.message);
} finally {
  if (userId) {
    try { psql("ca", `DELETE FROM user_typing_profiles WHERE user_id = ${userId}`); } catch (e) { console.log("  cleanup: " + e.message); }
    try { inService("ca-service", ["node", "-e", `const db=require('/app/db');db.run('DELETE FROM session_locks WHERE user_id=?', ${userId}).finally(()=>db.close())`]); } catch {}
    console.log("  cleanup done (the throwaway participant's profile removed; the alert resolves by itself within 10 minutes)");
  }
}
console.log(bad ? `\n${bad} FAILED` : "\nall passed");
process.exit(bad ? 1 : 0);
