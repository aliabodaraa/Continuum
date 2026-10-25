# Results of amendment ALL-IMPOSTORS (25 Oct 2026)

Every typing result re-measured with all 98 other KeyRecs participants as impostors (the KS comparison: participants
40 to 98), per `AMENDMENT_ALL_IMPOSTORS.md` (frozen before any re-run model). Endpoints, reading rules and code are the
original ones; only the impostor pool changed. Before = the published S40 results (participants 40 to 79).

| Result (where reported) | Before (40 to 79) | Now | Source |
| --- | --- | --- | --- |
| Deployed arm A200, 20-window decisions: per-user AUC (abstracts, paper Table 4, conclusions) | 0.969 | 0.965 | `../phase7/im_result.json`, `table4_all.json` |
| same: live-rule FAR / FRR / pooled EER | 11.9% / 3.3% / 7.8% | 13.0% / 3.3% / 8.3% | `table4_all.json` |
| Packet 6: FAR / FRR / EER / AUC | 12.4% / 10.1% / 11.0% / 0.952 | 13.3% / 10.1% / 11.4% / 0.947 | `table4_all.json` |
| Packet 10 | 12.6% / 6.2% / 9.5% / 0.958 | 13.4% / 6.2% / 10.1% / 0.954 | `table4_all.json` |
| TAR at FAR 1% (thesis Table 10), packets 6 / 10 / 20 | 31.1% / 32.2% / 41.1% | 27.4% / 28.8% / 34.1% | `table4_all.json` |
| Single-window mean EER (paper 4-2) | 12.9% | 13.3% | `table4_all.json` |
| Lu's rule vs adopted rule (paper Table 2): FAR | 5.0% vs 11.9% | 5.6% vs 13.0% (FRR 22.5% vs 3.3%) | `lu_vote_rule_all.json` |
| Random vs temporal split, mean window EER (paper 4-1) | 12.0% vs 12.9% (-0.9) | 12.3% vs 13.3% (-1.1 [-1.8, -0.3]) | `phase6/leaky_result.json` |
| EC enrolment curve, per-user AUC at 12/26/52/78/130/208/all windows | 0.570/0.737/0.851/0.873/0.916/0.938/0.965 | 0.552/0.724/0.849/0.871/0.911/0.931/0.959 | `phase7/ec_result.json` |
| SC transfer vs scratch, 130 windows (FT vs SC, FT - SC) | 0.916 vs 0.914, +0.002 [-0.015, +0.017], 41/99 | 0.911 vs 0.912, -0.002 [-0.018, +0.014], 42/99 | `phase7/sc_result.json` |
| SC, all typing | 0.965 vs 0.971, -0.006 [-0.020, +0.005], 41/99 | 0.959 vs 0.967, -0.009 [-0.022, +0.003], 40/99 | `phase7/sc_result.json` |
| AR2 primary, B - A (default rule) | +0.0009 [+0.0001, +0.0018], improves | +0.0008 [-0.00003, +0.0018], no detectable difference | `phase5/ar2_result.json` |
| AR2 A (no retraining) / B (default) AUC | 0.9186 / 0.9195 | 0.9131 / 0.9139 | `phase5/ar2_result.json` |
| AR2 impostor stretches accepted (S1 end / any) | 1.75% / 3.53% | 2.09% / 3.46% | `phase5/ar2_result.json` |
| AR2 forced poisoning (most similar impostor) | 84.8% to 93.9% | 87.7% to 95.4% | `phase5/ar2_result.json` |
| KS A1000 - REF (primary), impostors 40 to 98 | +0.020 [+0.010, +0.031], 62/99 | +0.012 [+0.002, +0.022], 61/99 | `ks/ks_result.json` |
| KS A200 - REF | +0.027 [+0.017, +0.039] | +0.021 [+0.011, +0.031], 70/99 | `ks/ks_result.json` |
| KS A1000 - A40 (key secondary) | -0.005 | -0.008 | `ks/ks_result.json` |

Readings: every pre-registered conclusion holds except the AR2 primary, which moves from "improves" (by a negligible
0.0009) to "no detectable difference" (0.0008, interval touching zero). FRR values do not depend on the impostors and
are unchanged everywhere. In KS the per-user scatter is 70 better / 25 worse / 4 equal (was 69 / 24 / 6).

Documents updated and installed on 25 Oct 2026 (paper, Arabic copy, thesis; 14 / 14 / 56 pages): abstracts, 3-2
(EC, SC), Table 2 (vote row), 3-6 and Figure 6 (impostors), 4-1, 4-2 and Table 4, 4-3, conclusions; thesis 3-5 (EC),
3-12 (protocol, Table 5 roles, Figure keyrecs_split), 4-1, 4-2 (Table 9, its text, the per-user figure, SC paragraph,
Table 10), 4-3 (AR2 table and text), 4-7, conclusions.
