from tensorflow.keras import layers, models

# The earlier network: no pooling, both recurrent layers return sequences, then Flatten. The old mouse GRU bases
# (train_mouse_base.py, train_mouse_base_id.py), the mouse action sweep, arch_headtohead.py and api.py's
# feature-extractor transfer from those bases were built with it, so they ask for it explicitly.
LEGACY_NETWORK = {"pool_size": 0, "last_state_only": False}


def build_1d_cnn_2rnn(input_shape, num_classes=2, units=16, rnn_type="gru", pool_size=2, last_state_only=True):
    """
    1D CNN + two recurrent layers.

    Default = the deployed typing network (artifacts/ws50-gru-v2, the setting of Lu et al. 2020 that did best on
    Buffalo: kernel 2, pooling 2, GRU 16):
        Conv1D(32, k=2, valid, ReLU) -> MaxPooling1D(2) -> GRU(16, sequences) -> Dropout(0.5)
        -> GRU(16, last state) -> Dropout(0.5) -> Dense(num_classes, softmax)
    At input (50, 6) with 2 classes: (49, 32) -> (24, 32) -> (24, 16) -> (16,) -> (2,), 4,482 weights.

    LEGACY_NETWORK with units=32 gives the earlier variant, (50, 6) -> ... -> Flatten 1568 -> Dense, 16,226 weights.
    """
    rnn = layers.GRU if rnn_type.lower() == "gru" else layers.LSTM
    stack = [layers.Input(shape=input_shape),
             layers.Conv1D(filters=32, kernel_size=2, activation="relu", padding="valid")]
    if pool_size:
        stack.append(layers.MaxPooling1D(pool_size=pool_size))
    stack += [rnn(units=units, return_sequences=True),
              layers.Dropout(0.5),
              rnn(units=units, return_sequences=not last_state_only),
              layers.Dropout(0.5)]
    if not last_state_only:
        stack.append(layers.Flatten())
    stack.append(layers.Dense(num_classes, activation="softmax"))
    return models.Sequential(stack)
