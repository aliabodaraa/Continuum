# Vendored reference source

`AFE_cnnModel_reference.py` is an unmodified copy of `models/cnnModel.py` from

    https://github.com/norbertFejer/AFE_Project

the repository named by

    M. Antal and N. Fejer, "Mouse dynamics based user recognition using deep
    learning", Acta Universitatis Sapientiae, Informatica 12(1):39-50, 2020.
    doi:10.2478/ausi-2020-0003

The paper states its results "can be replicated with the software available on
GitHub", so this file is the authoritative specification of the architecture --
the paper's prose is less precise than the code in two places:

  * the paper says "we used the sigmoid activation function"; the code applies
    relu to all four Conv1D layers and to Dense(60), and uses sigmoid ONLY on
    the output layer of a 2-class model.
  * the paper says 16 training epochs; `train_model` here sets `nb_epochs = 160`.

It is kept verbatim, and NOT imported at runtime, so that our own
implementation can be diffed against it at any time. The runnable port lives in
`antal2020_sweep.py::build_mcdcnn`, which reproduces this file layer for layer.

## Per-user training follows the code too (`--protocol afe`, the default)

`antal2020_sweep.py::afe_train` reproduces how the repository trains and selects
a per-user model, taken from `models/cnnModel.py`, `models/baseModel.py` and
`src/evaluateModel.py`:

| setting | AFE_Project | ours before (`--protocol legacy`) |
|---|---|---|
| epochs | 160 (`train_model`) | 16 (paper text) |
| loss / labels | `binary_crossentropy` on one-hot, `Dense(2, sigmoid)` | `sparse_categorical_crossentropy` on integer labels |
| validation | `validation_split=0.15, shuffle=False` | none |
| callbacks | `ReduceLROnPlateau(val_loss, 0.5, 15, min_lr=1e-4)`, `ModelCheckpoint(loss, best)`, `EarlyStopping(loss, 0.01, 45)` | none |
| model evaluated | `best_` checkpoint = lowest TRAINING loss | last epoch |
| scaling (SapiMouse sweep) | `STANDARD_SCALER` + `ACTION_BASED` = per-block z-score | global max-abs |

Two properties of their code are reproduced on purpose, not endorsed:

  * the training array is `concatenate(positives, negatives)` and is never
    shuffled before `fit`, so Keras's trailing 15% validation slice contains
    **negatives only**; ReduceLROnPlateau therefore watches a loss with no
    genuine samples in it;
  * `shuffle=False` presents the classes in order within every epoch.

One property is deliberately **not** copied: their identification pre-training
also uses an unshuffled `validation_split`, which on subject-ordered data holds
the last ~15% of subjects out of training altogether. Our pre-training permutes
the data first, so every base subject is trained on.
