import os
import h5py
import numpy as np
from sklearn.model_selection import train_test_split, GroupShuffleSplit


def load_hdf_file(path):
    """Load HDF5 file and return data dictionary."""
    with h5py.File(path, 'r') as f:
        data = {}
        for k in f.keys():
            data[k] = np.array(f[k])
    return data


def normalize_labels(labels):
    return np.array(labels).reshape(-1).astype(np.int64)


def extract_keystroke_features(keystroke_events, window_size=30):
    """
    Extract features from keystroke events: dwell time, down-down time, up-down time.
    Based on Continuum methodology (Elkoby & Gutchin, 2022).
    
    Args:
        keystroke_events: dict or array with keystroke timing data
        window_size: size of sliding window (default 30)
    
    Returns:
        windows: array of shape (num_windows, window_size, 3) with [dwell, dd_time, ud_time] per key
    """
    # If already in correct format, return as-is
    if isinstance(keystroke_events, np.ndarray):
        if keystroke_events.ndim == 3:
            return keystroke_events
    return keystroke_events


def collect_dataset(data_dir, window_size=None, return_groups=False):
    """
    Collect and process HDF files from Continuum dataset.
    Expects HDF files to contain 'X' (features) and 'y' (labels).
    """
    X_list = []
    y_list = []
    group_list = []

    if not os.path.isdir(data_dir):
        raise RuntimeError(f'Data directory not found: {data_dir}')
    
    files = []
    for root, _, names in os.walk(data_dir):
        for name in names:
            if name.endswith(('.h5', '.hdf5')):
                if window_size and f'WS{window_size}' not in name:
                    continue
                files.append(os.path.join(root, name))
    if not files:
        if window_size:
            raise RuntimeError(f'No HDF files found in {data_dir} for window size WS{window_size}')
        raise RuntimeError(f'No HDF files found in {data_dir}')
    
    print(f'Found {len(files)} HDF files in {data_dir}')
    
    for path in files:
        fname = os.path.relpath(path, data_dir)
        try:
            d = load_hdf_file(path)
            
            # Try standard Continuum keys
            if 'X' in d and 'y' in d:
                X = np.array(d['X'])
                y = normalize_labels(d['y'])
                X_list.append(X)
                y_list.append(y)
                print(f'  {fname}: loaded (X: {X.shape}, y: {y.shape})')
            elif 'train_data' in d and 'train_labels' in d:
                X = np.array(d['train_data'])
                y = normalize_labels(d['train_labels'])
                X_list.append(X)
                y_list.append(y)
                # Optional explicit split groups (e.g. per-user for the mouse
                # dataset). Offset per file so groups never collide across files.
                if 'groups' in d:
                    g = np.asarray(d['groups']).reshape(-1).astype(np.int64)
                    g = g + (max((gg.max() + 1 for gg in group_list), default=0) if group_list else 0)
                    group_list.append(g)
                print(f'  {fname}: loaded Continuum train_data/train_labels (X: {X.shape}, y: {y.shape})')
            elif 'features' in d and 'labels' in d:
                X = np.array(d['features'])
                y = normalize_labels(d['labels'])
                X_list.append(X)
                y_list.append(y)
                print(f'  {fname}: loaded features/labels')
            else:
                # Fallback: use first two arrays
                arrays = [(k, v) for k, v in d.items() if isinstance(v, np.ndarray)]
                if len(arrays) >= 2:
                    X_list.append(arrays[0][1])
                    y_list.append(arrays[1][1])
                    print(f'  {fname}: loaded with fallback ({arrays[0][0]}, {arrays[1][0]})')
                else:
                    print(f'  {fname}: skipped (insufficient data)')
                    continue
        except Exception as e:
            print(f'  {fname}: error - {e}')
            continue
    
    if not X_list:
        raise RuntimeError('No HDF data loaded')
    
    X = np.concatenate(X_list, axis=0)
    y = np.concatenate(y_list, axis=0)
    groups = (
        np.concatenate(group_list, axis=0)
        if group_list and sum(len(g) for g in group_list) == len(X)
        else None
    )

    print(f'\nDataset shape: X={X.shape}, y={y.shape}'
          + (f', groups={len(np.unique(groups))}' if groups is not None else ''))
    return (X, y, groups) if return_groups else (X, y)


class _UnionFind:
    def __init__(self, n):
        self.parent = np.arange(n)

    def find(self, i):
        root = i
        while self.parent[root] != root:
            root = self.parent[root]
        while self.parent[i] != root:
            self.parent[i], i = root, self.parent[i]
        return root

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[rb] = ra


def compute_overlap_groups(X, subseq_len=3, step=1, decimals=4):
    """
    Group windows that share an identical timing subsequence.

    The Continuum Rand_WS*.h5 files were produced with an overlapping sliding
    window and then shuffled, so a plain random split leaks near-duplicate
    windows between train and test. Windows that share any `subseq_len`-step
    subsequence are almost certainly cuts of the same typing stretch, so they
    are forced into the same split group.
    """
    uf = _UnionFind(len(X))
    seen = {}
    window_size = X.shape[1]
    offsets = list(range(0, window_size - subseq_len + 1, step))

    for i in range(len(X)):
        rounded = X[i].round(decimals)
        for start in offsets:
            key = rounded[start:start + subseq_len].tobytes()
            if key in seen:
                uf.union(seen[key], i)
            else:
                seen[key] = i

    return np.array([uf.find(i) for i in range(len(X))])


def make_train_val_test(X, y, test_size=0.2, val_size=0.1, random_state=42, groups=None):
    """
    Split into train/val/test. When `groups` is given (or computed via
    compute_overlap_groups), overlapping windows never cross split
    boundaries, which prevents leakage-inflated scores.

    Whole groups are assigned to exactly one split. Because groups are
    (mostly) label-pure typing stretches, allocation is stratified by each
    group's majority label so every split contains both genuine and
    impostor windows.
    """
    if groups is None:
        groups = compute_overlap_groups(X)

    group_ids = np.unique(groups)
    print(f'Group-aware split: {len(X)} windows in {len(group_ids)} non-overlapping groups')

    rng = np.random.default_rng(random_state)
    group_indices = {g: np.where(groups == g)[0] for g in group_ids}
    group_label = {g: int(np.round(y[idx].mean())) for g, idx in group_indices.items()}

    train_idx, val_idx, test_idx = [], [], []
    for label in np.unique(list(group_label.values())):
        label_groups = [g for g in group_ids if group_label[g] == label]
        rng.shuffle(label_groups)
        total = sum(len(group_indices[g]) for g in label_groups)
        test_target = total * test_size
        val_target = total * val_size

        filled_test = filled_val = 0
        for g in label_groups:
            idx = group_indices[g]
            if filled_test < test_target:
                test_idx.append(idx)
                filled_test += len(idx)
            elif filled_val < val_target:
                val_idx.append(idx)
                filled_val += len(idx)
            else:
                train_idx.append(idx)

    train_idx = np.concatenate(train_idx)
    val_idx = np.concatenate(val_idx)
    test_idx = np.concatenate(test_idx)
    rng.shuffle(train_idx)
    rng.shuffle(val_idx)
    rng.shuffle(test_idx)

    for name, idx in (('Train', train_idx), ('Val', val_idx), ('Test', test_idx)):
        counts = np.bincount(y[idx].astype(int), minlength=2)
        print(f'{name} class balance: {counts.tolist()}')

    return X[train_idx], X[val_idx], X[test_idx], y[train_idx], y[val_idx], y[test_idx]
