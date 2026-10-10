# Moving the live system from Compose to Kubernetes (step 9)

For whoever runs the switch on this PC. The live system (the Compose stack in `../continuum`, branch `main`)
moves into Docker Desktop's Kubernetes cluster (`scripts/k8s-local.sh`). It keeps its addresses. The Compose
stack is stopped, not removed, and stays untouched for 14 days as the way back.

**Since the switch** (`cloud-native` merged into `main` the same day, OWNER):
- The scripts run from the main checkout, `continuum/`; the secrets were copied to its
  `deploy/k8s/overlays/local/secrets/` (git-ignored).
- The code the Compose stack ran is tagged `pre-k8s-switch`.
- The commands below were written for the worktree `continuum-cloud`, where `../continuum` was the main
  checkout.

## What users notice

- **Same addresses:** the API and extension on http://localhost:8080, the demo on :3000, Acme on :4200.
- **Everyone signs in once more.** The cluster has its own secrets, not the public development defaults:
  - extension users sign in with their passkey;
  - demo users sign in with their password.
- **Nothing else changes.** These all move, each copy verified:
  - user ids, organisations, accounts;
  - passkeys, re-keyed to Continuum ids;
  - typing and mouse samples, profiles, models;
  - decisions, the study log, the training queue.
- **The operator page moves** to a private port-forward:
  - run `scripts/k8s-local.sh operator`, then open http://localhost:28081/operator.html;
  - the edge never serves it; under Compose it was http://localhost:8080/operator.html.

## Done: the switch on 2026-10-10, 12:15–12:25

Every check passed:
- **Import** (137 s), identical part by part:
  - gateway: 9 organisations, 344 user ids;
  - passkeys: 27;
  - ca-service: 881,620 rows;
  - models: 154, each stored with its own fingerprint.
- **The import's proof:**
  - every logged verdict replays;
  - the study export is identical.
- **End-to-end suites:** connect 93/93, enrol-reload 10/10, demo-backend 19/19.
- **First cluster backup:** restorable.

Compose is stopped until 2026-10-24.

## Rehearsed before it (2026-10-10, on a copy of the data)

- **Platform, images and secrets:** `scripts/k8s-local.sh platform | secrets | build`.
- **Rehearsal import** of a copy (`scripts/k8s-import.sh .`). Every part was identical:
  - gateway records: 9 organisations, 354 user ids, 3 accounts, 291 activity entries;
  - demo users;
  - passkeys: 28, re-keyed for 57 demo users;
  - ca-service: 23 tables, about 916,000 rows;
  - models: 189.
- **On the imported data:**
  - all four end-to-end suites pass through the edge;
  - replaying the study log reproduces all 243 logged verdicts;
  - the study export is identical to one made from the source file.
- **Backup and restore:**
  - `scripts/k8s-backup.sh` took a backup;
  - `scripts/k8s-restore.sh --verify-only` restored each database into a throwaway PostgreSQL, with every
    table identical and all 192 models matching their fingerprints;
  - `--restore` rebuilt the cluster's three databases from the backup: every table identical, each
    service still owning its tables;
  - the suites pass afterwards.

## The switch (about 30 minutes, the system is down from step 3 to step 6)

Run steps 1–2 before the downtime starts. Commands run in this checkout (`continuum-cloud`) unless they say
`../continuum`.

1. **Images of the code being deployed:** `scripts/k8s-local.sh build`. Check that `git status` is clean
   and the branch has everything `main` has: `git merge-base --is-ancestor main HEAD`.
2. **A backup of the live data** (kept on this PC; a copy that leaves it is made with `BACKUP_PASSPHRASE`, encrypted):
   ```bash
   (cd ../continuum && scripts/data-export.sh)
   (cd ../continuum && scripts/data-import.sh _backups/<file>.tgz --verify-only)   # must print BACKUP OK
   ```
3. **Stop Compose:** `(cd ../continuum && docker compose stop)`. Use `stop`, not `down`: the containers are
   kept for going back. None of them restarts by itself.
4. **The cluster on the usual addresses:** `K8S_OVERLAY=live scripts/k8s-local.sh up`. Use `up`, not
   `deploy`: the pods read the addresses only when they start, so they must restart.
5. **Import the live data:** `scripts/k8s-import.sh ../continuum`.
   - It refuses to run while that Compose stack is up.
   - It replaces what the cluster held (the rehearsal copy).
   - It only reads the live files and checks at the end that they did not change.
6. **Checks.** If any check fails, go back at once (below). Nothing new has been recorded yet, so nothing
   is lost.
   - **The import's own proof**, printed at its end; it stops with an error if any point fails:
     - the gateway answers from PostgreSQL with every organisation of `tenants.json`;
     - the study log replays to every logged verdict (`REPLAY REPRODUCES EVERY LOGGED VERDICT`);
     - the study export equals one made from the live `ca.db`, apart from the export time;
     - the live files did not change.
   - **End-to-end suites** that remove what they create: connect, enrol_reload, demo_backend.
     - Run them with `CONTINUUM_K8S_CONTEXT=docker-desktop CONTINUUM_NETPOL_UNENFORCED=1
       CONTINUUM_OPERATOR=http://localhost:28081 CONTINUUM_EXTENSION_DIR=../continuum/extension` (the live
       gateway admits the main checkout's extension only), `CA_SIGNING_SECRET` from
       `deploy/k8s/overlays/local/secrets/continuum.env`, and `scripts/k8s-local.sh operator` running.
     - The study suite already passed on the copy. It adds a test participant to the study log, so it is
       not run on the live data.
   - **By hand:**
     - sign in to the extension with your passkey, and check that a typing check gets a verdict;
     - log in to the demo at :3000;
     - open Acme at :4200.
7. **A first backup of the cluster:** `scripts/k8s-backup.sh`, then `scripts/k8s-restore.sh <file> --verify-only`.

## Afterwards

- **Back up the cluster** daily, and before any change: `scripts/k8s-backup.sh` with
  `BACKUP_PASSPHRASE`, and keep a copy off the PC.
  - `data-export.sh` now backs up only the stopped Compose data.
  - The cluster backup also holds `../paper`, as `data-export.sh` did.
- **Keep the Compose containers** stopped and untouched for 14 days. After that, remove them with
  `docker compose down` in `../continuum`. This removes the containers only, not the data files.
- **Merge `cloud-native` into `main`:** done on 2026-10-10.
  - `main` fast-forwarded and pushed; the old code is tagged `pre-k8s-switch`.
  - The secrets were copied into `continuum/`, and the `k8s-*` scripts run from there.
  - The worktree `continuum-cloud` can be removed after the 14 days.

## Going back (within the 14 days)

The Compose stack runs the code of its folder (bind mounts), and `main` has moved on, so first put that folder
back on the code it ran. Its data files are not in git and stay as they were. In `continuum/`:

```bash
K8S_OVERLAY=local scripts/k8s-local.sh up     # the cluster moves to 28080/23000/24200, freeing 8080/3000/4200
git checkout pre-k8s-switch                   # the code the Compose stack ran (the folder must be clean)
docker compose start
```

Afterwards, `git checkout main` returns the folder to the current code; stop Compose first.

Compose comes back with the data as it was at the switch, under its old secrets: users sign in again.
Whatever the cluster recorded after the switch (new samples, decisions, study log, sign-ups) is **not** in
the Compose files. It stays in the cluster and in its backups. No tool copies it back into the Compose
files.
