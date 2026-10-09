// The data layer on PostgreSQL (cases in db.cases.js), in a throwaway database on TEST_DATABASE_URL
// (scripts/ci-local.sh starts one). Skipped without it.
const { BASE, freshDatabase } = require("./pg");
process.env.STORAGE = "postgres";

const test = require("node:test");
const assert = require("node:assert/strict");
if (!BASE) {
  test("PostgreSQL data layer", { skip: "TEST_DATABASE_URL is not set" }, () => {});
} else {
  const db = require("../db");
  test.before(async () => { process.env.DATABASE_URL = await freshDatabase("ca_db"); });
  require("./db.cases")({ test, assert, db, lock: require("../lib/lock"), decisionState: require("../lib/decisionState") });
  test.after(() => db.close());
}
