#!/usr/bin/env bash
set -euo pipefail

DEFAULT_MODEL_PATH="/app/bots/models/kraken_v1.pt"
DOWNLOAD_MODEL_PATH="${KRAKEN_MODEL_PATH:-/tmp/kraken-model/kraken_v1.pt}"

if [[ -n "${KRAKEN_MODEL_PATH:-}" && -f "${KRAKEN_MODEL_PATH}" ]]; then
  :
elif [[ -f "${DEFAULT_MODEL_PATH}" ]]; then
  export KRAKEN_MODEL_PATH="${DEFAULT_MODEL_PATH}"
elif [[ -n "${KRAKEN_MODEL_URL:-}" ]]; then
  mkdir -p "$(dirname "${DOWNLOAD_MODEL_PATH}")"
  export KRAKEN_MODEL_PATH="${DOWNLOAD_MODEL_PATH}"
  if [[ ! -f "${KRAKEN_MODEL_PATH}" ]]; then
    python3 - <<'PY'
import os
import urllib.request

url = os.environ["KRAKEN_MODEL_URL"]
out_path = os.environ["KRAKEN_MODEL_PATH"]
print(f"downloading Kraken model: {url} -> {out_path}", flush=True)
urllib.request.urlretrieve(url, out_path)
PY
  fi
else
  echo >&2 "Kraken model missing. Bundle bots/models/kraken_v1.pt into the image or set KRAKEN_MODEL_URL."
  exit 1
fi

export BOT_SERVICE_ADDR="${BOT_SERVICE_ADDR:-0.0.0.0:8788}"
exec /usr/local/bin/bot_service
