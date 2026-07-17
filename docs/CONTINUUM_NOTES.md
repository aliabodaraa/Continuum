Continuum Implementation Notes

Based on: Capstone Project "Behavioral Biometrics for User Identification" by Elkoby & Gutchin (2022)

Model Selection
The Continuum project evaluated three architectures:

1. 1D CNN + 1LSTM — Accuracy: 98.29% (window 50), F1: 0.9864
2. 2LSTM (pure LSTM) — Accuracy: 92.77% (window 40), F1: 0.9167
3. 1D CNN + 2LSTM ⭐ — Accuracy: 99.57% (window 50), F1: 0.9957 [SELECTED]

We implement the best-performing **1D CNN + 2LSTM** architecture.

Model Architecture (model.py)

```
Input: (window_size, num_features) e.g., (30, 3)
  ↓
Conv1D: 32 filters, kernel_size=2, padding='valid', activation='relu'
  ↓
LSTM: 32 units, return_sequences=True
  ↓
Dropout: 0.5
  ↓
LSTM: 32 units, return_sequences=False
  ↓
Dropout: 0.5
  ↓
Flatten
  ↓
Dense: 2 units, activation='softmax' (genuine / intruder)
```

Feature Extraction (data_loader.py)
Continuum uses three keystroke timing features per key:

1. **Dwell Time (Hold Time)**: Duration key is pressed (keydown to keyup)
2. **Down-Down Time (DD)**: Time between pressing key1 and pressing key2
3. **Up-Down Time (UD)**: Time between releasing key1 and pressing key2

Features are normalized and vectorized into sliding windows.

Window Sizes and Performance
Continuum tested window sizes 20, 30, 40, 50:

- Window 20: 89.60% accuracy, F1: 0.8602
- Window 30: 94.10% accuracy, F1: 0.9428 ← Good balance
- Window 40: 96.97% accuracy, F1: 0.9677
- Window 50: 99.57% accuracy, F1: 0.9957 ← Best (but slower real-time)

Default: window_size=30 (balance between accuracy and latency for continuous authentication)

Evaluation Metrics
Continuum used:

- **Accuracy**: Overall correct classifications
- **F1 Score**: Harmonic mean of precision and recall
- **ROC-AUC**: Area under ROC curve (binary classifier)
- **FAR**: False Acceptance Rate (intruder accepted)
- **FRR**: False Rejection Rate (genuine user rejected)
- **EER**: Equal Error Rate (FAR = FRR threshold)

System Test Results
In continuous authentication simulation (3 intruders, 1 genuine user):

- FRR: 1.094% (genuine users incorrectly rejected)
- FAR: 19.104% (intruders incorrectly accepted)
- EER: 8.274%

Training Parameters
Continuum used:

- Optimizer: Adam
- Learning rate: adaptive (with decay)
- Epochs: 150
- Batch size: 32-64
- Loss function: sparse_categorical_crossentropy
- Early stopping: patience 10-15 epochs

Our defaults:

- Epochs: 150
- Batch size: 64
- Learning rate: Adam default (0.001)
- Early stopping: patience 15 epochs

Data Preparation
Continuum preprocessing:

1. Loaded keystroke data from Buffalo dataset (148 users, 3 sessions)
2. Extracted features (dwell, DD, UD) per keystroke
3. Applied sliding window (window_size: 20-50)
4. Balanced dataset: 1:1 ratio of target user to other users
5. Normalized key IDs by dividing by 254

For our application:

- Collect keystroke timings from dashboard textarea
- Extract dwell, DD, UD features
- Create sliding windows (default size 30)
- Train per-user or multi-user binary classifiers

Continuous Authentication Flow

1. User logs in with password
2. As user types in dashboard textarea, keystroke events captured
3. Every N characters (sliding window), extract features
4. Feed window to trained model
5. Model outputs probability of being legitimate user
6. If probability < threshold (e.g., 0.5), flag as suspicious
7. Trigger WebAuthn passkey verification if suspicious detected

Next Steps for Training

1. Collect keystroke samples from your users (50+ submissions each)
2. Export/prepare data into HDF5 format with 'X' (features) and 'y' (labels)
3. Place HDF files in continuum/data/
4. Run: python train.py --data-dir data/ --epochs 150
5. Model checkpoint saved to artifacts/best_model.h5
6. Results (accuracy, F1, FAR/FRR) saved to artifacts/results.json

References

- Elkoby, R., & Gutchin, D. (2022). Behavioral Biometrics for User Identification [Capstone Project].
- Lu, X., Zhang, S., Hui, P., & Liò, P. (2020). Continuous authentication by free-text keystroke based on CNN and RNN. Computers & Security, 96, 101861.
