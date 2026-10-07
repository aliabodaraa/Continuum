/**
 * Fails if the browser action extractor (sdk/js/mouse-actions.js) disagrees
 * with the training-side one (services/model-api/preprocess_mouse_actions.py).
 *
 * The window pipeline drifted apart at exactly this seam: the browser filtered
 * events the training data kept, so the deployed model scored a feature
 * distribution it had never been trained on. That skew was invisible because
 * nothing compared the two implementations. This does.
 *
 * Usage:
 *   python tools/dump_action_parity.py > /tmp/parity.json   # reference side
 *   node tools/action_parity_check.js /tmp/parity.json
 */
const fs = require("fs");
const path = require("path");

const mouseActions = require(path.join(__dirname, "..", "sdk", "js", "mouse-actions.js"));

const TOL = 1e-6;
const REL_TOL = 1e-9;

const file = process.argv[2] || "/tmp/parity.json";
const ref = JSON.parse(fs.readFileSync(file, "utf8"));

let checked = 0;
let failed = 0;
const worst = { name: null, diff: 0, action: -1 };

for (const sample of ref.samples) {
  const actions = mouseActions.eventsToActions(sample.events);

  if (actions.length !== sample.actions.length) {
    console.log(`FAIL ${sample.name}: action COUNT differs — ` +
                `js ${actions.length} vs py ${sample.actions.length}`);
    failed++;
    continue;
  }

  for (let i = 0; i < actions.length; i++) {
    const js = actions[i].features;
    const py = sample.actions[i].features;

    if (actions[i].type !== sample.actions[i].type) {
      console.log(`FAIL ${sample.name} action ${i}: TYPE js ${actions[i].type} vs py ${sample.actions[i].type}`);
      failed++;
      continue;
    }

    for (let f = 0; f < py.length; f++) {
      const diff = Math.abs(js[f] - py[f]);
      const scale = Math.max(1, Math.abs(py[f]));
      checked++;
      if (diff > TOL && diff / scale > REL_TOL) {
        if (diff > worst.diff) {
          worst.name = mouseActions.FEATURE_NAMES[f];
          worst.diff = diff;
          worst.action = i;
        }
        if (failed < 12) {
          console.log(`FAIL ${sample.name} action ${i} ` +
                      `${mouseActions.FEATURE_NAMES[f]}: js ${js[f]} vs py ${py[f]} (|d|=${diff})`);
        }
        failed++;
      }
    }
  }
}

console.log("");
console.log(`samples ${ref.samples.length} | feature values compared ${checked} | mismatches ${failed}`);
if (failed) {
  console.log(`worst: ${worst.name} on action ${worst.action}, |diff| = ${worst.diff}`);
  console.log("PARITY FAILED — the browser and the training pipeline would build different features.");
  process.exit(1);
}
console.log("PARITY OK — browser and training extractors agree to within 1e-6.");
