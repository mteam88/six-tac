import asyncio
import json
import os
import subprocess
import sys
import threading
from contextlib import asynccontextmanager
from pathlib import Path

import modal

APP_NAME = "six-tac-kraken"
MODEL_PATH = "/app/bots/models/kraken_v1.pt"
WORKER_PATH = "/app/bots/scripts/krakenbot_worker.py"
WORKER_CWD = "/app/bots/vendor/KrakenBot"
AUTH_SECRET_NAME = "six-tac-kraken-auth"

image = (
    modal.Image.debian_slim(python_version="3.11")
    .uv_pip_install(
        "fastapi[standard]==0.115.12",
        "torch",
        "numpy",
        "cython",
    )
    .add_local_dir(Path(__file__).resolve().parents[1] / "bots" / "vendor" / "KrakenBot", remote_path=WORKER_CWD, copy=True)
    .add_local_file(Path(__file__).resolve().parents[1] / "bots" / "scripts" / "krakenbot_worker.py", remote_path=WORKER_PATH, copy=True)
    .add_local_file(Path(__file__).resolve().parents[1] / "bots" / "models" / "kraken_v1.pt", remote_path=MODEL_PATH, copy=True)
)

app = modal.App(APP_NAME, image=image)


class KrakenWorkerProcess:
    def __init__(self):
        env = os.environ.copy()
        env.setdefault("KRAKEN_MODEL_PATH", MODEL_PATH)
        env.setdefault("KRAKEN_BUILD_EXTENSIONS", "0")
        env.setdefault("KRAKEN_DEVICE", "cuda")
        env.setdefault("KRAKEN_N_SIMS", "200")
        self._proc = subprocess.Popen(
            [sys.executable, WORKER_PATH],
            cwd=WORKER_CWD,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=sys.stderr,
            text=True,
            bufsize=1,
        )
        self._lock = threading.Lock()
        self._read_ready()

    def _read_ready(self):
        line = self._read_line()
        payload = json.loads(line)
        if not payload.get("ready"):
            raise RuntimeError(payload.get("error") or "Kraken worker failed to start")

    def _read_line(self):
        if self._proc.stdout is None:
            raise RuntimeError("Kraken worker stdout is unavailable")
        line = self._proc.stdout.readline()
        if line:
            return line
        raise RuntimeError("Kraken worker exited unexpectedly")

    def _request(self, payload: dict):
        if self._proc.stdin is None:
            raise RuntimeError("Kraken worker stdin is unavailable")

        with self._lock:
            self._proc.stdin.write(json.dumps(payload) + "\n")
            self._proc.stdin.flush()
            return json.loads(self._read_line())

    def best_move(self, game_json, cache_key=None):
        payload = self._request({
            "mode": "best_move",
            "game_json": game_json,
            "cache_key": cache_key,
        })
        stones = payload.get("stones")
        if not isinstance(stones, list) or len(stones) != 2:
            raise RuntimeError(payload.get("error") or "Kraken worker returned no move")
        return stones

    def evaluate(self, game_json, cache_key=None):
        payload = self._request({
            "mode": "eval",
            "game_json": game_json,
            "cache_key": cache_key,
            "advance_session": False,
        })
        score = payload.get("score")
        win_prob = payload.get("win_prob")
        best_move = payload.get("best_move")
        if not isinstance(score, (int, float)) or not isinstance(win_prob, (int, float)):
            raise RuntimeError(payload.get("error") or "Kraken worker returned no eval")
        return float(score), float(win_prob), best_move if isinstance(best_move, list) else None

    def close(self):
        if self._proc.poll() is not None:
            return
        self._proc.kill()
        self._proc.wait()


@app.function(
    gpu="T4",
    min_containers=0,
    scaledown_window=120,
    timeout=600,
    secrets=[modal.Secret.from_name(AUTH_SECRET_NAME, required_keys=["MODAL_BOT_TOKEN"])],
)
@modal.asgi_app()
def web():
    from fastapi import Depends, FastAPI, HTTPException, Request, status
    from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

    auth_scheme = HTTPBearer(auto_error=True)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        service.state.worker = KrakenWorkerProcess()
        try:
            yield
        finally:
            service.state.worker.close()

    service = FastAPI(lifespan=lifespan)

    def require_token(token: HTTPAuthorizationCredentials = Depends(auth_scheme)):
        if token.credentials != os.environ["MODAL_BOT_TOKEN"]:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Incorrect bearer token",
                headers={"WWW-Authenticate": "Bearer"},
            )

    @service.get("/health")
    async def health():
        return {"ok": True}

    @service.post("/v1/best-move")
    async def best_move(request: Request, _: object = Depends(require_token)):
        payload = await request.json()
        if payload.get("bot_name") != "kraken":
            raise HTTPException(status_code=400, detail="Only kraken is served here")
        game_json = payload.get("game_json")
        if not isinstance(game_json, str):
            raise HTTPException(status_code=400, detail="Missing game_json")
        stones = await asyncio.to_thread(service.state.worker.best_move, game_json, payload.get("cache_key"))
        return {
            "stones": stones,
            "model_version": os.environ.get("KRAKEN_MODEL_VERSION", "kraken_v1"),
        }

    @service.post("/v1/eval")
    async def eval_position(request: Request, _: object = Depends(require_token)):
        payload = await request.json()
        if payload.get("bot_name") != "kraken":
            raise HTTPException(status_code=400, detail="Only kraken is served here")
        game_json = payload.get("game_json")
        if not isinstance(game_json, str):
            raise HTTPException(status_code=400, detail="Missing game_json")
        score, win_prob, best_move = await asyncio.to_thread(service.state.worker.evaluate, game_json, payload.get("cache_key"))
        return {
            "score": score,
            "win_prob": win_prob,
            "best_move": best_move,
            "model_version": os.environ.get("KRAKEN_MODEL_VERSION", "kraken_v1"),
        }

    return service
