# Pre-registration — Experiment D: how much of the accuracy is device rather than behaviour?

Written 2026-09-13, **before any Experiment D code had run on data** and before Experiment C
finished. Its SHA-256 is recorded in every Experiment D result. Protocol items not restated here
are those of `PREREGISTRATION.md`.

## The question

Every representation in Experiment A is built from pixel displacements. Pixel displacement per
event depends on the mouse's DPI, the operating system's pointer acceleration and the screen, not
only on the person. In SapiMouse each participant used their own computer, so the target and its
impostors differ in device as well as in behaviour, and a model can separate them by either.

Continuum's threat model is the opposite: the impostor sits at the victim's machine, with the
victim's mouse and pointer settings. Any accuracy that comes from device scale is therefore
unavailable in deployment, and our SapiMouse numbers would be optimistic by that amount.

Chong et al. measured the analogous effect for their image model: AUC falls from 0.958 to 0.467
when screen-resolution information is withheld at test time (their Table VII). Khan et al.'s survey
reports error rates rising when enrolment and verification happen on different devices.

## Design

One factor, two arms, everything else fixed to the Experiment A/B protocol, the adopted
architecture (B3) and three seeds:

* **D1 = A5**, the adopted representation: (|dx|, |dy|) in pixels. Already measured in
  Experiment B as arm B3; it is re-used, not re-run.
* **D2 = A5 scale-normalised**: each window's two columns are divided by the **median step
  magnitude of the session the window comes from** (a per-session scalar, computed on that
  session's steps only, floored at 1 px). This removes a constant per-device gain while leaving
  the shape and rhythm of the movement untouched.

The normaliser is computed per session, for base users, targets and impostors alike, so no
identity information crosses between people.

## Endpoint and interpretation, fixed in advance

Primary: per-user window-level AUC on the test half, averaged over seeds, paired D2 − D1.

* If D2 is **not significantly lower** than D1 (paired bootstrap over users, two-sided p ≥ 0.05),
  the accuracy does not depend on device scale, and the SapiMouse estimate transfers to the
  same-device threat model in that respect.
* If D2 is **significantly lower**, the difference is an upper bound on how much device scale
  contributes, and every mouse number in this thesis is reported with that caveat attached.

Either outcome is reported. D2 is **not** a candidate for adoption: its purpose is to quantify a
confound, not to win a comparison. If D2 were also non-inferior it would still not displace the
adopted representation, because the adoption rule was settled in `PREREGISTRATION.md`.

## Limits stated in advance

SapiMouse records neither device nor DPI, so this is an indirect test: the normaliser removes a
constant per-session gain, not every device effect (polling rate and acceleration curves survive
it). The result bounds the confound from below, not from above.
