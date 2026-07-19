#!/usr/bin/env bash
# Build the EVAL-FREE TensorFlow.js bundle the extension ships (extension/vendor/tf-lite.js).
#
# MV3's CSP forbids 'unsafe-eval', and the stock tf.min.js UMD trips it. Bundling
# tfjs-core + the CPU backend + the converter (graph models) + LAYERS (trainable
# models, needed for on-device personalization) with esbuild at es2020 produces no
# eval/new Function() — verified by grep below.
#
# Runs in a Node container (nothing installed on the host). Defaults to our own
# gateway image — it ships Node 20 and is always present locally, so no registry pull.
set -euo pipefail
cd "$(dirname "$0")/../.."

TFJS_VERSION="${TFJS_VERSION:-4.22.0}"
NODE_IMAGE="${NODE_IMAGE:-aliabodaraa/gateway:0.1.0}"
docker rm -f cg-tfbundle >/dev/null 2>&1 || true
MSYS_NO_PATHCONV=1 docker run --name cg-tfbundle -e V="$TFJS_VERSION" --entrypoint sh "$NODE_IMAGE" -c '
  set -e
  mkdir /b && cd /b
  npm init -y >/dev/null
  npm install --no-audit --no-fund esbuild \
    @tensorflow/tfjs-core@$V @tensorflow/tfjs-backend-cpu@$V \
    @tensorflow/tfjs-converter@$V @tensorflow/tfjs-layers@$V >/dev/null
  cat > entry.js <<EOF
import * as core from "@tensorflow/tfjs-core";
import "@tensorflow/tfjs-backend-cpu";
import * as converter from "@tensorflow/tfjs-converter";
import * as layers from "@tensorflow/tfjs-layers";
globalThis.tf = Object.assign({}, core, converter, layers);
EOF
  npx esbuild entry.js --bundle --minify --target=es2020 --outfile=/tf-lite.js
  echo "--- eval check (must print nothing) ---"
  grep -nE "[^a-zA-Z_.]eval\(|new Function\(" /tf-lite.js | head -5 || true
  ls -la /tf-lite.js
'
MSYS_NO_PATHCONV=1 docker cp cg-tfbundle:/tf-lite.js extension/vendor/tf-lite.js
docker rm -f cg-tfbundle >/dev/null 2>&1 || true
echo ">> wrote extension/vendor/tf-lite.js"
ls -la extension/vendor/tf-lite.js
