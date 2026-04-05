#!/usr/bin/env bash
set -euo pipefail

ensure_model() {
  local prefix="$1"
  local bundled_path="$2"
  local default_download_path="$3"

  local model_path_var="${prefix}_MODEL_PATH"
  local model_url_var="${prefix}_MODEL_URL"
  local configured_path="${!model_path_var:-}"
  local configured_url="${!model_url_var:-}"
  local download_path="${configured_path:-${default_download_path}}"

  if [[ -n "${configured_path}" && -f "${configured_path}" ]]; then
    export "${model_path_var}=${configured_path}"
    return 0
  fi

  if [[ -f "${bundled_path}" ]]; then
    export "${model_path_var}=${bundled_path}"
    return 0
  fi

  if [[ -n "${configured_url}" ]]; then
    mkdir -p "$(dirname "${download_path}")"
    export "${model_path_var}=${download_path}"
    if [[ ! -f "${download_path}" ]]; then
      MODEL_PREFIX="${prefix}" MODEL_URL="${configured_url}" MODEL_OUT_PATH="${download_path}" python3 - <<'PY'
import os
import urllib.request

prefix = os.environ["MODEL_PREFIX"]
url = os.environ["MODEL_URL"]
out_path = os.environ["MODEL_OUT_PATH"]
print(f"downloading {prefix} model: {url} -> {out_path}", flush=True)
urllib.request.urlretrieve(url, out_path)
PY
    fi
    return 0
  fi

  return 1
}

available_models=0
if ensure_model "KRAKEN" "/app/bots/models/kraken_v1.pt" "/tmp/kraken-model/kraken_v1.pt"; then
  available_models=$((available_models + 1))
fi
if ensure_model "HEXGO" "/app/bots/models/net_gen0222.pt" "/tmp/hexgo-model/net_gen0222.pt"; then
  available_models=$((available_models + 1))
fi

if [[ "${available_models}" -eq 0 ]]; then
  echo >&2 "No native bot models configured. Bundle bots/models/kraken_v1.pt and/or bots/models/net_gen0222.pt into the image, or set KRAKEN_MODEL_URL and/or HEXGO_MODEL_URL."
  exit 1
fi

export BOT_SERVICE_ADDR="${BOT_SERVICE_ADDR:-0.0.0.0:8788}"
exec /usr/local/bin/bot_service
