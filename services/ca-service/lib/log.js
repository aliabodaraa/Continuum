// LOG_FORMAT=json turns this process's console output into one JSON object per line, which a log
// collector can index (Kubernetes overlays and the bundle set it); unset, the output stays readable text
// for local work. The text goes into "msg" exactly as written, so nothing has to change where logs are
// written. Log lines never carry typed text, key timings or tokens; this does not change that.
const util = require("util");

module.exports = function useJsonLogs(service) {
  if (String(process.env.LOG_FORMAT || "").toLowerCase() !== "json") return;
  const write = (stream, level) => (...args) => {
    stream.write(JSON.stringify({ time: new Date().toISOString(), level, service, msg: util.format(...args) }) + "\n");
  };
  console.log = console.info = write(process.stdout, "info");
  console.debug = write(process.stdout, "debug");
  console.warn = write(process.stderr, "warn");
  console.error = write(process.stderr, "error");
};
