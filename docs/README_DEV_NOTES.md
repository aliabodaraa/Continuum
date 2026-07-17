Developer notes / next tasks

- Inspect the Continuum HDF layout and update `data_loader.py` to map correct keys to `features` and `labels`.
- Tune the model architecture in `model.py` to match Lu et al. (2020) more closely (filters, kernel sizes, LSTM layers).
- Add unit tests for the data loader with a small synthetic HDF file.
- Add a Flask `api.py` to expose `/predict` endpoint for inference once model is trained.
