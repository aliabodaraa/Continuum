// A deliberately naive round-robin balancer for the side-by-side stack (docker-compose.two-gateways.yml):
// each request goes to the NEXT gateway copy (Docker's DNS lists every replica of "gateway"), so an
// end-to-end run proves that no step of any flow depends on reaching the copy that served the step
// before. Development and testing only: Host and every header pass through unchanged (no X-Forwarded-*),
// so the gateway sees the request as the browser sent it.
const http = require("http");
const dns = require("dns").promises;

const [HOST, UP_PORT] = (process.env.UPSTREAM || "gateway:8080").split(":");
const served = new Map();
let n = 0;

http.createServer(async (req, res) => {
  let list;
  try { list = (await dns.lookup(HOST, { all: true, family: 4 })).map((x) => x.address).sort(); }
  catch (e) { res.writeHead(502).end("no upstream"); return; }
  const ip = list[n++ % list.length];
  served.set(ip, (served.get(ip) || 0) + 1);
  const up = http.request({ host: ip, port: Number(UP_PORT), method: req.method, path: req.url, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode, { ...r.headers, "x-served-by": ip });
    r.pipe(res);
  });
  up.on("error", (e) => { if (!res.headersSent) res.writeHead(502); res.end(e.message); });
  req.pipe(up);
}).listen(Number(process.env.PORT || 8080), () => console.log(`round-robin over every "${HOST}" replica`));

setInterval(() => console.log(`requests per "${HOST}" copy:`, JSON.stringify(Object.fromEntries(served))), 10000).unref();
process.on("SIGTERM", () => process.exit(0));
