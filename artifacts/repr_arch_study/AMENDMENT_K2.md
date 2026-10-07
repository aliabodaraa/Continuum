# Amendment K-2 — how many sample orders K2 runs per budget

Written 2026-09-19, **before any K2 code had run on data**. It amends one operational item of
`PREREGISTRATION_K.md` (SHA-256 c602b16b…). Nothing about the arms, endpoints, margins or the selection
rule changes.

## The change

`PREREGISTRATION_K.md` §K2 says the endpoints are "as P3", which included threshold stability measured
over the identity order and two rotations **at every budget**. K2 runs instead:

* **identity order only** at budgets 330, 440 and 550;
* **identity order and two rotations** at the FULL budget (the user's whole 3-minute session).

## Why, decided without any K2 result

As written, K2 needs about 2,230 personal models (roughly 15 hours of computing on this machine, more
than 5 hours even on three workers). The Docker engine on this machine has failed four times during runs
of that length, each time costing a re-run. The reduced plan needs about 1,240 models (under 3 hours on
three workers).

Threshold stability is a property we need at the **candidate** budget, which is what FULL is; the smaller
budgets are already covered by P3, which measured stability over three orders at 330, 440 and 550
(0.029–0.038 mean within-user SD, with no trend across budgets).

## What this costs, stated plainly

At 330, 440 and 550 each user contributes one order instead of the mean of three, so those per-user
values are noisier, though not biased: the order is the session's own chronological order in every case.
The FULL budget, which is the one that can trigger a product change, keeps the full three-order
treatment. The selection rule, its three margins and the K3 confirmation are unchanged.
