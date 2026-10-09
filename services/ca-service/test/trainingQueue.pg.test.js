// The durable training queue on PostgreSQL (cases in queue.cases.js), in a throwaway database on
// TEST_DATABASE_URL (scripts/ci-local.sh starts one). Skipped without it.
const { BASE, freshDatabase } = require("./pg");
process.env.STORAGE = "postgres";
process.env.TRAINING_MAX_ATTEMPTS = "2";

const test = require("node:test");
const assert = require("node:assert/strict");
if (!BASE) {
  test("PostgreSQL training queue", { skip: "TEST_DATABASE_URL is not set" }, () => {});
} else {
  const db = require("../db");
  test.before(async () => { process.env.DATABASE_URL = await freshDatabase("ca_queue"); });
  require("./queue.cases")({ test, assert, db, q: require("../lib/trainingQueue") });
  test.after(() => db.close());
}
