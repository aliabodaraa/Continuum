# Amendment A1 to pre-registration RU: a same-day test now (25 Oct 2026)

Written and hashed before any check of its test period existed. The frozen pre-registration
(PREREGISTRATION_RU.md, sha256 72786bf8f69f12ab22f5013059c12c7a48ffa24eb3269db5820d6764d2080d1d) is unchanged.

Owner, 25 Oct 2026, after the smoke run: "what you planned for tomorrow, let's do it now, so we decide whether to
adopt the feature or roll it back".

## What changes (nothing else does)

- **Test period:** from 2026-10-25 14:35:00 UTC until the owner says he has finished, at the latest 20:59:59 UTC, so it
  never overlaps the frozen next-day test period.
- **Minimum:** 375 non-warm-up checks (10 minutes of movement at one check per 1.6 s), in any number of sittings. Below
  that the verdict is "inconclusive" and A stays.
- **Reading:** the same endpoints G and I, the same validity checks, the same arms. The four real-use samples were
  taken today, so a same-day test favours B.
  - "keep A" here is final for this mix, because B failed under conditions that favour it.
  - "the mix is better" is not enough to switch. The frozen next-day test must confirm it before stage 3 is proposed.
- **While the period runs:** only the number of non-warm-up checks is queried, to know when the minimum is met. Scores
  and verdicts are not looked at.
- **Not part of the test:** the smoke data (before 13:30:38 UTC) and the checks from 13:35:35 to 14:35:00 UTC.
