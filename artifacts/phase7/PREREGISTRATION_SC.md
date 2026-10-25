# Pre-registration SC: does the base model help the personal typing model? (23 Oct 2026)

Written and hashed, together with `run_sc.py` and `analyze_sc.py`, before any SC model is trained.

**Owner, 23 Oct 2026:** "ok, no problem". This approves measuring the one typing departure from [1] that was never
compared with the published choice. [1] trains a network for each user. This work fine-tunes a base model trained on
Buffalo, with its convolution frozen.

## Protocol (experiment EC, unchanged)

`run_ec.run_target`, line for line:
- the 99 KeyRecs owners;
- the temporal 70/30 split with five windows dropped on each side;
- the live validation split, the last 20% of the enrolment with five windows dropped;
- negatives from 200 Aalto typists (twice the owner's windows);
- impostors are KeyRecs participants 40 to 79 (their first 150 windows);
- seeds 1000 + owner;
- decisions are step-disjoint blocks of 20 windows scored by their mean (`packet_length_a200.decisions`).

## Arms

- **FT, the deployed design:** the stored EC parts. The base model is loaded, its convolution frozen, and the other
  layers trained with Adam (3e-4), batch 16, up to 30 epochs, early stopping on validation loss with patience 6 and
  the best weights restored.
- **SC, the design of [1]:** the same architecture with fresh weights (`clone_model` of the base, each layer's own
  initializer, seeded by the owner), all layers trainable. The same optimizer, learning rate, batch and data.
  - Up to 100 epochs, with patience 10 and the best weights restored.
  - The larger budget is deliberate: a model that starts from random weights must not lose only because it was
    stopped early.

## Enrolment sizes

- 130 windows (the live five passages);
- all of the enrolment block (about 300 windows, paper Table 4's condition).

## Endpoints

- **Primary:** per-user AUC of 20-window decisions at M = 130, FT minus SC, paired over owners. Bootstrap of 10,000
  resamples, seed 17, 95% interval.
- **Secondary:** the same at M = all.
- **Also reported:** FAR and FRR at the deployed rule (10 of 20 below 0.50), the mean window EER, and the epochs run.

## Reading rule

- **The base helps:** the lower bound of FT minus SC is above 0.
- **No measurable difference:** the interval contains 0. The base is then kept for its shorter training, and reported
  as such.
- **Scratch is better:** the upper bound is below 0. This is reported, and paper Table 2's reason for the departure
  must change.

The rule is read at M = 130 first. M = all is reported either way. Nothing in the live system changes because of SC.
