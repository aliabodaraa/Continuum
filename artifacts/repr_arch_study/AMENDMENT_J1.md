# Amendment J-1 — the P4 quality gate, and the frozen definition of the two systems for P6

Written 2026-09-18, **after P4 and P5 and before any lockbox data was read**. It amends
`PREREGISTRATION_J.md` (SHA-256 23db222b…) on one point and freezes what P6 compares.

## 1. P4: no quality gate is specified (a disclosed deviation)

The frozen protocol says that if a candidate quality measure survives the Holm-corrected family, "the
gate itself is specified in an amendment before P6 and validated only on the lockbox". One did survive:
**idle splits per 100 steps vs genuine prompts per minute**, mean within-user Spearman +0.51
[+0.15, +0.86], Holm p < 0.001.

No gate is specified, for reasons that do not depend on any lockbox result:

1. The association rests on **5 of 19 users**. At the deployed operating point most users are never
   prompted under any of their ten enrolments, so the correlation is undefined for the other fourteen.
2. The only outcome defined for all nineteen users, per-window AUC, shows **no** association with any
   of the seven candidates (all |rho| <= 0.11, Holm p = 1.000), including this one.
3. A gate cannot be validated on the lockbox as the protocol intends. Each lockbox user contributes a
   single enrolment; a gate can only reject some of them, which changes who is measured rather than
   measuring an improvement.

The association is therefore **reported as exploratory** and re-tested in P8, where real use produces
many prompts per user and the outcome is not degenerate. P5 stands as run: no threshold floor.

## 2. The two systems P6 compares, frozen

| | S0 — deployed today | S1 — the new system |
|---|---|---|
| Base network | base-80 (`artifacts/mouse-fcn-a5-j80`), identical for both | same |
| Enrolment | 330 windows (6 samples of 55) | **440 windows (8 samples of 55)** |
| Training split | model-api's contiguous 20% tail, gap 5 | **leave-one-sample-out (Method B)**: 8 fold models, each scoring the sample it never saw; the deployed model trains on all samples with the last 11 windows of every sample for early stopping (4 purged before each slice) |
| Threshold | 1st percentile of the model's scores on all enrolment windows | **20th percentile of the pooled out-of-sample fold scores** |
| Rule | 30 of the last 60 windows below the threshold | **33 of the last 60** |
| Quality gate | none | none (section 1) |
| Threshold floor | none | none (P5) |

Both are evaluated identically: enrolment from the first E windows of the 3-minute session; genuine =
the whole 1-minute session; impostors = every other lockbox user's first 150 windows (about 40 s), one
run each; decisions at the live cadence (one per 6 new windows), buffer emptied after a prompt.

## 3. What P6 decides

Confirmatory family, Holm over two: genuine prompts per minute (S1 − S0) and impostor runs caught
(S1 − S0), paired bootstrap over the 20 lockbox users, 10,000 resamples, seed 17.

**S1 is declared better** if prompts per minute is not higher by more than 0.1 (upper 95% bound) and
runs caught is not lower by more than 5 points (lower 95% bound), and at least one of the two improves
significantly. Otherwise S0 stands. Per-window AUC, EER and TAR@FAR 1%, detection time and the per-user
tables are reported for both systems either way, including results that go against S1.

The lockbox is scored **once**. Anything found afterwards is reported as a deviation with both the
original and the corrected numbers; S1 is not changed because of what the lockbox shows.

Balabit remains an external report only and is not part of this decision.
