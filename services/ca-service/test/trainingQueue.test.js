// The durable training queue on SQLite (cases in queue.cases.js). A throwaway database: never the real ca.db.
const os = require("os");
const path = require("path");
const fs = require("fs");
process.env.STORAGE = "sqlite";
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ca-queue-")), "test.db");
process.env.TRAINING_MAX_ATTEMPTS = "2";

const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../db");
require("./queue.cases")({ test, assert, db, q: require("../lib/trainingQueue") });
test.after(() => db.close());
