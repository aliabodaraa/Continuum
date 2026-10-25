# Why the owner's mouse channel asks for the passkey so often (22 Oct 2026)

The owner turns mouse protection off because of false passkey requests, and asked whether the cause is the approach or
the enrolment page (dots appear and the user clicks the circle). Script: `services/model-api/analysis/phase7/owner_mouse_diagnosis.py`.
Input: read-only exports of the owner's own rows from the live ca database (user 739935229538144). The raw exports
stay outside the repository. Only the numbers below are kept.

## 1. Real use against enrolment, current profile (trained 2026-10-05, 440 windows, threshold 0.316)

| | Enrolment (leave-one-sample-out scores) | Real use (live checks since then) |
|:--|:--:|:--:|
| 20th percentile of window scores | 0.316 (this is the threshold) | 0.235 |
| Median window score | 0.687 | 0.480 |
| Windows below the threshold | 20% (by construction) | 29.9% |

- **Checks:** 1,159, of which 16 were suspicious.
- **Requests:** 0.52 per minute of mouse movement, which is about one every two minutes of moving. On SapiMouse the same
  rule gives 0.48 per minute, so the channel behaves for the owner as it was measured.
- **Real use scores lower than enrolment:** the median falls from 0.69 to 0.48, and the share of windows below the
  threshold rises from 20% to 30%.

## 2. The enrolment page's movement against SapiMouse's

| Step statistics | Owner's enrolment (the 8 samples in the profile) | SapiMouse, 3-minute sessions | SapiMouse, 1-minute sessions |
|:--|:--:|:--:|:--:|
| Median step | 12.8 px | 7.2 px | 6.7 px |
| 90th percentile step | 55.7 px | 50.0 px | 47.0 px |
| Steps over 50 px | 11.7% | 10.0% | 9.1% |
| Zero steps | 0.7% | 6.1% | 6.1% |
| Median window path | 933 px | 835 px | 790 px |

The current enrolment page produces movement of SapiMouse's scale. The older note ("1.6% of steps over 50 px against
SapiMouse's 9.5%") no longer holds for these samples. Live windows are not stored (only their scores), so the owner's
real-use movement cannot be compared directly.

## 3. The owner among the 19 SapiMouse development users

- **Median leave-one-sample-out score:** 0.687. Seven of the 19 users have a higher median, so he sits mid-range.
- **20th percentile:** 0.316. Fourteen users have a higher one, so his own enrolment has a heavier low tail, but he is
  not an outlier.

## Reading

1. **The approach works for him as measured.** He gets about 0.5 false requests per minute of movement, which is what
   the lab measured. That rate is high in practice: one request every two minutes of active mouse use.
2. **The enrolment page is not the main cause.** Its movement resembles SapiMouse's.
3. **The task changes between enrolment and real use.** Clicking circles is not browsing, and his real-use windows
   score lower than his enrolment windows. That pushes about 30% of them below a threshold that was set for 20%.

## Options (for the owner, nothing changed)

1. **Enrol from real use.** Add mouse samples during ordinary browsing (the SDK panel already lets a user add samples,
   and the profile keeps the newest eight), so the profile learns the movement it will be checked on.
2. **Ask less often.** For example two consecutive suspicious checks before a request, or a lower threshold percentile.
   Each costs some impostor detection, which can be measured on the stored SapiMouse scores before any change.
3. **Use the mouse only as a supporting signal.** A mouse alarm alone would not ask for the passkey, but would make the
   typing check stricter for a while.
4. **The SapiMouse-trained network** lowers the lab rate from 0.48 to 0.37 requests per minute, a reduction of about a
   quarter.

## Decision and deployment (22 Oct 2026)

The owner chose to try option 4 first and to change nothing else if it improves. The network was deployed on
2026-10-22 at 06:51 UTC and his profile was retrained from the same stored samples:

| | Before | After |
|:--|:--:|:--:|
| Threshold (20th percentile, leave-one-sample-out) | 0.316 | 0.303 |
| Median leave-one-sample-out score | 0.687 | 0.711 |
| Requests per minute of movement | 0.52 (measured, 1,159 checks) | to be measured after a few days of use |

To measure it, run the script above on a new export with `--trained "2026-10-22 06:51:10"` and
`--loso '{"10":0.181,"20":0.303,"50":0.711}'`.

## Correction (24 Oct 2026): two copies inflated the enrolment scores

Found while planning learning from real use. Two of the 8 samples in the profile were near-copies of two others: 35 is
34 recorded 109 steps later (81% of their 20-step runs shared) and 37 is 36 recorded 11 steps later (98%). They were
saved 1 and 2 s apart on 2026-09-19. Every other pair of the owner's samples shares no run. In leave-one-sample-out each
copy had its twin in training, so 4 of the 8 samples scored too high, and so did the threshold.

| | With the copies (as in section 1) | Without them |
|:--|:--:|:--:|
| Threshold, old network (20th percentile, leave-one-sample-out) | 0.316 | 0.274 |
| Median leave-one-sample-out score, old network | 0.687 | 0.572 |
| His 1,159 live checks: windows below the threshold | 29.9% | 24.6% |
| His 1,159 live checks: suspicious checks | 16 (0.52 per minute) | 5 (about 0.16 per minute) |
| Threshold, network deployed 2026-10-22 | 0.303 | 0.262 |

Method: `api.train_user_f2_payload` reproduced offline on the 2026-10-22 export (it matched both live thresholds to
1e-9). The two live-check rows are approximate: removing two samples also changes the head a little, and the live
windows themselves are not stored, so their scores could not be recomputed.

**What this changes in the reading.** Reading 3 overstated the gap between enrolment and real use. Without the copies
the enrolment median is 0.57, against 0.48 in real use (not 0.69), and about 25% of live windows fall below a
threshold set for 20% (not 30%). A smaller real-use gap remains. Readings 1 and 2 stand.

**Cause and fix.** Reproduced in headless Chrome against the deployed SDK: two sample flows at once ("+ train" pressed
twice) recorded the same movement and both saved it. Since 2026-10-24 the SDK runs one recorder at a time, and
ca-service refuses a sample that shares more than 5% of its 20-step runs with a stored one. Checked on SapiMouse (80
base users, 1,214 samples): independent samples share none, and the pieces either side of a cut in one recording share
at most 3.7%. The older sample of each pair was removed and the profile rebuilt on 2026-10-24 at 15:08 UTC: threshold
0.26208, leave-one-sample-out p10 0.153, p20 0.262, p50 0.585. The live rate on this profile is still to be measured:
`--trained "2026-10-24 15:08:29"` and `--loso '{"10":0.153,"20":0.262,"50":0.585}'`. There were no mouse checks after
2026-10-19, so the 2026-10-22 profile was never measured live.
