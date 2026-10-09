// The data layer on SQLite (cases in db.cases.js). A throwaway database: never the real ca.db.
const os = require("os");
const path = require("path");
const fs = require("fs");
process.env.STORAGE = "sqlite";
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ca-db-")), "test.db");

const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../db");
require("./db.cases")({ test, assert, db, lock: require("../lib/lock"), decisionState: require("../lib/decisionState") });
test.after(() => db.close());
