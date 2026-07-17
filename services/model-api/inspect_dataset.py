import argparse
import os

import h5py
import numpy as np


def inspect_hdf(path):
    print(f'\n{os.path.basename(path)}')
    print('-' * len(os.path.basename(path)))

    with h5py.File(path, 'r') as hdf:
        for key in hdf.keys():
            value = hdf[key]
            if not hasattr(value, 'shape'):
                print(f'{key}: group')
                continue

            print(f'{key}: shape={value.shape}, dtype={value.dtype}')
            if key.lower() in {'y', 'labels', 'label'}:
                labels = np.array(value)
                unique, counts = np.unique(labels, return_counts=True)
                preview = ', '.join(f'{label}:{count}' for label, count in zip(unique[:20], counts[:20]))
                if len(unique) > 20:
                    preview += ', ...'
                print(f'  labels={preview}')


def main():
    parser = argparse.ArgumentParser(description='Inspect Continuum HDF dataset files')
    parser.add_argument('--data-dir', default='data', help='Directory containing .h5/.hdf5 files')
    args = parser.parse_args()

    files = []
    for root, _, names in os.walk(args.data_dir):
        for name in names:
            if name.endswith(('.h5', '.hdf5')):
                files.append(os.path.join(root, name))

    if not files:
        raise SystemExit(f'No HDF files found in {args.data_dir}')

    for path in sorted(files):
        inspect_hdf(path)


if __name__ == '__main__':
    main()
