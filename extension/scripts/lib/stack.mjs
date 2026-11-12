// Where the end-to-end suites run a command inside the stack under test, and what they need to know about it.
//   Kubernetes (the default since the switch-over, 2026-10: the live system is this PC's cluster, context
//               docker-desktop; CONTINUUM_K8S_CONTEXT names another): kubectl exec into the service's
//               Deployment in its namespace (deploy/k8s), PostgreSQL through the operator's primary pod, the
//               operator area through a port-forward made here, and the tenant secret from the overlay's
//               secrets file.
//   Docker Compose (CONTINUUM_CONTAINER_PREFIX=continuum, or another project name): docker exec into
//               <prefix>-<service>-1, as before the switch-over.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PREFIX = process.env.CONTINUUM_CONTAINER_PREFIX || "";
export const K8S = process.env.CONTINUUM_K8S_CONTEXT || (PREFIX ? "" : "docker-desktop");
const COMPOSE_PREFIX = PREFIX || "continuum";
// Docker Desktop's built-in Kubernetes does not enforce NetworkPolicies (measured at step 7): the suites turn
// the reachability check into a labelled note there. Another cluster: set it as measured.
export const NETPOL_UNENFORCED = (process.env.CONTINUUM_NETPOL_UNENFORCED ?? "0") === "1";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const NAMESPACE = { web: "continuum-demo", acme: "continuum-demo", "otel-lgtm": "continuum-observability" };   // every other service is in namespace continuum
const env = { ...process.env, MSYS_NO_PATHCONV: "1" };  // Git Bash: no path rewriting of container paths

const kubectl = (args, opts) => execFileSync("kubectl", ["--context", K8S, ...args], { encoding: "utf8", env, ...opts });

/** Run `cmd` (an argv array) in a service; its working directory is the image's own (/app). */
export function inService(service, cmd, opts = {}) {
  if (K8S) return kubectl(["-n", NAMESPACE[service] || "continuum", "exec", `deploy/${service}`, "--", ...cmd], opts);
  return execFileSync("docker", ["exec", "-w", "/app", `${COMPOSE_PREFIX}-${service}-1`, ...cmd], { encoding: "utf8", env, ...opts });
}

/** One SQL statement in a service's own database (gateway, ca, passkey), the rows as tab-separated text.
 *  Compose: the PostgreSQL container `pgContainer` (CONTINUUM_*_PG), as the database's own login. */
export function psql(database, sql, pgContainer) {
  if (K8S) {
    const primary = kubectl(["-n", "continuum", "get", "pod", "-l", "cnpg.io/cluster=continuum-pg,cnpg.io/instanceRole=primary",
      "-o", "jsonpath={.items[0].metadata.name}"]).trim();
    return kubectl(["-n", "continuum", "exec", primary, "-c", "postgres", "--", "psql", "-d", database, "-tAc", sql]);
  }
  return execFileSync("docker", ["exec", pgContainer, "psql", "-U", database, "-d", database, "-tAc", sql], { encoding: "utf8", env });
}

/** How a service in the stack names the gateway and the internal services (Kubernetes: across namespaces). */
export const internalUrl = (service, port) => `http://${service}${K8S ? ".continuum" : ""}:${port}`;

/** A secret of the stack under test: the environment, else (Kubernetes) the overlay's git-ignored secrets
 *  file (deploy/k8s/overlays/local/secrets/continuum.env), else the development default. */
export function stackSecret(name, fallback) {
  if (process.env[name]) return process.env[name];
  if (K8S) {
    try {
      const m = fs.readFileSync(path.join(ROOT, "deploy/k8s/overlays/local/secrets/continuum.env"), "utf8").match(new RegExp(`^${name}=(.*?)\\s*$`, "m"));
      if (m) return m[1];
    } catch (e) { /* no secrets file: the default below */ }
  }
  return fallback;
}

/** Where the operator area answers (the operator page, /v1/tenants, /v1/admin/...). Compose: the gateway
 *  itself. Kubernetes: the edge never routes it (Envoy marks every request it forwards), so a private
 *  port-forward to the gateway, made here on a free port and ended with the process (or
 *  CONTINUUM_OPERATOR, e.g. scripts/k8s-local.sh operator's http://localhost:28081). */
export async function operatorUrl(gatewayUrl) {
  if (process.env.CONTINUUM_OPERATOR) return process.env.CONTINUUM_OPERATOR;
  if (!K8S) return gatewayUrl;
  const port = await freePort();
  const pf = spawn("kubectl", ["--context", K8S, "-n", "continuum", "port-forward", "deploy/gateway", `${port}:8080`, "--address", "127.0.0.1"],
    { env, stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  pf.stderr.on("data", (d) => { err += d; });
  const stop = () => { try { pf.kill(); } catch (e) { /* already gone */ } };
  process.on("exit", stop);
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (pf.exitCode !== null) throw new Error(`operator port-forward ended: ${err.trim()}`);
    try { if ((await fetch(url + "/health", { signal: AbortSignal.timeout(1500) })).ok) return url; } catch (e) { /* not yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  stop();
  throw new Error(`operator port-forward on ${url} never answered: ${err.trim()}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
