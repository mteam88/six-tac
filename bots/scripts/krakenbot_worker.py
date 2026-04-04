#!/usr/bin/env python3
from __future__ import annotations

import importlib
import json
import os
import signal
import subprocess
import sys
from collections import OrderedDict
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VENDOR = ROOT / "vendor" / "KrakenBot"
sys.path.insert(0, str(VENDOR))

import torch  # noqa: E402
import torch.nn.functional as F  # noqa: E402

DEFAULT_MODEL_PATH = "/Users/mte/Downloads/kraken_v1.pt"


@contextmanager
def move_timeout(timeout_ms: int):
    if timeout_ms <= 0 or not hasattr(signal, "setitimer"):
        yield
        return

    def handle_timeout(_signum, _frame):
        raise TimeoutError(f"KrakenBot move timed out after {timeout_ms}ms")

    previous_handler = signal.getsignal(signal.SIGALRM)
    signal.signal(signal.SIGALRM, handle_timeout)
    signal.setitimer(signal.ITIMER_REAL, timeout_ms / 1000)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous_handler)


def ensure_fast_extensions() -> None:
    if os.environ.get("KRAKEN_BUILD_EXTENSIONS", "1") == "0":
        return
    try:
        importlib.import_module("mcts._puct_cy")
        importlib.import_module("mcts._mcts_cy")
        return
    except Exception:
        pass

    setup_path = VENDOR / "setup_puct.py"
    try:
        subprocess.run(
            [sys.executable, str(setup_path), "build_ext", "--inplace"],
            cwd=VENDOR,
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        return


ensure_fast_extensions()

from game import HexGame, ToroidalHexGame  # noqa: E402
from mcts_bot import MCTSBot  # noqa: E402
from model.resnet import BOARD_SIZE  # noqa: E402


@torch.inference_mode()
def _patched_get_move(self, game) -> list[tuple[int, int]]:
    from mcts.tree import (
        create_tree,
        create_tree_dynamic,
        expand_and_backprop,
        maybe_expand_leaf,
        select_leaf,
        select_move_pair,
        select_single_move,
    )

    try:
        from mcts._mcts_cy import CyGameState, backprop_cy, select_leaf_cy
        has_cy = True
    except ImportError:
        CyGameState = None
        backprop_cy = None
        select_leaf_cy = None
        has_cy = False

    self.last_depth = self.n_sims
    self._nodes = 0
    is_torus = isinstance(game, ToroidalHexGame)

    if not game.board:
        if is_torus:
            center = BOARD_SIZE // 2
            return [(center, center)]
        return [(0, 0)]

    if is_torus:
        tree = create_tree(game, self.model, self.device, add_noise=False)
        proxy_game = game
        off_q = off_r = 0
    else:
        self.model.set_padding_mode("zeros")
        tree, off_q, off_r = create_tree_dynamic(
            game,
            self.model,
            self.device,
            add_noise=False,
            min_size=BOARD_SIZE,
            margin=8,
        )
        proxy_game = HexGame(win_length=game.win_length)
        proxy_game.board = {}
        for (rq, rr), player in game.board.items():
            proxy_game.board[(rq + off_q, rr + off_r)] = player
        proxy_game.current_player = game.current_player
        proxy_game.moves_left_in_turn = game.moves_left_in_turn
        proxy_game.move_count = game.move_count
        proxy_game.winner = game.winner
        proxy_game.winning_cells = list(getattr(game, "winning_cells", []))
        proxy_game.game_over = game.game_over

    cy_game = None
    if has_cy and isinstance(proxy_game, ToroidalHexGame):
        cy_game = CyGameState.from_toroidal_game(proxy_game)

    self._nodes = 1

    for _ in range(self.n_sims):
        if cy_game is not None:
            leaf = select_leaf_cy(tree, cy_game)
        else:
            leaf = select_leaf(tree, proxy_game)

        if leaf.is_terminal:
            if cy_game is not None:
                backprop_cy(tree, leaf, 0.0)
            else:
                expand_and_backprop(tree, leaf, 0.0)
            continue

        planes = tree.root_planes.clone()
        if leaf.player_flipped:
            planes = planes.flip(0)
        for gq, gr, ch in leaf.deltas:
            actual_ch = (1 - ch) if leaf.player_flipped else ch
            planes[actual_ch, gq, gr] = 1.0
        x = planes.unsqueeze(0).to(self.device)
        value, pair_logits, _, _ = self.model(x)
        nn_val = value[0].item()
        if cy_game is not None:
            backprop_cy(tree, leaf, nn_val)
        else:
            expand_and_backprop(tree, leaf, nn_val)

        if leaf.needs_expansion:
            logits = pair_logits[0]
            flat = logits.reshape(-1)
            top_raw, top_idxs = flat.topk(min(200, flat.shape[0]))
            top_vals = F.softmax(top_raw, dim=0)
            marginal_logits = logits.logsumexp(dim=-1)
            marginal = F.softmax(marginal_logits, dim=0).cpu()
            maybe_expand_leaf(tree, leaf, marginal, top_idxs.cpu(), top_vals.cpu(), nn_value=nn_val)

        self._nodes += 1

    self.last_root_value = tree.root_value

    if not is_torus:
        self.model.set_padding_mode("circular")

    if game.moves_left_in_turn == 1:
        gq, gr = select_single_move(tree)
        if is_torus:
            return [(gq, gr)]
        return [(gq - off_q, gr - off_r)]

    (g1q, g1r), (g2q, g2r) = select_move_pair(tree, temperature=0.1)
    if is_torus:
        return [(g1q, g1r), (g2q, g2r)]
    return [(g1q - off_q, g1r - off_r), (g2q - off_q, g2r - off_r)]


MCTSBot.get_move = _patched_get_move


Turn = tuple[tuple[int, int], tuple[int, int]]


@dataclass
class CachedGame:
    game: HexGame
    turns: list[Turn]


def _new_game() -> HexGame:
    game = HexGame(win_length=6)
    if not game.make_move(0, 0):
        raise RuntimeError("failed to apply implied opening stone")
    return game


def _normalize_turns(request: dict) -> list[Turn]:
    if "turns" in request:
        raw_turns = request.get("turns") or []
        turns: list[Turn] = []
        for turn in raw_turns:
            if len(turn) != 2:
                raise RuntimeError(f"expected two stones per turn, got: {turn!r}")
            stones = []
            for stone in turn:
                if len(stone) != 2:
                    raise RuntimeError(f"expected axial stone pair, got: {stone!r}")
                stones.append((int(stone[0]), int(stone[1])))
            turns.append((stones[0], stones[1]))
        return turns

    game_json = request.get("game_json", "")
    payload = json.loads(game_json) if str(game_json).strip() else {"turns": []}
    turns = []
    for turn in payload.get("turns", []):
        stones = []
        for stone in turn["stones"]:
            stones.append((int(stone["x"]), int(stone["z"])))
        if len(stones) != 2:
            raise RuntimeError(f"expected two stones per turn, got: {stones!r}")
        turns.append((stones[0], stones[1]))
    return turns


def _apply_turn(game: HexGame, turn: Turn) -> None:
    for q, r in turn:
        if not game.make_move(q, r):
            raise RuntimeError(f"illegal translated move in KrakenBot bridge: {(q, r)}")


def _build_game(turns: list[Turn]) -> HexGame:
    game = _new_game()
    for turn in turns:
        _apply_turn(game, turn)
    return game


def _sync_cached_game(session: CachedGame | None, turns: list[Turn]) -> CachedGame:
    if session is None or len(session.turns) > len(turns) or session.turns != turns[: len(session.turns)]:
        return CachedGame(game=_build_game(turns), turns=list(turns))

    for turn in turns[len(session.turns) :]:
        _apply_turn(session.game, turn)
        session.turns.append(turn)
    return session


def main() -> int:
    model_path = os.environ.get("KRAKEN_MODEL_PATH", DEFAULT_MODEL_PATH)
    n_sims = int(os.environ.get("KRAKEN_N_SIMS", "200"))
    requested_device = os.environ.get("KRAKEN_DEVICE")

    if requested_device is None:
        if torch.cuda.is_available():
            device = "cuda"
        elif torch.backends.mps.is_available():
            device = "mps"
        else:
            device = "cpu"
    else:
        device = requested_device

    thread_count = int(os.environ.get("KRAKEN_TORCH_THREADS", "1" if device == "mps" else "0"))
    move_timeout_ms = int(os.environ.get("KRAKEN_MOVE_TIMEOUT_MS", "30000"))
    max_cached_games = max(1, int(os.environ.get("KRAKEN_SESSION_CACHE_SIZE", "128")))
    if thread_count > 0:
        torch.set_num_threads(thread_count)
        try:
            torch.set_num_interop_threads(thread_count)
        except RuntimeError:
            pass

    try:
        bot = MCTSBot(model_path=model_path, n_sims=n_sims, device=device)
    except Exception as exc:
        print(json.dumps({"ready": False, "error": str(exc)}), flush=True)
        return 1

    print(
        json.dumps(
            {
                "ready": True,
                "device": str(bot.device),
                "model_path": model_path,
                "n_sims": n_sims,
                "torch_threads": thread_count if thread_count > 0 else None,
                "session_cache_size": max_cached_games,
            }
        ),
        flush=True,
    )

    sessions: OrderedDict[str, CachedGame] = OrderedDict()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        cache_key: str | None = None
        try:
            request = json.loads(line)
            turns = _normalize_turns(request)
            cache_key = request.get("cache_key") or None
            session: CachedGame | None = None
            if cache_key is not None:
                session = _sync_cached_game(sessions.get(cache_key), turns)
                sessions[cache_key] = session
                sessions.move_to_end(cache_key)
                while len(sessions) > max_cached_games:
                    sessions.popitem(last=False)
            with move_timeout(move_timeout_ms):
                game = session.game if session is not None else _build_game(turns)
                stones = bot.get_move(game)
            if len(stones) != 2:
                raise RuntimeError(f"expected two stones from KrakenBot, got: {stones!r}")
            move = ((int(stones[0][0]), int(stones[0][1])), (int(stones[1][0]), int(stones[1][1])))
            if session is not None:
                _apply_turn(session.game, move)
                session.turns.append(move)
            response = {"stones": [[q, r] for q, r in move]}
        except Exception as exc:
            if cache_key is not None:
                sessions.pop(cache_key, None)
            response = {"error": str(exc)}
        print(json.dumps(response), flush=True)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
