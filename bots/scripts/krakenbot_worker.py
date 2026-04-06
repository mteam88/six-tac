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
from dataclasses import dataclass, field
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
from mcts.tree import (  # noqa: E402
    create_tree,
    create_tree_dynamic,
    expand_and_backprop,
    graft_reused_subtree,
    maybe_expand_leaf,
    select_leaf,
    select_move_pair,
    select_single_move,
)
from mcts_bot import MCTSBot  # noqa: E402
from model.resnet import BOARD_SIZE  # noqa: E402

try:  # noqa: E402
    from mcts._mcts_cy import CyGameState, backprop_cy, select_leaf_cy
except ImportError:  # noqa: E402
    CyGameState = None
    backprop_cy = None
    select_leaf_cy = None

Turn = tuple[tuple[int, int], tuple[int, int]]


@dataclass(frozen=True)
class SearchGeometry:
    off_q: int = 0
    off_r: int = 0
    width: int = BOARD_SIZE
    height: int = BOARD_SIZE
    is_torus: bool = False


@dataclass
class SearchState:
    tree: object
    proxy_game: object
    geometry: SearchGeometry
    sims_done: int = 0


@dataclass
class ReuseState:
    node: object
    geometry: SearchGeometry


@dataclass
class KrakenSession:
    game: HexGame
    turns: list[Turn] = field(default_factory=list)
    search: SearchState | None = None
    reuse: ReuseState | None = None

    def sync_turns(self, turns: list[Turn]) -> None:
        if len(self.turns) > len(turns) or self.turns != turns[: len(self.turns)]:
            self.game = _build_game(turns)
            self.turns = list(turns)
            self.search = None
            self.reuse = None
            return

        if len(turns) == len(self.turns):
            return

        appended = turns[len(self.turns) :]
        self.reuse = self._descend_cached_path(appended)
        for turn in appended:
            _apply_turn(self.game, turn)
            self.turns.append(turn)
        self.search = None

    def _descend_cached_path(self, turns: list[Turn]) -> ReuseState | None:
        if not turns:
            return self.reuse

        if self.search is not None:
            geometry = self.search.geometry
            node = _root_child_for_turn(self.search, turns[0])
            start = 1
        elif self.reuse is not None:
            geometry = self.reuse.geometry
            node = self.reuse.node
            start = 0
        else:
            return None

        if node is None:
            return None

        for turn in turns[start:]:
            node = _child_for_turn(node, turn, geometry)
            if node is None:
                return None

        return ReuseState(node=node, geometry=geometry)

    def ensure_search(self, bot: MCTSBot, n_sims: int) -> SearchState:
        if self.search is None:
            self.search = _create_search_state(bot, self.game, self.reuse)
            self.reuse = None
        _run_search(bot, self.search, n_sims)
        return self.search

    def advance_with_move(self, move: Turn) -> None:
        reuse = None
        if self.search is not None:
            child = _root_child_for_turn(self.search, move)
            if child is not None:
                reuse = ReuseState(node=child, geometry=self.search.geometry)

        _apply_turn(self.game, move)
        self.turns.append(move)
        self.search = None
        self.reuse = reuse


@torch.inference_mode()
def _run_search(bot: MCTSBot, state: SearchState, target_sims: int) -> None:
    use_torus_path = state.geometry.is_torus and CyGameState is not None
    cy_game = None
    select_fn = select_leaf
    backprop_fn = expand_and_backprop

    if use_torus_path:
        cy_game = CyGameState.from_toroidal_game(state.proxy_game)
        select_fn = select_leaf_cy
        backprop_fn = backprop_cy
    else:
        bot.model.set_padding_mode("zeros")

    try:
        while state.sims_done < target_sims:
            leaf = select_fn(state.tree, cy_game or state.proxy_game)

            if leaf.is_terminal:
                backprop_fn(state.tree, leaf, 0.0)
                state.sims_done += 1
                continue

            planes = state.tree.root_planes.clone()
            if leaf.player_flipped:
                planes = planes.flip(0)
            for gq, gr, ch in leaf.deltas:
                actual_ch = (1 - ch) if leaf.player_flipped else ch
                planes[actual_ch, gq, gr] = 1.0

            x = planes.unsqueeze(0).to(bot.device)
            value, pair_logits, _, _ = bot.model(x)
            nn_val = value[0].item()
            backprop_fn(state.tree, leaf, nn_val)

            if leaf.needs_expansion:
                logits = pair_logits[0]
                flat = logits.reshape(-1)
                top_raw, top_idxs = flat.topk(min(200, flat.shape[0]))
                top_vals = F.softmax(top_raw, dim=0)
                marginal_logits = logits.logsumexp(dim=-1)
                marginal = F.softmax(marginal_logits, dim=0).cpu()
                maybe_expand_leaf(
                    state.tree,
                    leaf,
                    marginal,
                    top_idxs.cpu(),
                    top_vals.cpu(),
                    nn_value=nn_val,
                )

            state.sims_done += 1
    finally:
        if not use_torus_path:
            bot.model.set_padding_mode("circular")

    bot.last_depth = state.sims_done
    bot.last_root_value = state.tree.root_value
    bot._nodes = max(1, state.sims_done)


@torch.inference_mode()
def _create_search_state(bot: MCTSBot, game, reuse: ReuseState | None) -> SearchState:
    if isinstance(game, ToroidalHexGame):
        tree = create_tree(game, bot.model, bot.device, add_noise=False)
        geometry = SearchGeometry(is_torus=True)
        proxy_game = _clone_toroidal_game(game)
    else:
        bot.model.set_padding_mode("zeros")
        tree, off_q, off_r = create_tree_dynamic(
            game,
            bot.model,
            bot.device,
            add_noise=False,
            min_size=BOARD_SIZE,
            margin=8,
        )
        geometry = SearchGeometry(
            off_q=off_q,
            off_r=off_r,
            width=tree.board_width,
            height=tree.n_cells // tree.board_width,
            is_torus=False,
        )
        proxy_game = _build_dynamic_proxy_game(game, off_q, off_r)

    sims_done = 0
    if reuse is not None and reuse.geometry == geometry:
        sims_done = graft_reused_subtree(tree, reuse.node, add_noise=False)

    return SearchState(tree=tree, proxy_game=proxy_game, geometry=geometry, sims_done=sims_done)


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


def _clone_toroidal_game(game: ToroidalHexGame) -> ToroidalHexGame:
    clone = ToroidalHexGame(win_length=game.win_length)
    clone.board = dict(game.board)
    clone.current_player = game.current_player
    clone.moves_left_in_turn = game.moves_left_in_turn
    clone.move_count = game.move_count
    clone.winner = game.winner
    clone.game_over = game.game_over
    return clone


def _build_dynamic_proxy_game(game: HexGame, off_q: int, off_r: int) -> HexGame:
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
    return proxy_game


def _select_move_for_state(game, state: SearchState) -> list[tuple[int, int]]:
    if game.moves_left_in_turn == 1:
        gq, gr = select_single_move(state.tree)
        if state.geometry.is_torus:
            return [(gq, gr)]
        return [(gq - state.geometry.off_q, gr - state.geometry.off_r)]

    (g1q, g1r), (g2q, g2r) = select_move_pair(state.tree, temperature=0.1)
    if state.geometry.is_torus:
        return [(g1q, g1r), (g2q, g2r)]
    return [
        (g1q - state.geometry.off_q, g1r - state.geometry.off_r),
        (g2q - state.geometry.off_q, g2r - state.geometry.off_r),
    ]


def _root_child_for_turn(state: SearchState, turn: Turn):
    children = state.tree.root_pos.children or {}
    for s1_idx, s2_idx in _pair_index_candidates(turn, state.geometry):
        child = children.get((s1_idx, s2_idx))
        if child is not None:
            return child
    return None


def _child_for_turn(node, turn: Turn, geometry: SearchGeometry):
    children = node.children or {}
    n_cells = geometry.width * geometry.height
    for s1_idx, s2_idx in _pair_index_candidates(turn, geometry):
        child = children.get(s1_idx * n_cells + s2_idx)
        if child is not None:
            return child
    return None


def _pair_index_candidates(turn: Turn, geometry: SearchGeometry) -> list[tuple[int, int]]:
    stones = [turn, (turn[1], turn[0])]
    indices: list[tuple[int, int]] = []
    for first, second in stones:
        s1_idx = _move_to_index(first[0], first[1], geometry)
        s2_idx = _move_to_index(second[0], second[1], geometry)
        if s1_idx is None or s2_idx is None or s1_idx == s2_idx:
            continue
        pair = (s1_idx, s2_idx)
        if pair not in indices:
            indices.append(pair)
    return indices


def _move_to_index(q: int, r: int, geometry: SearchGeometry) -> int | None:
    if geometry.is_torus:
        return (q % geometry.width) * geometry.width + (r % geometry.width)

    gq = q + geometry.off_q
    gr = r + geometry.off_r
    if gq < 0 or gr < 0 or gq >= geometry.height or gr >= geometry.width:
        return None
    return gq * geometry.width + gr


def _get_or_create_session(
    sessions: OrderedDict[str, KrakenSession],
    cache_key: str,
    turns: list[Turn],
) -> KrakenSession:
    session = sessions.get(cache_key)
    if session is None:
        session = KrakenSession(game=_new_game())
    session.sync_turns(turns)
    sessions[cache_key] = session
    sessions.move_to_end(cache_key)
    return session


def _build_uncached_session(turns: list[Turn]) -> KrakenSession:
    session = KrakenSession(game=_new_game())
    session.sync_turns(turns)
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
                "tree_reuse": True,
            }
        ),
        flush=True,
    )

    sessions: OrderedDict[str, KrakenSession] = OrderedDict()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        cache_key: str | None = None
        try:
            request = json.loads(line)
            turns = _normalize_turns(request)
            mode = str(request.get("mode", "best_move"))
            cache_key = request.get("cache_key") or None
            base_turn_index = int(request.get("base_turn_index", 0))
            advance_session = bool(request.get("advance_session", mode == "best_move"))

            if cache_key is not None:
                if base_turn_index > 0:
                    session = sessions.get(cache_key)
                    if session is None or len(session.turns) != base_turn_index:
                        raise RuntimeError(
                            f"cached Kraken session out of sync for {cache_key!r}: "
                            f"expected {base_turn_index} turns"
                        )
                    session.sync_turns(session.turns + turns)
                    sessions[cache_key] = session
                    sessions.move_to_end(cache_key)
                else:
                    session = _get_or_create_session(sessions, cache_key, turns)
                while len(sessions) > max_cached_games:
                    sessions.popitem(last=False)
            elif base_turn_index != 0:
                raise RuntimeError("base_turn_index requires cache_key")
            else:
                session = _build_uncached_session(turns)

            with move_timeout(move_timeout_ms):
                state = session.ensure_search(bot, n_sims)
                stones = _select_move_for_state(session.game, state)

            if len(stones) != 2:
                raise RuntimeError(f"expected two stones from KrakenBot, got: {stones!r}")
            move = ((int(stones[0][0]), int(stones[0][1])), (int(stones[1][0]), int(stones[1][1])))

            if mode == "eval":
                score = float(getattr(bot, "last_root_value", 0.0))
                win_prob = max(0.0, min(1.0, (score + 1.0) / 2.0))
                response = {
                    "score": score,
                    "win_prob": win_prob,
                    "best_move": [[q, r] for q, r in move],
                }
                if advance_session:
                    session.advance_with_move(move)
            else:
                if advance_session:
                    session.advance_with_move(move)
                response = {"stones": [[q, r] for q, r in move]}
        except Exception as exc:
            if cache_key is not None:
                sessions.pop(cache_key, None)
            response = {"error": str(exc)}
        print(json.dumps(response), flush=True)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
