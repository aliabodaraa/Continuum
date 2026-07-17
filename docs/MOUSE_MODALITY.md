# Mouse Dynamics Modality — Integration Notes

Second behavioural biometric added alongside keystroke dynamics. Same
architecture and pipeline; only the sensor and features differ.

## Dataset

- **SapiMouse** (Antal, Fejér & Buza, 2021) — 120 subjects, Apache-2.0.
  - Antal, M., Fejér, N., & Buza, K. (2021). SapiMouse: Mouse dynamics-based
    user authentication using deep feature learning. *2021 IEEE 15th Int. Symp.
    on Applied Computational Intelligence and Informatics (SACI)* (pp. 61–66).
    IEEE. https://doi.org/10.1109/SACI51354.2021.9465583
- Raw CSV columns: `client timestamp (ms), button, state, x, y`.
- Events: state ∈ {Move, Pressed, Released, Drag}; button ∈ {NoButton, Left, Right}.

## Feature vector (per motion point) — F = 7

`[dx, dy, v, a, dtheta, dt, is_click]`

| # | feature | meaning | range |
|---|---------|---------|-------|
| 0 | dx | Δx since prev point ÷ 1920 | [-1, 1] |
| 1 | dy | Δy since prev point ÷ 1920 | [-1, 1] |
| 2 | v | speed (px/ms), log1p | ≥ 0 |
| 3 | a | \|speed change\|, log1p | ≥ 0 |
| 4 | dtheta | turn angle between moves ÷ π | [-1, 1] |
| 5 | dt | time gap (s), clipped | [0, 1] |
| 6 | is_click | Pressed/Released/Drag flag | {0, 1} |

Streams split on idle gaps > 2 s (no motion vector spans an away-from-mouse
pause) — the mouse analogue of the keystroke composition-pause drop.

## Pipeline reuse (all UNCHANGED)

- `preprocess_mouse.py` → `Mouse_WS50.h5` in `(N, 50, 7)` + binary `y` +
  explicit per-user `groups` (leak-free split; a user is never in train & test).
- `data_loader.py` reads `groups` when present (added).
- `train.py` forwards `groups`; `FeatureScaler` skips keystroke clipping for
  non-6-dim data (z-score only). Base model: `artifacts/mouse-ws50-gru/`.
- Per-user model: identical base → freeze Conv1D → fine-tune GRU+Dense.

## Fusion (score level — decision engine unchanged)

Each modality produces a per-window genuine score. The packet vote, passkey
step-up, adaptive retraining and acceptance gate operate on the fused score,
so nothing above the scoring layer changes. Fill-in rule: score whichever
modality has fresh data; when both are active, weighted combine.

## Remaining work (live)

1. `mouse-tracker.js` — capture mousemove/click/wheel (mirror keystroke-tracker).
2. Client → same feature builder (JS port of `events_to_steps`).
3. `/api/user/predict` already modality-agnostic (takes `windows`, `modelPath`).
4. Enrollment: collect mouse windows passively during the same enrollment session.
5. Fuse the two scores before the packet vote.
