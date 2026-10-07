# CONTAMINATED — do not use, do not quote

This artifact was produced by `services/model-api/train_mouse_base.py`, which
splits windows with a per-window `train_test_split(random_state=13)`.

Mouse windows are cut at **size 50, stride 10**, so two windows closer than 5
apart share raw motion steps and immediate neighbours share **40 of their 50**.
A per-window random split therefore scatters near-identical copies of the same
motion across the train/test boundary.

Measured by **content** (not by index) on 2026-09-02, reproducing that exact
split and comparing windows within each contiguous run:

```
consecutive rows sharing 40/50 steps      : 19979/20001 = 99.9%
train=80693  val=17296  test=17293

test windows sharing >=1 step with train  : 17291/17293 = 99.99%
test windows with an immediate neighbour  : 15696/17293 = 90.77%
```

Its reported `test_top1_accuracy` of **0.5108** in `results.json` is therefore a
measurement of memorisation, not generalisation, and must not appear in the
thesis, the papers or any documentation.

## Use this instead

`artifacts/mouse-ws50-gru/` — produced by `train_mouse_base_id.py`, which is
session-disjoint (train/val from the 3-min session split temporally, test = the
1-min session) with **20 users held out entirely**. Verified: zero identical
windows between train and test. Its honest figure is **top-1 0.4027 on 100-way
identification** against a 1% chance level.

The comparison is conservative — the contaminated model scored higher on a
*harder* 120-way task than the clean model did on 100-way — so roughly 11 points
of the apparent accuracy are contamination.

## Why this file exists

Until 2026-09-03 `services/model-api/api.py` defaulted `MOUSE_BASE_MODEL_PATH`
and `MOUSE_SCALER_PATH` to **this directory**, while every evaluation and
`docs/MOUSE_MODALITY.md` described `mouse-ws50-gru`. Both scalers are
7-dimensional, so the contaminated model loaded silently and never raised an
error. The defaults now point at `mouse-ws50-gru`.

The directory is kept rather than deleted so the leakage measurement above
stays reproducible.
