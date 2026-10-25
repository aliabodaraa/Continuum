# Pre-registration PR: asking for the passkey only when the mouse suspicion persists (23 Oct 2026)

Written and hashed before any PR code ran.

**Owner, 22-23 Oct 2026:** "why would the passkey appear as long as he is the real user?", then "apply" to measuring a
rule that asks only when the suspicion persists. The live mouse channel asks at the first suspicious check
(MOUSE_STRIKES_TO_LOCK = 1). On paper Table 6's system that is 0.37 genuine requests per minute of movement.

## System (paper Table 6, experiment FS, unchanged)

- **Model:** the base-80 network trained with SapiMouse's settings, the F2 head, and 440 enrolment windows.
- **Threshold:** the 20th percentile of the leave-one-sample-out scores.
- **Users:** the 19 development targets.
- **Check:** every 6 windows, on the last 60 windows. A check is suspicious when 33 or more of them are low.
- **Buffer:** emptied after a request.
- **Genuine:** the whole 1-minute session.
- **Impostors:** the whole 1-minute session of every other development user, instead of its first 150 windows, so that
  slower rules have room to fire. With runs cut at 150 windows, rule A1 must reproduce Table 6's live loop
  (`fs_paper_numbers.json`: 0.37 requests per minute, 97.0% of runs caught).

## Rules

- **A_S:** request when S consecutive checks are suspicious, for S = 1, 2, 3, 4, 6, 8 and 11. This is the live
  streak.
  - A check before the buffer holds 60 windows gives no verdict and leaves the count unchanged.
  - A non-suspicious check resets the count.
  - A_1 is the deployed rule, and S = 11 means the suspicion lasts one full refresh of the buffer (about 17 s).
- **B_S:** request when S independent decisions in a row are suspicious, for S = 2 and 3.
  - After a suspicious decision the buffer is emptied without a request.
  - The next decision is made when 60 new windows have arrived.
  - A non-suspicious decision resets the count, and checking then continues every 6 windows.

## Endpoints (per user)

1. Genuine requests per minute of movement.
2. Share of impostor sessions caught.
3. Mean time to catch, in seconds of impostor movement.

## Reading rule

- **Comparison:** each rule against A_1, as a paired bootstrap over the 19 users. 10,000 resamples, seed 17, 95%
  interval.
- **Acceptable:** a rule whose sessions-caught lower bound against A_1 is at least -5 points.
- **Recommended:** among the acceptable rules, the one with the fewest genuine requests per minute. A tie is broken by
  the shorter time to catch. The time to catch is reported for every rule, as the price of waiting.

Nothing in the live system changes without the owner's decision. A_S can be set through the existing strike setting,
and B_S would need a code change.
