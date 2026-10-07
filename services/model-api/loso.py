"""Leave-one-sample-out enrolment plans for the live mouse channel (S1 of AMENDMENT_J1.md §2).

S1 enrols 8 samples of 55 windows. Eight fold models each train on the other 7 samples and score
the sample they never saw; the pooled out-of-sample scores set the user's threshold. The deployed
model trains on all 8 samples. In every model, early stopping uses the last VSLICE windows of each
training sample and the PURGE windows before each slice are dropped (they share steps with it);
windows within PURGE of a held-out sample are dropped from both sets.

`sample_idx`, `purge` and `plan_folds` are copied verbatim from protocol_j_p1.py, the code the
lockbox evaluated (protocol_j_p6.py imports them from there). They are copied rather than imported
so the model-api does not load the study's modules at serve time. validate_loso.py checks that the
copies return identical plans and that the whole recipe reproduces the stored P1 scores.
"""
import numpy as np

SAMPLE, PURGE, VSLICE = 55, 4, 11


def sample_idx(s):
    return list(range(SAMPLE * s, SAMPLE * s + SAMPLE))


def purge(idx, held):
    """Drop windows within PURGE (time) of any held-out window."""
    if not held:
        return list(idx)
    h = np.asarray(sorted(held))
    out = []
    for t in idx:
        j = np.searchsorted(h, t)
        near = (j < len(h) and h[j] - t <= PURGE) or (j > 0 and t - h[j - 1] <= PURGE)
        if not near:
            out.append(t)
    return out


def plan_folds(order, held_samples):
    """Training samples in the given order; last VSLICE windows of each validate, the PURGE before it
    are dropped; anything within PURGE of the held-out windows is dropped from both sets."""
    held = [t for s in held_samples for t in sample_idx(s)]
    ordered, train, val = [], [], []
    for s in order:
        if s in held_samples:
            continue
        idx = sample_idx(s)
        ordered += idx
        val += idx[-VSLICE:]
        train += idx[:-(VSLICE + PURGE)]
    return ordered, purge(train, set(held)), purge(val, set(held)), held
