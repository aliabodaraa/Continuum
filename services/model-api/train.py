import argparse
import os
import json
import numpy as np
from sklearn.metrics import accuracy_score, roc_auc_score, f1_score, precision_score, recall_score
from tensorflow.keras.callbacks import ModelCheckpoint, EarlyStopping, ReduceLROnPlateau
from model import build_1d_cnn_2rnn, LEGACY_NETWORK
from data_loader import collect_dataset, make_train_val_test
from preprocessing import FeatureScaler


def calculate_far_frr_eer(y_true, genuine_scores):
    thresholds = np.linspace(0, 1, 1001)
    values = []

    for threshold in thresholds:
        y_pred = (genuine_scores >= threshold).astype(int)
        false_accepts = np.sum((y_true == 0) & (y_pred == 1))
        true_intruders = np.sum(y_true == 0)
        false_rejects = np.sum((y_true == 1) & (y_pred == 0))
        true_genuine = np.sum(y_true == 1)

        far = false_accepts / true_intruders if true_intruders else 0
        frr = false_rejects / true_genuine if true_genuine else 0
        values.append((threshold, far, frr, abs(far - frr)))

    eer_threshold, far_at_eer, frr_at_eer, _ = min(values, key=lambda item: item[3])
    return {
        'eer': float((far_at_eer + frr_at_eer) / 2),
        'eer_threshold': float(eer_threshold),
        'far_at_eer': float(far_at_eer),
        'frr_at_eer': float(frr_at_eer),
        'far_at_0_5': float(next(far for threshold, far, _, _ in values if threshold >= 0.5)),
        'frr_at_0_5': float(next(frr for threshold, _, frr, _ in values if threshold >= 0.5)),
    }


def calculate_metrics(y_true, y_pred_proba):
    """Calculate authentication metrics: FAR, FRR, EER."""
    y_pred = np.argmax(y_pred_proba, axis=1)
    scores = y_pred_proba[:, 1]  # Probability of class 1 (genuine)
    
    metrics = {
        'accuracy': float(accuracy_score(y_true, y_pred)),
        # Precision = TP/(TP+FP); Recall = TP/(TP+FN) (= 1 - FRR on the genuine
        # class); F1 = harmonic mean of the two. zero_division=0 guards tiny sets.
        'precision': float(precision_score(y_true, y_pred, zero_division=0)),
        'recall': float(recall_score(y_true, y_pred, zero_division=0)),
        'f1': float(f1_score(y_true, y_pred)),
    }
    
    try:
        metrics['roc_auc'] = float(roc_auc_score(y_true, scores))
    except Exception:
        metrics['roc_auc'] = None

    metrics.update(calculate_far_frr_eer(y_true, scores))
    
    return metrics


def main(args):
    # Load dataset
    print('[1/5] Loading dataset...')
    X, y, groups = collect_dataset(args.data_dir, window_size=args.window_size, return_groups=True)

    # Prepare data shapes
    if X.ndim == 2:
        X = np.expand_dims(X, -1)

    print(f'Input shape: {X.shape}')
    print(f'Label distribution: {np.bincount(y)}')

    # Split data (group-aware: overlapping windows never cross splits).
    # If the dataset supplied explicit groups (e.g. per-user for mouse), use
    # them; otherwise fall back to the overlap-subsequence grouping.
    print('[2/5] Splitting data (leak-free group-aware split)...')
    X_train, X_val, X_test, y_train, y_val, y_test = make_train_val_test(X, y, groups=groups)
    print(f'Train: {X_train.shape}, Val: {X_val.shape}, Test: {X_test.shape}')

    # Standardize features (fit on train only, as in Lu et al. 2020)
    os.makedirs(args.output_dir, exist_ok=True)
    scaler = FeatureScaler.fit(X_train)
    X_train = scaler.transform(X_train)
    X_val = scaler.transform(X_val)
    X_test = scaler.transform(X_test)
    scaler_path = os.path.join(args.output_dir, 'scaler.json')
    scaler.save(scaler_path)
    print(f'Feature scaler saved to: {scaler_path}')
    
    # Build model
    print(f'[3/5] Building 1D CNN + 2{args.rnn_type.upper()} model...')
    input_shape = X_train.shape[1:]
    num_classes = len(np.unique(y))
    network = LEGACY_NETWORK if args.legacy_network else {"pool_size": args.pool_size}
    model = build_1d_cnn_2rnn(input_shape, num_classes=num_classes, units=args.units, rnn_type=args.rnn_type, **network)
    
    model.compile(
        optimizer='adam',
        loss='sparse_categorical_crossentropy',
        metrics=['accuracy']
    )
    
    print(model.summary())
    
    # Setup callbacks
    ckpt_path = os.path.join(args.output_dir, 'best_model.h5')
    callbacks = [
        ModelCheckpoint(ckpt_path, save_best_only=True, monitor='val_loss', verbose=1),
        EarlyStopping(patience=20, monitor='val_loss', restore_best_weights=True, verbose=1),
        ReduceLROnPlateau(monitor='val_loss', factor=0.5, patience=6, min_lr=1e-5, verbose=1),
    ]
    
    # Train
    print('[4/5] Training model...')
    history = model.fit(
        X_train, y_train,
        validation_data=(X_val, y_val),
        epochs=args.epochs,
        batch_size=args.batch_size,
        callbacks=callbacks,
        verbose=1
    )
    
    # Evaluate
    print('[5/5] Evaluating on test set...')
    test_loss, test_acc = model.evaluate(X_test, y_test, verbose=0)
    
    y_pred_proba = model.predict(X_test)
    test_metrics = calculate_metrics(y_test, y_pred_proba)
    
    # Save results
    results = {
        'model': f'1D CNN + 2{args.rnn_type.upper()}',
        'window_size': input_shape[0],
        'num_features': input_shape[1] if len(input_shape) > 1 else 1,
        'test_loss': float(test_loss),
        'test_accuracy': float(test_acc),
        'test_metrics': test_metrics,
        'training_epochs': len(history.history['loss']),
        'history': {key: [float(value) for value in values] for key, values in history.history.items()},
        'dataset_size': len(X),
        'train_size': len(X_train),
        'val_size': len(X_val),
        'test_size': len(X_test),
    }
    
    results_path = os.path.join(args.output_dir, 'results.json')
    with open(results_path, 'w') as f:
        json.dump(results, f, indent=2)
    
    print('\n' + '='*50)
    print('RESULTS')
    print('='*50)
    print(f'Test Loss: {test_loss:.4f}')
    print(f'Test Accuracy: {test_acc:.4f}')
    print(f'Test Precision: {test_metrics.get("precision", "N/A")}')
    print(f'Test Recall: {test_metrics.get("recall", "N/A")}')
    print(f'Test F1: {test_metrics.get("f1", "N/A")}')
    print(f'Test ROC-AUC: {test_metrics.get("roc_auc", "N/A")}')
    print(f'Test FAR@0.5: {test_metrics.get("far_at_0_5", "N/A"):.4f}')
    print(f'Test FRR@0.5: {test_metrics.get("frr_at_0_5", "N/A"):.4f}')
    print(f'Test EER: {test_metrics.get("eer", "N/A"):.4f}')
    print(f'EER Threshold: {test_metrics.get("eer_threshold", "N/A"):.4f}')
    print(f'\nResults saved to: {results_path}')
    print(f'Best model saved to: {ckpt_path}')
    
    # Save final model
    final_model_path = os.path.join(args.output_dir, 'final_model')
    model.save(final_model_path)
    print(f'Final model saved to: {final_model_path}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Train Continuum keystroke authentication model')
    parser.add_argument('--data-dir', type=str, default='data/', help='Directory with HDF files')
    parser.add_argument('--output-dir', type=str, default='artifacts/', help='Output directory')
    parser.add_argument('--window-size', type=int, default=50, choices=[20, 30, 40, 50], help='Continuum HDF window size to train on')
    parser.add_argument('--epochs', type=int, default=150, help='Training epochs (default: 150)')
    parser.add_argument('--batch-size', type=int, default=64, help='Batch size')
    parser.add_argument('--rnn-type', type=str, default='gru', choices=['lstm', 'gru'],
                        help='Recurrent cell type (default: gru)')
    parser.add_argument('--units', type=int, default=16,
                        help='RNN units per layer (default: 16, the deployed base ws50-gru-v2)')
    parser.add_argument('--pool-size', type=int, default=2,
                        help='Max pooling after the convolution (default: 2; 0 = none)')
    parser.add_argument('--legacy-network', action='store_true',
                        help='The earlier network: no pooling, both RNN layers return sequences, then Flatten')
    args = parser.parse_args()
    main(args)
