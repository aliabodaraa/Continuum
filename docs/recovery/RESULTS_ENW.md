# Windows against blocks with both networks trained as SapiMouse trains them (22 Oct 2026)

**Why.** The deployed mouse network now uses SapiMouse's training settings. Paper 4-4's windows-versus-blocks comparison
set a window network trained with this work's earlier settings against a block network trained with SapiMouse's. The
owner asked for a re-run ("re-run it, we want to check and audit the mouse approach").

**Setup.**
- Script: `services/model-api/analysis/phase7/e_native_windows.py`. Result: `artifacts/phase7/e_native_w_result.json`
  and `.txt`.
- The block arms are those of `analysis/phase6/e_native_blocks.py`, which were already trained with SapiMouse's
  settings.
- Everything else is experiment E's protocol: the same 100 base users, 20 targets, seeds, enrolment session and test
  session.
- The reading rule was fixed in the script before any result existed.

## Result (20 users, 3 seeds, per-user AUC averaged over the five matched lengths)

| Arm | AUC | EER at the longest length |
|:--|:--:|:--:|
| Blocks, one-class SVM | 0.915 | 9.9% |
| Windows, one-class SVM | 0.892 | 15.0% |
| Blocks, binary head | 0.918 | 10.3% |
| Windows, binary head | 0.949 | 6.1% |

The differences below are windows minus blocks, or SapiMouse's settings minus the earlier settings, with a paired
bootstrap over the 20 users.

- **Primary (one-class SVM), windows minus blocks:** -0.0228 [-0.0515, +0.0073], p 0.13. This is a tie under the fixed
  rule.
- **Secondary (binary head, the comparison in paper 4-4), windows minus blocks:** +0.0312 [+0.0012, +0.0679], p 0.04.
  Windows were higher for 14 of 20 people.
- **SapiMouse's settings minus the earlier settings, on the windows:**
  - one-class SVM: -0.0077 [-0.0143, -0.0014], p 0.02;
  - binary head: -0.0035 [-0.0100, +0.0019], p 0.23.
- **Window networks:** they kept their weights at epochs 24, 18 and 26 of 100, with validation top-1 of 0.43, 0.42 and
  0.43.

## Reading

Paper 4-4's conclusion holds when both segmentations are trained the same way:
- With a classifier that learns from other people's movement, windows beat blocks, 0.95 against 0.92. The deployed head
  is of this kind.
- With the one-class SVM, the two tie.

The deployed segmentation stays.

**What changed in the documents:**
- The paper and its Arabic copy now say "higher for 14 of 20 people". The old 16 came from the mixed-settings
  comparison.
- Thesis Table 11 now says both networks were trained as in [2], and gives 0.91 against 0.89 for the one-class SVM (was
  0.90).
