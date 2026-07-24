Download instructions for Continuum `Data_HDF_files`

Primary source (public third-party keystroke-dynamics dataset mirror):
https://github.com/raf545/BioKey---Keystroke-dynamics-for-user-authentication/tree/master/Data_HDF_files

Options:

- Clone the third-party dataset repo and copy the `Data_HDF_files` directory into `continuum/data/`.
- If direct HDF files are available, place them in `continuum/data/`.

Example (git clone + copy):

```bash
cd continuum
mkdir data
git clone https://github.com/raf545/BioKey---Keystroke-dynamics-for-user-authentication.git temp_continuum
cp -r temp_continuum/Data_HDF_files/* data/
rm -rf temp_continuum
```

After files are in `continuum/data/`, run `python train.py --data-dir data/`.
