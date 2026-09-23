# Continuum — System Concepts Reference

---

## 1. Raw Input

### Keystroke
One physical key press + release. Each keystroke produces two events:
- `keydown` — the moment the key is pressed
- `keyup` — the moment the key is released

### Dwell Time
How long a single key is held down.
```
key A pressed at 100ms, released at 140ms → dwell = 40ms
```

### Flight Time (UD — Up-Down)
Time between releasing one key and pressing the next.
```
key A released at 140ms, key B pressed at 155ms → UD = 15ms
```

---

## 2. Digraph (Core Feature Unit)

A **digraph** = one pair of consecutive keystrokes.

```
You type:  H  e  l  l  o
Digraphs:  [H,e]  [e,l]  [l,l]  [l,o]
```

### N keystrokes → N−1 digraphs
51 keystrokes → 50 digraphs (off-by-one: you need pairs)

### 6 features per digraph
| Index | Name | Description |
|---|---|---|
| 0 | `id1` | Key code of first key ÷ 254 (normalized 0–1) |
| 1 | `id2` | Key code of second key ÷ 254 |
| 2 | `dwell1` | Hold time of first key (seconds) |
| 3 | `dwell2` | Hold time of second key (seconds) |
| 4 | `DD` | Down→Down: gap between pressing key 1 and pressing key 2 |
| 5 | `UD` | Up→Down: gap between releasing key 1 and pressing key 2 |

---

## 3. Window

A **window** = 50 consecutive digraphs fed to the model as one unit.

### Shape
```
(50, 6) matrix = 300 numbers total

         id1    id2   dwell1  dwell2    DD     UD
row 1  [ 0.32  0.43   0.041   0.038  0.112  0.071 ]
row 2  [ 0.43  0.47   0.038   0.044  0.098  0.060 ]
...
row 50 [ 0.51  0.29   0.052   0.039  0.130  0.088 ]
```

### Characters needed
- 51 characters (including spaces) ≈ 51 keystrokes ≈ 50 digraphs = **1 window**

---

## 4. Stride and Overlap

**Stride = 10** — the number of new keystrokes that shift the window forward.

Windows overlap by 40 digraphs (80% overlap):

```
Window 1: digraphs  1 ──────────────── 50
Window 2: digraphs     11 ──────────────── 60   (+10 new)
Window 3: digraphs         21 ──────────────── 70   (+10 new)
Window 4: digraphs             31 ──────────────── 80   (+10 new)
```

### Why overlap?
More evaluation points from less typing. Without overlap (stride=50) you'd need
500 characters for 10 decisions. With stride=10, you get 10 decisions from ~150 characters.

### Total keystrokes for N windows
```
Window 1 → 51 keystrokes
Window 2 → 51 + 10 = 61
Window 3 → 51 + 20 = 71
Window N → 51 + (N-1) × 10
```

### Tail window
The server also adds a **tail window** = the last 50 digraphs at any point, even when
the steps don't land exactly on a stride boundary. This means the window count is:

```
wins = Math.ceil((steps - 50) / 10) + 1   when steps >= 50
```

Not `Math.floor` — the tail window adds one extra whenever steps don't align to stride.

---

## 5. When the First Check Fires

```
CHECK_MIN_TEXT        = 80 characters  (minimum text before any check)
CHECK_KEYSTROKE_INTERVAL = 25          (minimum new keystrokes between checks)
```

At 80 characters ≈ 80 keystrokes → steps = 79 → **4 windows already ready**.

The system never evaluates with 0 windows. By the time the first check fires,
there are always 3–4 real windows.

---

## 6. How a Single Window Is Classified (Genuine vs Bad)

The CNN/LSTM model receives the (50×6) window and outputs one number:

```
genuine_score ∈ [0.0, 1.0]
```

That score is compared to the user's personal EER threshold:

```
score >= threshold  →  genuine window  (good)
score <  threshold  →  bad window
```

Nothing else. One comparison per window.

---

## 7. Packet Decision (Session-Level)

> **`PACKET_VOTE_FRACTION` is `0.50`, not `0.34`** below — this section pre-dates that
> change (see the constant's own comment in `keystrokeSecurity.js`; this is unrelated to
> the 2026-09 packet-size experiment, which was tried and reverted). The mechanism
> (fraction of low windows in a packet) is accurate; only the fraction number is stale.
> Kept for the worked "fewer windows available" example, which is still illustrative.

**Packet = last 6 windows** (or fewer if not enough data yet).

```javascript
RECENT_WINDOW_COUNT  = 6
PACKET_VOTE_FRACTION = 0.50
```

### Rule
```
fraction = bad_windows / total_windows_in_packet
if fraction >= 0.50  →  Suspicious
else                 →  Genuine
```

### With different packet sizes (numbers below use the doc's original 0.34 for illustration)
| Windows available | Bad needed to flag | Fraction |
|---|---|---|
| 4 | 2 | 2/4 = 0.50 >= 0.34 ✓ |
| 5 | 2 | 2/5 = 0.40 >= 0.34 ✓ |
| 6 | 3 | 3/6 = 0.50 >= 0.34 ✓ (2/6=0.33 < 0.34, tolerated) |

6 windows is the **designed operating point** from Lu et al. — at 6 windows,
2 bad windows are tolerated, 3 are required to flag.

Early checks (4–5 windows) are stricter by design: less data, less tolerance.

### Why 0.50?
Raised from an earlier ~1/3 fraction to reduce false rejections for genuine users who
momentarily type differently, while still catching impostors — see the fraction's own
history in `keystrokeSecurity.js`. (A 2026-09 experiment also swept the packet size
itself to 20; it was measured to help and then reverted — see `paper/AUDIT.md` §4-9b —
so the packet size in production is 6, as above.)

---

## 8. EER Threshold (Per-User)

**EER = Equal Error Rate** — the operating point where FAR = FRR.

Computed during training by scanning thresholds from 0.0 to 1.0:
```
for each threshold:
    FAR = fraction of impostors scored >= threshold  (wrongly accepted)
    FRR = fraction of genuine scored <  threshold  (wrongly rejected)
    pick threshold where |FAR - FRR| is smallest
```

This threshold is **personal** — each user gets their own value based on
their typing variance and the impostors in training.

| User | Threshold | Source |
|---|---|---|
| ali | ~0.94 | Real EER (enough data) |
| new user | 0.65 | Default (insufficient data) |

`MIN_EER_VALIDATION_WINDOWS = 3` — if fewer than 3 genuine windows are in
the validation split, EER is not computed and 0.65 default is used instead.

### PACKET_VOTE_FRACTION never changes
0.50 is hardcoded (see the note at the top of §7 on the 0.34→0.50 history). Only the EER threshold changes on retrain.

---

## 9. Adaptive Retraining

Triggered automatically after **3 qualifying submissions** (score ≥ 90%).

What changes:
- Model weights (CNN/LSTM fine-tuned on new samples)
- EER threshold (recomputed with new genuine/impostor data)

What does NOT change:
- PACKET_VOTE_FRACTION (0.50) — always fixed
- RECENT_WINDOW_COUNT (6) — always fixed
- WINDOW_SIZE (50) — always fixed
- WINDOW_STRIDE (10) — always fixed

---

## 10. FAR / FRR / TAR

| Metric | Meaning | Formula |
|---|---|---|
| **FAR** | Impostor accepted as you | impostors_accepted / total_impostor_attempts |
| **FRR** | You rejected as impostor | your_rejections / your_total_attempts |
| **TAR** | You accepted correctly | 1 − FRR |
| **EER** | Point where FAR = FRR | threshold that minimises \|FAR−FRR\| |

FAR requires explicit cross-user testing: log in as a different account, type on
the Write page, check how often the system accepts the wrong person.

---

## 11. Model Architecture

```
Input: (50, 6) window
  ↓
Conv1D — scans local digraph patterns (e.g. fast "th" pair signature)
  ↓
LSTM 1 — reads the full sequence in order
  ↓
LSTM 2 — deeper temporal context
  ↓
Dense — outputs genuine_score ∈ [0, 1]
```

Conv1D is **frozen** during fine-tuning (preserves general digraph features
learned from 148 users). Only LSTM + Dense adapt to the individual.

---

## 12. Full Decision Flow (One Check Call)

```
1. User types → keystroke events accumulate
2. Every 25 new keystrokes (after 80 chars): /check fires
3. Server extracts ALL windows from current events
4. Takes last 6 (packet)
5. Sends packet to CNN/LSTM model
6. Model returns one score per window
7. Each score compared to user's EER threshold → genuine or bad
8. bad_count / packet_size compared to 0.34
9. If >= 0.34 → Suspicious → passkey challenge
   If <  0.34 → Genuine → session continues
10. windowCount (total, not just packet) sent back to client for UI
```
