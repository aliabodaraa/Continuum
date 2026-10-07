# Amendment 1 to the pre-registration — Experiment B architecture specifications

Written 2026-09-12, **after the original pre-registration and before any Experiment B job was
started**. No Experiment B result existed when this was written. The original
`PREREGISTRATION.md` is left unchanged (Experiment A runs under its hash); Experiment B results
record the SHA-256 of both files, and the analysis verifies both.

## Why

Three Experiment B specifications attributed to Chong et al. [16] had been read from figure text
that PDF-to-Markdown conversion had garbled. The original PDF (IEEE TIFS 15:1086–1101), supplied
after the pre-registration was written, shows different specifications (Section IV, Figs. 1, 3, 4, 5).
Following the paper rather than a corrupted copy of it is the purpose of the study, so the three
arms are corrected before they run.

## Changes

| Arm | Original pre-registration | Corrected, per the paper |
|---|---|---|
| B4 Chong LSTM | 3 × LSTM60, dropout 0.2 | **2 × LSTM10**, dropout 0.3 between them; head on the last hidden state (Sec. IV-C, Fig. 3: "two layers … hidden state … set to 10 … dropout probability of p = 0.3") |
| B8 Chong 1D-CNN | two independent towers (20→60), flattened | first layer **Conv(20,k10,s3)** and **Conv(20,k15,s3)**, ELU; second layer **one Conv(60,k10,s2) with shared weights** applied to both; **global max-pooling** of each; concatenate; dropout 0.3; head (Sec. IV-A, Fig. 1) |
| **B9 Chong CNN-LSTM variant 1 (new)** | excluded as unrunnable | first layer Conv(20,k10,s3) and Conv(20,k15,s3), ELU; second layer **one 3-layer stacked LSTM60 (dropout 0.2) with shared weights** applied to both; last hidden states concatenated; dropout 0.2; head (Sec. IV-D, Fig. 4). Variant 1 is the one the paper selects and reports. On a 50-step window the branches give 14 and 12 steps, so it runs unmodified |

Chong's CNN-LSTM **variant 2** stays excluded: its two stacked strided convolutions (k10 s3, then
k15 s3) reduce a 50-step window to 14 and then to 0 steps.

Personalisation freezes the first learned layer of each branch, as the original rule states:
B4 freezes its first LSTM; B8 and B9 freeze both first-layer convolutions.

Decision rule B is unchanged in form. With nine architectures the Holm families have 8
comparisons each, and B9 counts as mouse-published for the tie-break.

## Also recorded, not changed

* **Image-based 2D-CNNs are not an Experiment B arm** (Chong's GoogLeNet 2D-CNN; Matthiesen et
  al.'s AlexNet on trajectory images). They consume rendered images, not per-step sequences, so
  they belong to a different representation class. Chong's own Table VII also shows their 2D-CNN
  falling from AUC 0.958 to 0.467 on Balabit when screen-resolution information is removed at test
  time. Under Continuum's threat model the impostor uses the victim's screen, so that information
  cannot identify anyone. The model is also 5.8 M parameters, which is heavy for in-browser use.
* **Tao et al. (2026), sLSTM-MixConv + isolation forest, is not an arm.** Every page of the
  available copy states "This preprint research paper has not been peer reviewed" (SSRN 6193851),
  and the study admits only peer-reviewed sources as design references.
* **Experiment A is unaffected** by this amendment. One deviation in A6 (Chong absolute position)
  is recorded: Chong centres the shorter screen axis after scaling
  ([0,1]×[0,α] + padding/2). A6 scales both axes by the same factor but omits that per-session
  centring offset. A6 is reported only and is ineligible for adoption, so no decision depends on it.
