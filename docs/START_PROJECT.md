# Start Continuum

Run these commands from PowerShell:

```powershell
cd "C:\Users\aliab\OneDrive\Desktop\Master Thesis\project\continuum"
$env:DOCKER_CONFIG="$PWD\tools\docker-config"
docker compose --profile model up -d web model-api
```

Open:

- Web app: `http://localhost:3000`
- Model API health: `http://localhost:5000/health`
- Typing enrollment: `http://localhost:3000/enroll.html`

Current user flow:

1. Register or log in.
2. Register a passkey on the dashboard.
3. If the backend has poor or missing user rhythm data, the app forces the user to `Train Rhythm`.
4. The website converts keydown/keyup timing into `(50, 6)` windows and trains a per-user CNN/LSTM model through the Python model API.
5. Use the dashboard or opinion page. Suspicious CNN/LSTM rhythm scores require passkey verification.

Per-user CNN/LSTM models are saved under:

```text
artifacts/users/user-<id>/final_model
```

Check containers:

```powershell
docker compose ps -a
```
