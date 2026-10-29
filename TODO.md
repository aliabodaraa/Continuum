# TODO — known gaps, not yet fixed

Deliberately **not implemented**. Recorded so they aren't lost. Each entry says what
is wrong, why it matters, and roughly what the fix looks like — no code written yet.

Companion docs: `ARCHITECTURE.md` (system as built) · `DEPLOY.md` (ship it) · `HANDOFF.md` (session notes).

---

## 0. Recently closed (kept for the record)

Four gaps that were on this list, or should have been, are now fixed. Recorded here because
the *reasoning* is the part worth keeping.

- **model-api was unauthenticated and reachable by every container.** Compose declared no
  networks, so the demo and acme shared a bridge with it and could score, train or roll back
  any user's model — a biometric hill-climbing oracle. Fixed with three networks
  (`edge` / `internal` / `model`, ca-service the only member of the last) **and**
  `MODEL_API_KEY` on every route but `/health`. Topology alone was not enough: a future
  misconfiguration re-attaching a container would have silently reopened it.
- **The ca → model hop had no deadline.** A wedged TensorFlow process hung the keystroke
  check forever — an undefined failure mode in the authentication path. Now one bounded,
  credentialed client (`lib/modelClient.js`); a stalled model yields `503 model_unavailable`
  (*no verdict*, neither pass nor lock), logged at `[SECURITY]`.
- **Escalation evidence was in process memory.** The mouse strike counter lived in a `Map`
  and a session field, so any restart amnestied an impostor mid-escalation. Now persisted in
  `decision_state`; callers keep their threshold, not the count.
- **Retrains were detached promises.** `setImmediate` guarded by an in-memory `Set` lost both
  the run and the guard on restart, with nothing recording that work had been owed. Now the
  `training_jobs` queue with boot-time recovery of interrupted runs.

Two defects were found while making those changes and fixed in passing: the gateway passed
its identity assertion to `.catch()` instead of to `fwd()` on **both** the mouse `lock/set`
and the passkey `lock/clear` calls, so each silently 401'd — the mouse step-up lock was
never actually set, and a verified passkey never actually cleared it.

---

## 1. Tenant registration is not durable (`services/gateway/server.js`)

`POST /v1/tenants` generates `siteKey` (9 random bytes) + `secret` (24 random bytes) and
persists the whole tenant registry as one JSON file. Three separate problems.

> **1a, 1b and 1d fixed 2026-09-26** (`server.js` `loadJson`/`saveJson`). A save writes
> `<file>.tmp` and renames it over the old file. A failed tenant save returns
> `500 tenant_registry_write_failed`, drops the tenant from memory and issues no credentials. A
> registry or identity file that exists but cannot be read or parsed stops the gateway at boot with
> a message naming the file; only a missing file starts empty. `identity.json` gets the same atomic
> write, and a failed identity save is logged loudly without blocking the sign-in: the id is derived
> from the secret, so it stays correct. Site keys are drawn again on collision. Checked on a scratch
> gateway (`services/gateway/check_store.js`, 11 checks): fresh boot, a saved registration, a failed
> save (500, nothing kept, file intact), a truncated file refusing to boot. **1c stays open** (one
> process only, until the registry moves to SQLite).

### 1a. A failed disk write still returns `200`
`saveJson()` catches the write error, logs it, and returns normally — then the handler
unconditionally sends `res.json({ siteKey, secret })`. On a read-only or full disk the
operator receives credentials that live **only in RAM** and disappear on the next restart.

*Fix:* let `saveJson` propagate failure; return `500` instead of handing out phantom keys.

### 1b. Whole-file, non-atomic write
`fs.writeFileSync(TENANTS_FILE, …)` rewrites `tenants.json` in place. A crash mid-write
truncates it; `loadJson` then falls back to `{ tenants: {} }` on the parse error, so
**corruption reads as "no tenants"** — silently — and `pk_demo` re-seeds over the wreckage.

*Fix:* write `tenants.json.tmp` then `fs.renameSync` (atomic on the same filesystem).

### 1c. Two gateway replicas would clobber each other
`tenants` is loaded into memory once at boot and each registration rewrites the entire
file from that in-memory copy. Two processes ⇒ last writer wins, the other's tenants are
lost. **This is now the *only* thing keeping the gateway single-process** — worth stating
explicitly rather than discovering it in production.

> Update: this used to be one of two blockers. The other — per-user decision counters held
> in gateway memory, which two replicas would each hold half of — is closed: the counters
> moved into `decision_state` in ca-service. The gateway's remaining in-memory maps are
> `pkCache` (a 60 s cache; a miss is a re-fetch, not a wrong answer) and `lastRisk` (CAEP
> transition dedupe; after a restart the first *suspicious* still fires an event, which is
> the safe direction — the failure mode is a redundant event, never a missed escalation).

*Fix (real one):* move the tenant registry to SQLite, like `ca.db` / `passkey.db`. The
JSON file is fine for a single-process demo and wrong for anything else.

### 1d. No uniqueness check on `siteKey` (low priority)
`tenants.tenants[siteKey] = {…}` is an unconditional assignment — a duplicate would
silently overwrite an existing tenant (new secret, old tenant instantly broken).

**Not a practical risk:** 72 bits of CSPRNG entropy ⇒ ~1e-10 collision odds at a million
tenants, 50% only at ~81 billion. But making it explicit costs one line:

```js
let siteKey;
do { siteKey = "pk_" + crypto.randomBytes(9).toString("hex"); } while (tenants.tenants[siteKey]);
```

> Framing: **collision is handled by mathematics; durability is handled by nothing.**

---

## 2. `GATEWAY_ADMIN_KEY` defaults to open

`adminGate` becomes a **no-op** when `GATEWAY_ADMIN_KEY` is unset, and the variable appears
in **no** compose file and **not** in `.env.example`. On a fresh deploy, anyone who can reach
`:8080` can register a tenant.

*Fix:* add it to `docker-compose.bundle.yml` with the same fail-fast `${VAR:?…}` treatment as
`CA_SIGNING_SECRET` / `GATEWAY_SESSION_SECRET`, or refuse registration outright when unset.

> **Fixed 2026-09-26 for the bundle.** `docker-compose.bundle.yml` now requires
> `GATEWAY_ADMIN_KEY` (`${…:?}`), and `.env.example` and `DEPLOY.md` list it. The dev compose leaves
> it unset on purpose (the study's end-to-end test and `extension/STUDY_MODE.md` register tenants
> without it), and the gateway logs a `[SECURITY]` warning at boot when it is unset.

---

## 3. `pk_demo` is origin-unbound

The auto-seeded demo tenant is created with `origins: []`, and `originAllowed()` returns
`true` for an empty list — so **the demo site key is accepted from any origin**. Intentional
for the bundle (`ARCHITECTURE.md`: "only the demo tenant is left open"), but anyone who views
source on a live demo can lift `pk_demo` and register into that user namespace.

*Fix:* pin `origins` before any public demo, or gate the allow-all fallback behind `NODE_ENV`.

---

## 4. `POST /v1/tenants` is undocumented

The onboarding path for a real customer's app exists in code but appears in no operator
doc — `DEPLOY.md` never mentions it. Anyone asking "how does a second app onboard?" has to
read `server.js`.

*Fix:* a short "Register a tenant" section in `DEPLOY.md` with the `curl`, plus where each
returned value goes (`siteKey` → `<script data-site-key>`, `secret` → backend `CONTINUUM_SECRET`).

> **Done 2026-09-26:** `DEPLOY.md` "Register a tenant (one per app)".

---

## 5. Same-origin co-tenancy is undefended (by design — document it)

Origin binding cannot separate two apps on the **same** origin sharing a site key: identical
`Origin` headers, and `signSession` carries no path. Their `continuumUserId` namespaces then
collide, which cross-wires trained models, passkeys, locks, **and verdicts** (a verdict earned
in app B verifies at app A's `protect()`).

Correct today for one product across several surfaces (microfrontends, SPA + admin panel).
Wrong for two unrelated co-hosted products — those need **separate site keys**; overlapping
origins are fine, since the namespace keys on `siteKey`.

*Not a bug — a deployment rule.* Needs to be written down: **origin binding is a defense
against site-key theft, not a tenancy boundary. The tenancy boundary is the secret.**

> **Written down 2026-09-26** in `DEPLOY.md` ("Two apps, two tenants"). `pk_demo` (§3) is flagged
> there as demo-only as well.

---

## 5b. Training shares a process with inference inside model-api

The queue (§0) made retraining *durable*; it did not isolate it. model-api runs Flask's
development server (`app.run(...)`), which is threaded by default, so a training run does not
block `/api/user/predict` outright. Measured 2026-09-23 during an S1 mouse enrolment (nine fits,
about 2.5 min): 60-window mouse checks took about 150 ms, against about 115 ms idle, far inside
the 5 s inference deadline. What remains is CPU contention, which grows with concurrent training.

A related gap: the **first inference after a model-api restart** loads the user's model from
disk, and one such cold load exceeded the 5 s deadline (validate_pipeline check 5,
2026-09-23: model-api loaded the same model twice, i.e. ca-service had abandoned the first
request). The caller then gets "model temporarily unavailable" for that one check.

> **Cold loads addressed 2026-09-25** (`api.py`). One load runs per model: a caller that times
> out and retries now waits for the load already in progress instead of starting a second one
> (three simultaneous first requests: one load, all 200 in about 2.2 s). At boot the server loads,
> in the background, the live models used or trained in the last 14 days (`MODEL_WARM_DAYS`),
> newest first, at most 8 (`MODEL_WARM_MAX`); use is recorded in
> `artifacts/users/.last_used.json` by the server only. A model is loaded again as soon as
> training or a rollback replaces it. Checked: `validate_pipeline.js` passed right after three
> fresh restarts, and `e2e_mouse_a5.js` passed with warm-after-train visible in the log.

*Still open:* run model-api under gunicorn with more than one worker, and ideally a separate
worker class or process for `/api/user/train`, so training never competes with an inference slot.
Mind the memory: each worker loads TensorFlow and its own model cache.

**Memory grows with every training (found 2026-09-25).** Retraining the 84 keystroke profiles
for T3.3 in one model-api process took it from about 1 GB to about 11 GB resident, roughly
125 MB kept per training, and the PC ran short of memory. Experiment KS showed the same growth
in a plain training loop despite `clear_session()` per target (5.5 GB during one arm). A restart
frees it. Until the cause is found, restart model-api after a bulk retrain, and run training in
a worker process that exits (or is recycled) after each job. The gunicorn item above would do
this with `max_requests` on the training worker. Since T3.4 (2026-09-26) mouse enrolments train
no network (F2: one embedding pass and nine logistic fits, about 6 s), so they no longer add to
this: model-api stayed at about 1 GB through seven F2 trainings. Keystroke retrains still do.

> **Memory growth closed 2026-09-26** (`api.py` `train_isolated`). Measured outside the server
> (`_backups/leak_probe.py`, 10 keystroke trainings in one process): about 42 MB kept per training,
> and neither `clear_session()`, `malloc_trim`, `MALLOC_ARENA_MAX=2`, a cached base model nor
> skipping the save changed it, so the memory is held inside TensorFlow. Every `/api/user/train`
> now runs in a fresh child process (spawn) that exits when done; the server only evicts the
> replaced models from its cache and warms the new one. A test server on the same code stayed at
> 737 MB over 10 trainings. Results are unchanged: F2 LOSO scores and keystroke validation scores
> through the child equal in-process training bit for bit, and e2e_mouse_a5 reproduces its
> threshold (0.703466024387348). Cost: about 8 s of process start per training (F2 enrolment
> 6 s -> 14-16 s). `MODEL_TRAIN_IN_CHILD=0` restores in-process training;
> `MODEL_TRAIN_CONCURRENCY` (default 2) caps simultaneous trainings. Still open: the gunicorn item
> above (inference and training still share the CPU).

## 6. Future work already noted elsewhere

- **Mouse FAR ceiling (~24%)** — a model/biometric limit (bimodal per-user EER), confirmed by
  three sweeps; not fixable by threshold tuning. Real fix is score-level **fusion** with keystroke.
- **Desktop adoption** — the SDK+middleware mode ports to Electron/Tauri nearly unchanged
  (watch `file://` origin binding + WebAuthn RP ID); native toolkits need a capture shim.
  Idea worth developing: a **surface-portability conformance kit** — fixed event traces plus
  expected verdicts that any new capture surface must reproduce before it counts as a valid
  client, so a new shim can't silently skip the warmup-cap / paste / probation invariants.

---

## 7. Mouse: a user's threshold can collapse, and with it their protection

> **Server side addressed 2026-09-23 (recovery plan Phase 0):** S1 is deployed as the owner's
> disclosed deviation from the P6 verdict. The line is now the 20th percentile of the user's
> leave-one-sample-out scores (Method B, 440 windows, 33 of 60), which is item 1's candidate as
> measured, prompt cost included; see RUN_LOG 2026-09-23. The numbers below stay as the "before"
> (item 4). Still open: item 3 (validation on data SapiMouse cannot provide) and the browser
> extension, which keeps its in-sample line.
>
> **Update 2026-09-26 (T3.4):** the same threshold rule now runs on F2 (the frozen network with a
> per-user logistic head), which protocol L found non-inferior to S1 on the untouched Bogazici
> users. That test is also the first on data from outside SapiMouse (item 3): both systems were far
> weaker there (per-user AUC about 0.72-0.74 against about 0.96 on SapiMouse). A per-user line
> cannot fix a network that transfers poorly to other hardware and tasks.

The per-user line is the **1st percentile of that user's 330 enrolment window scores**, so in
practice it is set by their **three lowest enrolment windows**. A user who produced a few odd
windows while enrolling gets a line near zero — after which almost nothing ever falls below it
and an impostor is never flagged.

Measured on the first untouched group of twenty (P6, `analysis_J_P6.json`), deployed rule:

| user | impostor runs caught | per-window AUC | their line |
|---|---|---|---|
| user92 | 5% | 0.723 | 0.009 |
| user103 | 16% | 0.616 | 0.029 |
| user60 | 21% | 0.723 | 0.013 |
| user61 | 26% | 0.859 | 0.054 |
| other 16 | 63–100% | | |

Those four carry the whole gap between the two untouched groups: 77.1% (group 1, 20 users) vs
91.8% (group 2, 20 users); group 1 without those four averages 92%. Two causes stack — the user
is genuinely less distinctive (low AUC), *and* their line collapsed. Over all 40 untouched users
the deployed rule catches **84.4%** of impostor runs.

*Fix — none of it may be selected on the untouched groups, which are spent:*

1. **Pre-register the new threshold rule before running anything.** Candidate: score each
   enrolment sample with a model that did not train on it (Method B). Already measured on both
   untouched groups — it works (AUC +0.018 to +0.025, better for 18 of 20 users, capture +17.9
   points on group 1) but roughly doubles genuine prompts, so the pre-registered margin rejected
   it. What is needed is a variant that keeps the capture gain without the prompt cost.
2. **A floor under the personal line.** Tested as a candidate in P5 and never adopted; re-open
   only with a stated justification, since a floor trades one user's comfort for another's safety.
3. **Validate on data SapiMouse cannot provide.** All 120 of its users are spent (60 base, 20
   development, 20 + 20 untouched), so any new rule must be proven on a second public dataset or
   on the user study — not on SapiMouse again.
4. **Keep 77.1 / 91.8 / 84.4 in the record as the "before" numbers**, whichever way the fix goes.

*Why it is not simply "raise the percentile":* the percentile and the vote were chosen together
against a measured interruption budget (Experiment I). Moving either one alone re-opens that
trade-off, which is why this needs a pre-registered experiment rather than a tuning pass.

---

## 8. Typing: how much enrolment is enough? (asked by the owner 2026-10-20, deferred by him; RUNNING 2026-10-21 as experiment EC, artifacts/phase7/PREREGISTRATION_EC.md)

**The gap.** No test shows where more typing samples stop helping, so no "best number of samples" can
be stated for the typing channel. What exists is weak: a cross-user correlation of enrolment size with
performance, r = +0.04 at about 300 windows (a flat region only, and between different people), and
experiment AR2, where learning from all later typing (arm D) added +0.0485 AUC, which mixes more data
with more recent data. The mouse has its own enrolment curve (flat after about 330 windows); it says
nothing about typing.

**Why it matters.** The server gate is 5 samples and 12 windows (`MIN_TRAINING_SAMPLES`,
`MIN_POSITIVE_WINDOWS`), but the SDK wizard (`ENROL_PASSAGES`, `KS_ENROLL_SAMPLES = 5`) always collects
five passages of about 300 characters, which is about 26 windows each, so a live enrolment is about 130
windows. AR2's enrolment (5 samples of 330 steps, a median of 145 windows) matches it. What does not
match is the headline typing table (experiment KS): its models learn from the first 70% of the owner's
typing, a median of 306 windows, more than twice a live enrolment, so its numbers (per-user AUC 0.969,
FAR 11.9%, FRR 3.3%) are optimistic for a new user. AR2's "enrolment only" row (AUC 0.9186, FAR 15.0%,
FRR 13.5%) is the live-faithful one, but it is also tested on a later session, so training volume and
drift are mixed. The cheapest fix is one extra run of the KS evaluation with the live enrolment (the
first 5 passages, about 130 to 145 windows) against the same held-out last 30%, about 100 trainings and
30 to 60 minutes; the full curve below separates the two causes. The console options (1, 2 or 3 samples
before a retrain, each sample = 20 windows) also lack an evidence-based "best" value: AR2 ranks
1 > 2 > 3 samples by AUC (+0.0089, +0.0019, +0.0009) but one sample raises the FRR and its safety
against a poisoning impostor was not measured (only 3 forced samples were).

**What to run.** A pre-registered learning curve on the 99 KeyRecs targets with the KS recipe
(arm A200, same held-out last 30%, same impostors): train each user on the first 12, 20, 40, 80, 150
and about 300 windows, then report per-user AUC, FAR/FRR at the live rule and the share of users who
fall below a stated floor, with paired intervals. Roughly 600 trainings, about 18 s each, so 2 to 3
hours of compute with two or three workers capped on memory (a Docker Desktop restart killed the first
AR2 run). Then translate to the console: adding k samples means 20 k more windows. Add a
quality-filtered variant (study page roadmap row 7) only if the first curve is not flat.

**Not to claim until then:** a saturation point, an optimal number of samples, or that the minimum
enrolment of 12 windows is sufficient. Study page roadmap row 6 already lists this experiment.

**Result 2026-10-21 (experiment EC, docs/recovery/RESULTS_EC.md):** per-user AUC 0.570 / 0.737 / 0.851 / 0.873 / 0.916 / 0.938 / 0.965 at 12 / 26 / 52 / 78 / 130 / 208 / all windows. No saturation below all, so more typing kept helping. The live enrolment (130) is 0.049 below all, as AR2 found. 12 windows is useless (FRR 99%). Options are with the owner.

## 9. Mouse: make the training follow SapiMouse where it does not yet (asked by the owner 2026-10-21; FS run 2026-10-21; SapiMouse's settings ADOPTED by the owner 2026-10-22, DEPLOYED 2026-10-22 06:51 UTC)

The owner wants everything about mouse training to rest on the SapiMouse paper (Antal, Fejer & Buza, IEEE SACI 2021)
or another peer-reviewed source, never on our own choices alone or on preprints.

**Already from SapiMouse:** the data; the input (|dx|, |dy|); the FCN, which SapiMouse took from Fawaz et al. 2019; the
design of a network trained once to identify people, then frozen with a small per-user model on top; and the protocol of
enrolling from one session and testing on another against people the network never saw.

**Ours, each measured on our data:**
- The base-network training settings. `train_mouse_fcn.py` uses `repr_arch_study.train_base`: Adam 1e-3, batch 128, up
  to 40 epochs, early stopping 12, plateau 5. SapiMouse uses Adam 1e-4, batch 16, 100 epochs and keeps the lowest
  validation loss.
- The 50-step windows with stride 10, carried over from Lu's typing window rather than from a mouse paper. Measured
  2026-10-20: with a classifier trained against other people, windows beat SapiMouse's blocks (0.95 vs 0.92).
- The cleaning rules: drop the step after a pause over 0.5 s, drop zero moves, skip windows with a path below 0.08.
  SapiMouse drops steps with dt above the recording's mean plus one SD.
- The per-user classifier: a logistic head against a fixed cohort. Its use of others' data is supported by Matthiesen
  et al. [37]. Its threshold holds across sessions, while SapiMouse's one-class SVM threshold did not
  (`docs/recovery/RESULTS_E_NATIVE.md`).
- The enrolment of 440 windows, the 20th-percentile threshold and the 33-of-60 vote.

**Result 2026-10-21 (experiment FS, docs/recovery/RESULTS_FS.md):** with SapiMouse's training settings the base-80 network gives a per-user AUC of 0.9677 vs 0.9688 at 60 windows (-0.0012 [-0.0162, +0.0155], not shown non-inferior at -0.010 with 19 users). FAR is 9.3% vs 10.8% and the live loop gives 0.37 vs 0.48 requests per minute. The current settings stay under the frozen rule. Adopting SapiMouse's recipe anyway is the owner's decision.

**First candidate change:** retrain the deployed FCN on windows with SapiMouse's training settings. Use the
`analysis/phase6/e_native_blocks.py` recipe (`train_base_sapimouse`). This shifts every embedding, so the deployed
cohort, the per-user heads and every mouse number must be rebuilt and re-measured: paper Table 6, thesis Table 15, the
timing table and the study pages. Register the comparison first (the current recipe vs SapiMouse's recipe on the same
development users, per-user AUC of 60-window decisions, non-inferiority), then decide with the owner.

**Deployed 2026-10-22 06:51 UTC.** The cluster's model services run the network trained with SapiMouse's recipe
(cohort sha a5506e4677d5, was 40b54f05cfce) and ca-service runs decision version f2-sm-loso-p20-33of60. The three
enrolled profiles were retrained from their stored samples. Owner (739935229538144): threshold 0.316 -> 0.303,
leave-one-sample-out median 0.687 -> 0.711. The other two profiles: 0.746 -> 0.735 and 0.626 -> 0.587. Edge /ready and
/health 200. The undo images are model-api 8d69698976ec and ca-service 15a4a0ecaefd (with `artifacts/mouse-fcn-a5-ours`
moved back for any rebuild).

**Follow-up (owner's decision 2026-10-22: "if it improves, change nothing else").** After a few days of the owner's
ordinary use, export his mouse_decisions since 2026-10-22 06:51:10 and run `analysis/phase7/owner_mouse_diagnosis.py
--trained "2026-10-22 06:51:10" --loso '{"10":0.181,"20":0.303,"50":0.711}'`. Compare requests per minute with the old
profile's 0.52 (the lab expects about 0.37 with the new network). If it is clearly lower, keep everything. If not,
measure "two consecutive suspicious checks" on the stored SapiMouse scores before changing the rule.
SUPERSEDED 2026-10-24: he made no mouse check after 2026-10-19 08:53, so this profile was never measured live; it was
rebuilt by step 0 below. Use the command given there.

**Step 0 of learning from real use, DEPLOYED 2026-10-24 (owner's plan of 2026-10-23; his choices "delete the two copies
only", "stage 1 after step 0", deploy "yes now").** Found while planning stage 1: two of the 8 samples in the owner's
profile repeated two others (35 = 34 recorded 109 steps later, 81% of 20-step runs shared; 37 = 36 recorded 11 steps
later, 98%; saved 1-2 s apart on 2026-09-19). In leave-one-sample-out each copy had its twin in training, so the
threshold was too high: 0.303 against 0.262 without them. On his 1,159 old live checks the clean threshold would have
given 5 suspicious checks instead of 16 (about 0.16 instead of 0.52 per minute; approximate, the head also changes a
little). The cause, reproduced in headless Chrome against the deployed SDK: two sample flows at once ("+ train" pressed
twice) recorded the same movement and both saved it (100% shared); a flow closed with × kept recording in the
background; and the wait for the model stopped at its first poll (document.body.contains cannot see into the shadow
root). Changes:
- ca-service `lib/mouse.js`: a sample sharing more than 5% of its 20-step runs with a stored sample is refused (80
  SapiMouse base users, 1,214 samples: independent pairs share none, the pieces either side of a cut at most 3.7%);
  once the profile exists, enrolment answers 409 `already_enrolled` (re-enrol after the passkey reset), as typing
  since 2026-10-05. `scripts/dedup_mouse_samples.js` (report, `--apply`) removed the older sample of each repeated pair
  and rebuilt the profile. `test/mouseSamples.test.js` (5 tests; all 81 ca-service tests pass with PostgreSQL).
- SDK `guard.js`, `js/mouse-features.js`: one sample recorder at a time, a closed or covered one stops (the tracker
  detaches), the wait uses isConnected, a trained profile's "+ train" shows the trained state and the reset.
  `extension/scripts/e2e_headless_sdk_mouse.mjs` 13/13 (the deployed SDK failed 12 of them); the typing popup test
  still passes.
- Images: ca-service 9cf1bc80 (only `lib/mouse.js` and the new script differ from 8c75edb3), gateway 7bd0d6c3 and
  web-demo 59c73896 (the running images plus the two SDK files only; the gateway's pending `ui.js` typing text was left
  out). Undo: `docker tag continuum/ca-service:ep30 continuum/ca-service:local`, `continuum/gateway:pre-s0`,
  `continuum/web-demo:pre-s0` to `:local`, then the rollouts. Samples 34 and 36 remain in the owner's export of
  2026-10-22 only.
- Result: samples 34 and 36 removed (13 samples left), threshold 0.30277 -> 0.26208394455013234, exactly the offline
  value; leave-one-sample-out p10 0.153, p20 0.262, p50 0.585. Every other profile had no repeated sample and is
  unchanged. Edge 200, both origins serve the new SDK (md5 checked).

**Stage 1 of learning from real use, DEPLOYED 2026-10-24 about 20:50 UTC (owner: plan approved, live windows "yes, my
account only", "record a sample now" button "not now", deploy "yes now").** Collection only: no score, threshold,
vote or training changes.
- ca-service: new tables `mouse_use_anchors`, `mouse_use_samples`, `mouse_live_windows` (`db.js`); `lib/mouseUse.js`
  (an anchor is recorded only when the gateway verified a passkey in the same request; a sample must arrive within
  3 min, one per passkey, at most one per 3 h, the enrolment's checks plus the repeat check, the profile in force and
  its 55 scores stored, never a gate); routes `POST /v1/mouse/use-anchor`, `POST /v1/mouse/use-sample`; the status
  reports `useSamples`. `lib/mouse.js`: the 60 windows of every check of the users in `MOUSE_LIVE_CAPTURE_USERS`
  (set on the live deployment with `kubectl set env`, the owner's id only, not in the manifests) go to
  `mouse_live_windows`; a reset deletes all three tables' rows. `test/mouseUse.test.js` 7/7; all 88 ca-service and 44
  gateway tests pass.
- gateway: `/v1/sdk/passkey/auth/complete` adds `mouseUseSample` (the offer) to a verified answer; new
  `POST /v1/sdk/mouse/use-sample`; `connect.html` asks on the extension's verify page. SDK `guard.js`: the question
  after a step-up (only with the mouse on), a fresh recorder, dropped at any lock; the verification carries its
  reason. `e2e_headless_sdk_use_sample.mjs` 12/12.
- extension (the owner reloads it): `content.js` records on the start message only, `background.js` keeps the offer and
  the recording in storage.session and waits for them after a restart, the popup shows the last sample.
  `e2e_headless_ext_use_sample.mjs` 12/12 with a simulated gateway, including a worker stopped mid-sample. The study
  page loads the SDK with the mouse off, so participants are never asked.
- Images: ca-service 9b55775f (db.js, lib/mouse.js, lib/mouseUse.js, server.js differ from 9cf1bc80), gateway
  0e3933bc (server.js, public/connect.html, sdk-public/guard.js differ from 7bd0d6c3; built from it). web-demo stays
  59c73896: its own pages run the SDK in demo mode, where stage 1 never runs. Undo: retag `:s0` for both, roll out,
  `kubectl -n continuum set env deployment/ca-service MOUSE_LIVE_CAPTURE_USERS-`; the new tables stay unused.
- Design fact for stage 2: a sample (55 windows) is complete before the first mouse check after the passkey can run
  (60 windows), so no live vote has judged its movement when it is stored. Its stored scores allow that check offline.
- After stage 2: remove the env (command above) and delete the owner's `mouse_live_windows` rows.
- 2026-10-25, the owner's first test found no anchor: he uses the demo app's own pages (demo mode), whose passkey goes
  through the tenant API (traces 09:09:32 `/v1/server/mouse/check` -> `/v1/server/lock/set` -> `/v1/server/passkey/auth/complete`),
  and stage 1 was wired only to `/v1/sdk/passkey/auth/complete`. Owner: "wire it to the demo". DEPLOYED 2026-10-25: gateway
  98feb60a (FROM the running paste image a61ba5bf, only server.js and sdk-public/guard.js): `/v1/server/passkey/auth/complete`
  records the anchor and returns the offer, new `POST /v1/server/mouse/use-sample`; web-demo b9c93949 (FROM s0 59c73896:
  routes/webauthn.js relays the reason and the offer, routes/auth/mouse.js `/api/mouse/use-sample` (refused while locked by
  the app.js gate), services/caClient.js, services/passkeyClient.js, sdk-assets/guard.js); SDK: the question in demo mode too.
  `e2e_headless_sdk_use_sample.mjs` 15/15 (adds the demo page). ca-service unchanged. Undo: retag `continuum/gateway:paste` and
  `continuum/web-demo:s0` to `:local`, roll out.
- 2026-10-25 09:54-09:55 UTC, first end-to-end run on the demo (owner present): a replay of held-out SapiMouse user8's real
  movement, steps rescaled x1.24 to the owner's step size, injected into his dashboard tab by Claude in Chrome. Live checks
  25, 28, 32, 36 low of 60 (the first included 10 of his own windows): lock at 09:54:53. He passed the passkey, the
  question showed, "Record": real-use sample 1 stored 09:55:28 (anchor 3, 24 s after the passkey, 55 windows, 0 below
  his threshold). EXCLUDE FROM STAGE 2: his mouse_decisions and mouse_live_windows rows from 09:54:33 to 09:54:54 UTC are
  the injected impostor (checks 09:54:48, :50, :51, :53). Anchors 1 and 2 (09:36:52, 09:37:43) were offered and not used.
- 2026-10-25 13:11:51 UTC, TEMPORARY (owner: "stop the 3-hour idea for now, bring it back later", chose "no gap"):
  `MOUSE_USE_SAMPLE_GAP_HOURS=0` set with `kubectl set env` (not in the manifests), so the remaining three real-use samples
  can be taken today on demand. ca-service image unchanged (563515c9). RESTORE after the 4th sample:
  `kubectl -n continuum set env deployment/ca-service MOUSE_USE_SAMPLE_GAP_HOURS-` (back to 3 h). Samples taken while
  the gap is 0 come from passkeys asked on purpose, not from alarms; record their anchor times for stage 2.
  DONE: samples 2, 3, 4 at 13:31:14, 13:33:53, 13:35:35 UTC (anchors 6, 7, 8 verified 13:31:06, 13:33:44, 13:35:26,
  each after `window.Continuum.requireStepUp("mouse")` called by Claude in Chrome in his demo dashboard tab at 13:30:38,
  13:32:17, 13:35:09; 55 windows each, 2, 2 and 0 below his threshold; each took about 8 s, not the 16 s told to him).
  Gap RESTORED 13:36:15 UTC (env removed, running code reads 3 h, image 563515c9 unchanged, edge :8080 200). Real-use
  samples now 1 to 4. Not alarms: his decisions and live windows between 13:30:38 and 13:35:35 UTC belong to these
  on-demand step-ups and samples, so leave them out of the false-request count.
- 2026-10-25 found while collecting: the web-demo pod (and most pods) restarted at 09:58:29 UTC (exit 0, model-inference
  OOMKilled 09:58:38, a node-wide event). The demo keeps sessions in memory (app.js `session({...})`, no store), so every
  user was signed out silently: the open dashboard kept showing, its checks stopped (no demo mouse checks from 09:58 to
  13:30; his 218 checks at 12:44-12:54 came from the extension), and the step-up modal said "userId required" (demo-mode
  `stepUp()` posts `me.userId` from a 401 `/api/auth/me`). To propose (not done): the SDK says "Your session has ended,
  sign in again" on a 401, and/or a persistent session store for the demo.
  SDK part BUILT 2026-10-25 (owner "yes"): sdk/guard.js demo mode, e2e_headless_sdk_session_end.mjs 14/14, image
  continuum/web-demo:se 9860237c (only sdk-assets/guard.js differs from s1d). Deploy needs the owner's OK; it signs demo
  users out once. The persistent session store is still only an idea. Gateway mode still shows a stale state on a 401.
  DEPLOYED 2026-10-25 14:10 UTC (web-demo 9860237c). Undo: retag continuum/web-demo:s1d as :local and roll out.
  2026-10-29 (owner approved an architecture review's four fixes, all LIVE): the demo's sessions now persist in its SQLite
  (apps/demo/lib/sessionStore.js, web-demo fbb7b533; the restart signs users out no more); passkey-service has a startupProbe
  (it was probe-killed at every node restart: 19 restarts); a daily pg_dump copy of the three databases to SeaweedFS
  (deploy/k8s/base/continuum/pg-backup.yaml, 10:00 UTC, 31 slots, read back and checksummed; first run OK; restore =
  pg_restore + checksums.sql, DEPLOY.md); the old ticketing project in namespace default scaled to 0 (its deletion is the
  owner's: `kubectl -n default delete deploy,svc --all`). STILL OPEN from the review: TLS at the edge (cert-manager),
  mTLS/mesh, alerts and Loki logs, WAL archiving/PITR (Barman Cloud plugin needs cert-manager), CI on GitHub (billing;
  a self-hosted runner keeps the repo private), deploys by digest from CI, key rotation, tenant secrets in clear.
- 2026-10-25 STAGE 2 (RU) FROZEN: artifacts/phase7/PREREGISTRATION_RU.md (sha256 72786bf8, 13:48 UTC); code
  services/model-api/analysis/phase7/run_ru.py. Test data = his live checks from 2026-10-25 21:00:00 UTC; cut-off = end
  (20:59:59 UTC) of the first day with >= 1,125 non-warm-up checks from >= 2 sittings, at the latest 2026-10-28 20:59:59 UTC.
  Then export (same three \copy queries as the smoke, period filter instead of the 13:30:38 limit) and run
  `run_ru.py --mode test --end "<cut-off>"` in the model-api image (mounts as for the smoke, see COORDINATION 25 Oct 14:15).
  Do NOT export or look at checks after 21:00 UTC before the cut-off. Smoke (not evidence) warns B asks more (14 vs 4).
  AMENDMENT A1 (owner wants the decision today; PREREGISTRATION_RU_A1.md, sha256 b39a80a5): same-day test from
  2026-10-25 14:35:00 UTC until he says he has finished (latest 20:59:59 UTC), >= 375 non-warm-up checks; run
  `run_ru.py --mode test --amendment A1 --start "2026-10-25 14:35:00" --end "<his finish>"`. Keep A = final for this mix.
  RUN 2026-10-25 19:40 UTC (end 19:36:29, the 375th check): KEEP A. Requests A 0, B 0 in 10.0 min (3 sittings); B catches
  more impostors (raw 88 vs 77, scaled 82 vs 57). Results artifacts/phase7/ru_test_a1_result.*. Next: owner decides roll-back.
  ROLLED BACK 2026-10-25 20:34 UTC (owner): ca-service c0e91809, real-use samples off unless MOUSE_USE_SAMPLES=on, live
  capture env removed. The frozen next-day test is closed. Not in the paper or thesis (owner). Open: his 4 samples and his
  mouse_live_windows rows are still stored; delete only if he asks (he runs the delete himself).
  2026-10-25 21:00 UTC: owner asked to delete everything related to the experiment. Commands given to him (Claude does
  not delete data): DELETE FROM mouse_use_samples / mouse_use_anchors / mouse_live_windows (4 / 10 / 960 rows, his only;
  no foreign keys), and Remove-Item of the scratchpad exports ru/smoke, ru/test_a1 and 2518dc76's owner_mouse. Kept: the
  normal mouse_decisions log, the pre-registration, the aggregate results and the switched-off code. Verify after he runs them.
  DONE 2026-10-29: he ran them; all three tables 0 rows, the exports gone; the day-29 backup slot re-taken without them.

**Baseline to measure next (stage 1 changes no decision, so it runs in the same days):** the owner keeps mouse protection on for some days, then
export his mouse_decisions since 2026-10-24 15:08:29 and run `analysis/phase7/owner_mouse_diagnosis.py --trained
"2026-10-24 15:08:29" --loso '{"10":0.153,"20":0.262,"50":0.585}'`. This is the clean baseline (new network, no copies)
for learning from real use; compare with 0.52 (old network, with copies).

**Windows vs blocks re-run, DONE 2026-10-22 (docs/recovery/RESULTS_ENW.md):** with both networks trained with
SapiMouse's recipe, windows still beat blocks with the binary head (0.949 vs 0.918, p 0.04, 14 of 20 people), and the
one-class SVM is a tie (0.892 vs 0.915, p 0.13). The segmentation stays. Paper and Arabic copy now say 14 of 20 (was
16). Thesis Table 11 says both networks were trained as in [2], with 0.91 vs 0.89 (was 0.90). All three documents
rebuilt and installed.

**23 Oct 2026, owner "apply" (three items).**
1. Paper Table 6, thesis Table 15 and the Arabic copy now use rows of 9, 34 and 60 windows, the movement of one, three
   and five SapiMouse blocks. The values are 12.2/21.9/15.4%/0.924, 10.6/12.1/11.4%/0.960 and the unchanged 60 row.
   One sentence was added: sixty windows cover the movement of the five blocks whose scores [2] averages.
2. One line each explains the enrolment amounts.
   - Typing: EC in paper 3-2, thesis 3 and the Arabic copy, and Table 2 now reads "give a per-user AUC of 0.92".
   - Mouse: MC in paper 3-3, thesis 3, the Arabic copy and the thesis Table 11 row. The stale "0.856 vs 0.861" was
     removed.
3. Experiment PR (persistent suspicion) is pre-registered (f7458474) and its script is written (`run_pr.py`).

**DONE 23 Oct 00:34:** Docker was started (owner: "start it"). The live cluster came back healthy. fs_paper_numbers FS_table equals the new rows. The ROC figure was redrawn at 34/60. All three documents were rebuilt, diffed and INSTALLED, and the preview folder was removed. **PR result** (docs/recovery/RESULTS_PR.md): the pre-registered pick is A6, six consecutive suspicious checks. It gives 0.14 vs 0.37 requests per minute and 95.3% vs 98.1% caught (lower bound -4.99, at the margin), 8 s later. A3 is the safer middle point (0.25/min, 96.7%). Deployment needs the owner: MOUSE_STRIKES_TO_LOCK in the gateway and the demo, plus a rollout. (Original note follows.) Previously: the previews were in `paper/build/preview`, NOT installed. **Waiting for Docker** (Docker Desktop was found closed on 23
Oct, after an orderly exit at 12:49 local on 22 Oct, so the live cluster is down; it is not restarted without the
owner):
- (a) `fs_paper_numbers.py`: its FS_table rows must equal the new table;
- (b) `fs_roc_figure.py` at 34 and 60, copied to `paper/figures/fig_mouse_sapimouse_roc_sm.png`, because the thesis
  caption already says 34;
- (c) `run_pr.py`;
- then rebuild, diff and install the three documents.

## 10. Mouse: a console choice of the decision length, like typing's 6 / 10 / 20 (asked by the owner 2026-10-21, not started)

The console lets an organisation choose the typing packet (6, 10 or 20 windows) but offers only on/off for the mouse,
which always decides on 60 windows. The owner asked how the verdict would work for the other lengths of the mouse
table and asked to record it.

**The rule for any length N.** The passkey is asked when at least ceil(0.55 N) of the last N windows are below the
user's personal threshold, the share of today's 33 of 60. That gives 9 of 15, 19 of 33 and 33 of 60 (17 of 30 and 6 of
10 by the same rule). The threshold (20th percentile of the leave-one-sample-out scores), the check every 1.6 s and the
passkey at the first suspicious check stay as they are. The first verdict comes after (40 + 10 N) x 0.0269 s of
movement: about 5 s at 15, 10 s at 33 and 17 s at 60.

**Measured already** (stage D, 19 users, F2; `analysis/phase6/mouse_decision_length.py`, paper Table 6, thesis
Table 15): 15 windows FAR 14.2%, FRR 15.1%; 33 windows FAR 12.9%, FRR 10.0%; 60 windows FAR 10.8%, FRR 10.0%. These are
step-disjoint decisions, each window counted once.

**To measure before adding it.** The live loop at 15, 33 and 60: one check per about 6 new windows (1.6 s), each on
the last N windows, replayed on the stage D F2 scores (`p1lib.replay(..., "vote", N, K)` as in
`analysis/phase2/analyze_c.live_loop`). Report the genuine passkey prompts per minute, the users never prompted, the
impostor runs caught and the time to catch. A short decision changes more from one check to the next, so the step-disjoint
FRR does not tell how often the real user is asked. Decide the choices and the default with the owner after this.

**Measured 2026-10-21** (`analysis/phase6/mouse_live_decision_length.py`, artifacts/phase6/mouse_live_decision_length.*; the 60-window row reproduces the recorded deployed live loop 0.48 / 73.7% / 96.1%):

| Decision | Genuine passkey requests per minute of movement | Users never asked | Impostor runs caught | Mean time to catch |
|:--:|:--:|:--:|:--:|:--:|
| 15 windows (9 low) | 2.48 | 32% | 99.7% | 7.0 s |
| 33 windows (19 low) | 0.85 | 63% | 98.1% | 11.9 s |
| 60 windows (33 low, deployed) | 0.48 | 74% | 96.1% | 18.1 s |

With the network trained as in SapiMouse (adopted 2026-10-22; `analysis/phase7/fs_paper_numbers.py`): 15 windows 2.45/min, 32%, 99.7%, 6.9 s; 33 windows 0.92/min, 47%, 98.6%, 11.6 s; 60 windows 0.37/min, 79%, 97.0%, 17.8 s.

The step-disjoint FRR of 33 equals 60's (10.0%), but in the live loop 33 asks the real user 1.8 times as often and 15 about 5 times as often, because a short decision changes more between checks. Impostors are caught a little more often and faster. If a choice is offered, 15 is not a reasonable option. Decide with the owner.

**Where it would go**, following `keystrokeDecisionWindows`:
- `services/gateway/settings.js` (a `mouseDecisionWindows` entry, choices 15 / 33 / 60, default 60, its own claim),
  `services/ca-service/lib/appSettings.js`, the console text in `services/gateway/public/ui/ui.js`, and both test files.
- `services/ca-service/lib/mouse.js`: `VOTE_N` / `VOTE_K` become per request. `MOUSE_DECISION_VERSION`
  (`f2-loso-p20-33of60`) is stored with every profile, and a profile with another version is rebuilt. The threshold does
  not depend on N, so the version must stop naming N and K, or every change of the setting would rebuild every
  profile.
- Clients: the SDK takes the vote length only from a check's reply (`bufferMax`), and the extension has
  `MOUSE_N = 60` fixed. Both wait for 60 windows before their first check, so the length must come with the start-up
  config (`/config`, as `recentWindowCount` does for typing), or the first verdict at 15 would still come after 17 s.
- The console text must quote the live-loop numbers measured above.

**Done 2026-10-21 (owner: "sure"): the typing option's console text now quotes paper Table 4.** It said fewer windows
"flag the real user more often (about 24% of their verdicts at 6, 19% at 10, 15% at 20); impostors are caught about as
often (~91%)", a source that was never found. `services/gateway/public/ui/ui.js` now says about 10%, 6% and 3%, and
~88% caught, from the deployed model (`analysis/phase3/packet_length_a200.py`: FRR 10.1%, 6.2%, 3.3%, FAR 12.4%,
12.6%, 11.9%). The running gateway still serves the old text until its image is rebuilt and rolled out (asked the
owner first). The mouse console text, when added, must likewise quote the measured numbers.
