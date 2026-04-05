#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import signal
import sys
import traceback
from contextlib import contextmanager
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VENDOR = ROOT / "vendor" / "hexgo"
sys.path.insert(0, str(VENDOR))

import torch  # noqa: E402

from game import HexGame  # noqa: E402
from mcts import mcts_with_net  # noqa: E402
from net import HexNet, evaluate  # noqa: E402

DEFAULT_MODEL_PATH = "/Users/mte/Downloads/net_gen0222.pt"
DEFAULT_N_SIMS = 100


@contextmanager
def move_timeout(timeout_ms: int):
    if timeout_ms <= 0 or not hasattr(signal, "setitimer"):
        yield
        return

    def handle_timeout(_signum, _frame):
        raise TimeoutError(f"HexGo move timed out after {timeout_ms}ms")

    previous_handler = signal.getsignal(signal.SIGALRM)
    signal.signal(signal.SIGALRM, handle_timeout)
    signal.setitimer(signal.ITIMER_REAL, timeout_ms / 1000)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous_handler)


def build_game(game_json: str) -> HexGame:
    payload = json.loads(game_json) if game_json.strip() else {"turns": []}
    turns = payload.get("turns", [])

    game = HexGame()
    if not game.make(0, 0):
        raise RuntimeError("failed to apply implied opening stone")

    for turn in turns:
        stones = turn.get("stones", [])
        if len(stones) != 2:
            raise RuntimeError(f"expected exactly two stones per turn, got: {stones!r}")
        for stone in stones:
            q = int(stone["x"])
            r = int(stone["z"])
            if not game.make(q, r):
                raise RuntimeError(f"illegal translated move in HexGo bridge: {(q, r)}")

    return game


def load_state_dict(model_path: str, device: str):
    try:
        return torch.load(model_path, map_location=device, weights_only=True)
    except TypeError:
        return torch.load(model_path, map_location=device)


def pick_best_allowed(policy: dict[tuple[int, int], float], moves: list[tuple[int, int]]) -> tuple[int, int]:
    return max(
        moves,
        key=lambda move: (float(policy.get(move, float("-inf"))), -abs(move[0]), -abs(move[1]), move),
    )


@torch.no_grad()
def choose_turn(game: HexGame, net: HexNet, n_sims: int) -> list[tuple[int, int]]:
    pre_turn = game.clone()
    legal_before = list(pre_turn.legal_moves())
    if len(legal_before) < 2:
        raise RuntimeError(f"HexGo bridge expected at least two legal cells, got {len(legal_before)}")

    first = mcts_with_net(game, net, n_sims)
    if first not in legal_before:
        raise RuntimeError(f"HexGo proposed an illegal first move: {first!r}")
    if not game.make(*first):
        raise RuntimeError(f"HexGo failed to apply first move: {first!r}")

    allowed_second = [move for move in legal_before if move != first]
    if not allowed_second:
        raise RuntimeError("HexGo bridge could not find a legal second stone")

    if game.winner is not None:
        _, policy = evaluate(net, pre_turn)
        return [first, pick_best_allowed(policy, allowed_second)]

    second = mcts_with_net(game, net, n_sims)
    if second != first and second in allowed_second:
        return [first, second]

    _, conditioned_policy = evaluate(net, game)
    return [first, pick_best_allowed(conditioned_policy, allowed_second)]


def main() -> int:
    model_path = os.environ.get("HEXGO_MODEL_PATH", DEFAULT_MODEL_PATH)
    n_sims = int(os.environ.get("HEXGO_N_SIMS", str(DEFAULT_N_SIMS)))
    requested_device = os.environ.get("HEXGO_DEVICE")

    if requested_device is None:
        if torch.cuda.is_available():
            device = "cuda"
        elif getattr(torch.backends, "mps", None) is not None and torch.backends.mps.is_available():
            device = "mps"
        else:
            device = "cpu"
    else:
        device = requested_device

    thread_count = int(os.environ.get("HEXGO_TORCH_THREADS", "1" if device == "mps" else "0"))
    move_timeout_ms = int(os.environ.get("HEXGO_MOVE_TIMEOUT_MS", "30000"))
    if thread_count > 0:
        torch.set_num_threads(thread_count)
        try:
            torch.set_num_interop_threads(thread_count)
        except RuntimeError:
            pass

    try:
        net = HexNet().to(device)
        state = load_state_dict(model_path, device)
        net.load_state_dict(state)
        net.eval()
    except Exception as exc:
        print(
            json.dumps(
                {
                    "ready": False,
                    "error": f"{type(exc).__name__}: {exc}\n{traceback.format_exc()}",
                }
            ),
            flush=True,
        )
        return 1

    print(
        json.dumps(
            {
                "ready": True,
                "device": str(next(net.parameters()).device),
                "model_path": model_path,
                "n_sims": n_sims,
                "torch_threads": thread_count if thread_count > 0 else None,
            }
        ),
        flush=True,
    )

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            with move_timeout(move_timeout_ms):
                game = build_game(request["game_json"])
                stones = choose_turn(game, net, n_sims)
            if len(stones) != 2:
                raise RuntimeError(f"expected two stones from HexGo, got: {stones!r}")
            response = {"stones": [[int(q), int(r)] for q, r in stones]}
        except Exception as exc:
            response = {
                "error": f"{type(exc).__name__}: {exc}\n{traceback.format_exc()}"
            }
        print(json.dumps(response), flush=True)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
