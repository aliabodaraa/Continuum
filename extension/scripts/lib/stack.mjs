// Where the end-to-end suites run a command inside the stack under test.
//   Docker Compose (default): docker exec into <CONTINUUM_CONTAINER_PREFIX>-<service>-1, as before
//                             (continuum = the running stack, continuum-next = the side-by-side copy).
//   Kubernetes (CONTINUUM_K8S_CONTEXT, e.g. docker-desktop): kubectl exec into the service's Deployment in its
//                             namespace (deploy/k8s), and PostgreSQL through the operator's primary pod.
import { execFileSync } from "node:child_process";

export const K8S = process.env.CONTINUUM_K8S_CONTEXT || "";
export const PREFIX = process.env.CONTINUUM_CONTAINER_PREFIX || "continuum";
const NAMESPACE = { web: "continuum-demo" };          // every other service is in namespace continuum
const env = { ...process.env, MSYS_NO_PATHCONV: "1" };  // Git Bash: no path rewriting of container paths

const kubectl = (args, opts) => execFileSync("kubectl", ["--context", K8S, ...args], { encoding: "utf8", env, ...opts });

/** Run `cmd` (an argv array) in a service; its working directory is the image's own (/app). */
export function inService(service, cmd, opts = {}) {
  if (K8S) return kubectl(["-n", NAMESPACE[service] || "continuum", "exec", `deploy/${service}`, "--", ...cmd], opts);
  return execFileSync("docker", ["exec", "-w", "/app", `${PREFIX}-${service}-1`, ...cmd], { encoding: "utf8", env, ...opts });
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
