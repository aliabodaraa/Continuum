#!/usr/bin/env bash
# Convert a trained Keras SavedModel → TF.js graph model for ON-DEVICE inference in
# the extension. Runs inside the model-api image (which already ships TensorFlow 2.15),
# so it does NOT re-download TensorFlow.
#
# Why the odd install flags:
#   • --no-deps: installing plain `tensorflowjs` tries to REINSTALL TensorFlow (~645 MB);
#     the image already has TF 2.15, so we install the converter without its deps.
#   • tensorflowjs 3.21.0 works directly with TF 2.15's built-in tf.keras (no tf_keras/TF-DF).
#   • the converter imports `jax` at load even for SavedModel conversion (never used here),
#     so we drop in a tiny permissive `jax` stub instead of pulling jax/jaxlib.
#
# Usage:
#   ./extension/scripts/convert-model.sh [SAVED_MODEL_IN_IMAGE] [OUT_DIR_IN_REPO]
#   e.g. ./extension/scripts/convert-model.sh artifacts/ws50-gru/final_model extension/model/ws50-gru
set -euo pipefail
cd "$(dirname "$0")/../.."

SRC="${1:-artifacts/ws50-gru/final_model}"     # path INSIDE the model-api image (/app/<SRC>)
OUT="${2:-extension/model/ws50-gru}"           # output dir in the repo
IMAGE="${MODEL_IMAGE:-aliabodaraa/model-api:0.1.0}"

docker rm -f cg-tfjs >/dev/null 2>&1 || true
MSYS_NO_PATHCONV=1 docker run --name cg-tfjs -e SRC="/app/$SRC" "$IMAGE" sh -c '
  pip install --no-deps --retries 30 "tensorflowjs==3.21.0" tensorflow-hub six packaging >/dev/null 2>&1
  SP=/usr/local/lib/python3.11/site-packages
  mkdir -p $SP/jax/experimental
  STUB="class _Any:\n    def __getattr__(self, n): return _Any()\n    def __call__(self, *a, **k): return _Any()\n    def __iter__(self): return iter(())\ndef __getattr__(name): return _Any()\n"
  printf "$STUB" > $SP/jax/__init__.py
  printf "$STUB" > $SP/jax/experimental/__init__.py
  printf "$STUB" > $SP/jax/experimental/jax2tf.py
  tensorflowjs_converter --input_format=tf_saved_model --output_format=tfjs_graph_model "$SRC" /tmp/tfjs
'
mkdir -p "$OUT"
MSYS_NO_PATHCONV=1 docker cp cg-tfjs:/tmp/tfjs/. "$OUT/"
docker rm -f cg-tfjs >/dev/null 2>&1 || true
echo ">> wrote TF.js model to $OUT"
ls -la "$OUT"
