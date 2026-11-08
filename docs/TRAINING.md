# Continuum Training Workflow

## Dataset

The baseline dataset is the public Continuum/Buffalo HDF dataset from:

`https://github.com/raf545/BioKey---Keystroke-dynamics-for-user-authentication`

Local HDF files are stored in `data/`:

- `Rand_WS20.h5`
- `Rand_WS30.h5`
- `Rand_WS40.h5`
- `Rand_WS50.h5`

The thesis baseline should start with `WS50`, because the reviewed Continuum paper reports its strongest validation result with window size 50. `WS30` is useful later as a lower-latency comparison.

## Docker Environment

Docker is the preferred environment for this project on Windows because it avoids Python 3.13 compatibility issues with TensorFlow and HDF5.

Run the web app container:

```powershell
docker compose up -d web
```

This starts the Node app at `http://localhost:3000`. The first run installs Linux Node dependencies into the Docker volume, so it can take several minutes.

Inspect the dataset inside Python 3.11:

```powershell
docker compose --profile model run --rm model-api python inspect_dataset.py --data-dir data
```

Train the baseline model:

```powershell
docker compose --profile training run --rm trainer
```

It trains the served network (max pooling 2, GRU 16) into `artifacts/ws50-gru-v2-rebuild`; the served base
`artifacts/ws50-gru-v2` is never overwritten.

Run the full web app plus model API:

```powershell
docker compose --profile model up
```

By default, Docker Compose loads the served base `artifacts/ws50-gru-v2/final_model`. To try another base, set `MODEL_PATH` before starting Docker Compose:

```powershell
$env:MODEL_PATH="/app/artifacts/ws50-gru-v2-rebuild/final_model"
docker compose --profile model up
```

Then open:

- Web app: `http://localhost:3000`
- Model health: `http://localhost:5000/health`

## Local Python Environment

Use Python 3.10 or 3.11. Python 3.13 is not suitable for this project because the Windows ML stack does not provide compatible `h5py`/TensorFlow wheels.

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\python -m pip install --upgrade pip
.\.venv\Scripts\python -m pip install -r requirements.txt
```

## Inspect Data

```powershell
.\.venv\Scripts\python inspect_dataset.py --data-dir data
```

## Train Baseline

```powershell
.\.venv\Scripts\python train.py --data-dir data --window-size 50 --epochs 150 --batch-size 64 --output-dir artifacts\ws50-gru-v2-rebuild
```

The defaults build the served network (`--units 16 --pool-size 2`); `--legacy-network --units 32` builds the earlier one
(no pooling, both GRU layers return sequences, then Flatten).

The training output writes:

- `artifacts/ws50-gru-v2-rebuild/best_model.h5`
- `artifacts/ws50-gru-v2-rebuild/final_model/`
- `artifacts/ws50-gru-v2-rebuild/results.json`
- `artifacts/ws50-gru-v2-rebuild/scaler.json`

`results.json` includes accuracy, F1, ROC-AUC, FAR, FRR, EER, and the training history.

## Web App Integration Plan

1. Train and evaluate the public baseline model offline.
2. Keep collecting each authenticated user's keystroke samples in the web app.
3. Build each user's profile from their own samples.
4. Trigger passkey verification when the user's typing rhythm does not match their profile.
5. Use the public baseline model for thesis comparison and the per-user profile/model for runtime security.
