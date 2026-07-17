# Dataset Citation Notes

## Primary Buffalo Dataset Paper

Use this as the main thesis citation for the public Buffalo keystroke dataset:

```bibtex
@inproceedings{sun2017shared,
  title={Shared keystroke dataset for continuous authentication},
  author={Sun, Yan and Ceker, Hayreddin and Upadhyaya, Shambhu},
  booktitle={2016 IEEE International Workshop on Information Forensics and Security (WIFS)},
  pages={1--6},
  year={2016},
  organization={IEEE},
  doi={10.1109/WIFS.2016.7823894}
}
```

The paper describes raw keystroke data collected from 157 subjects for continuous authentication research, including fixed-text transcription and free-text answers.

## Processed HDF Dataset Used In This Project

This project uses locally prepared windowed HDF files derived from the Buffalo keystroke dataset.

Local files:

```text
data/Rand_WS20.h5
data/Rand_WS30.h5
data/Rand_WS40.h5
data/Rand_WS50.h5
```

For the baseline experiment, we trained on `Rand_WS50.h5`.

## Thesis Wording

Example:

> The baseline keystroke-dynamics model was trained using a processed HDF version of the public Buffalo keystroke dataset. The original Buffalo dataset was introduced by Sun, Ceker, and Upadhyaya for continuous authentication research and contains raw keystroke data collected from 157 subjects performing fixed-text transcription and free-text answering tasks. The web application then collects each user's own keydown and keyup timing samples to build a user-specific rhythm profile for continuous authentication.
