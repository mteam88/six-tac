use hex_tic_tac_engine::{Cube, Game, Player};
use rustc_hash::{FxHashMap, FxHashSet};
#[cfg(not(target_arch = "wasm32"))]
use serde::Serialize;
use std::collections::HashMap;
use std::hash::Hash;
use std::sync::{Mutex, OnceLock};

use crate::shared::{cube, IndexRng, RuntimeRng};

const ROOT_CANDIDATE_CAP: usize = 16;
const INNER_CANDIDATE_CAP: usize = 11;
const DELTA_WEIGHT: f64 = 1.5;
const MAX_QDEPTH: usize = 16;
const WIN_LENGTH: i32 = 6;
const WIN_SCORE: f64 = 100_000_000.0;

const POSITIVE_DIRS: [Cube; 3] = [cube(1, -1, 0), cube(0, -1, 1), cube(1, 0, -1)];
const ALL_DIRS: [Cube; 6] = [
    cube(1, -1, 0),
    cube(-1, 1, 0),
    cube(0, -1, 1),
    cube(0, 1, -1),
    cube(1, 0, -1),
    cube(-1, 0, 1),
];

const ROOT_PAIRS: &[(usize, usize)] = &[
    (0, 1),
    (0, 2),
    (1, 2),
    (0, 3),
    (0, 4),
    (1, 3),
    (0, 5),
    (1, 4),
    (2, 3),
    (0, 6),
    (1, 5),
    (2, 4),
    (0, 7),
    (1, 6),
    (2, 5),
    (3, 4),
    (0, 8),
    (1, 7),
    (2, 6),
    (3, 5),
    (0, 9),
    (1, 8),
    (2, 7),
    (3, 6),
    (4, 5),
    (0, 10),
    (1, 9),
    (2, 8),
    (3, 7),
    (0, 11),
    (1, 10),
    (2, 9),
    (0, 12),
    (1, 11),
    (0, 13),
    (1, 12),
    (0, 14),
    (0, 15),
];

const INNER_PAIRS: &[(usize, usize)] = &[
    (0, 1),
    (0, 2),
    (0, 3),
    (1, 2),
    (0, 4),
    (1, 3),
    (0, 5),
    (1, 4),
    (2, 3),
    (0, 6),
    (0, 7),
    (0, 8),
    (0, 9),
    (0, 10),
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct WindowKey {
    axis: u8,
    start: Cube,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct EvalWindowKey {
    axis: u8,
    start: Cube,
}

trait PyHashKey: Copy + Eq + Hash {
    fn py_hash(self) -> i64;
}

#[derive(Clone, Debug)]
enum PySetSlot<K> {
    Empty,
    Dummy,
    Occupied { key: K, hash: i64 },
}

#[derive(Clone, Debug)]
struct PySet<K: PyHashKey> {
    slots: Vec<PySetSlot<K>>,
    used: usize,
    fill: usize,
}

impl<K: PyHashKey> PySet<K> {
    fn new() -> Self {
        Self {
            slots: vec![PySetSlot::Empty; 8],
            used: 0,
            fill: 0,
        }
    }

    fn clear(&mut self) {
        self.slots.clear();
        self.slots.resize(8, PySetSlot::Empty);
        self.used = 0;
        self.fill = 0;
    }

    fn is_empty(&self) -> bool {
        self.used == 0
    }

    fn iter(&self) -> impl Iterator<Item = K> + '_ {
        self.slots.iter().filter_map(|slot| match slot {
            PySetSlot::Occupied { key, .. } => Some(*key),
            _ => None,
        })
    }

    fn contains(&self, key: K) -> bool {
        let (_, found) = self.lookup(key, key.py_hash());
        found
    }

    fn insert(&mut self, key: K) {
        self.insert_with_hash(key, key.py_hash());
    }

    fn remove(&mut self, key: K) {
        self.remove_with_hash(key, key.py_hash());
    }

    fn insert_with_hash(&mut self, key: K, hash: i64) {
        let mut free_slot = None;
        let mask = self.slots.len() - 1;
        let mut i = (hash as usize) & mask;
        let mut perturb = hash as usize;
        loop {
            let probes = if i + 9 <= mask { 9 } else { 0 };
            for offset in 0..=probes {
                let index = i + offset;
                match self.slots[index] {
                    PySetSlot::Empty => {
                        let target = free_slot.unwrap_or(index);
                        if free_slot.is_none() {
                            self.fill += 1;
                        }
                        self.slots[target] = PySetSlot::Occupied { key, hash };
                        self.used += 1;
                        if self.fill * 5 >= mask * 3 {
                            let minused = if self.used > 50_000 {
                                self.used * 2
                            } else {
                                self.used * 4
                            };
                            self.resize(minused);
                        }
                        return;
                    }
                    PySetSlot::Dummy => {
                        if free_slot.is_none() {
                            free_slot = Some(index);
                        }
                    }
                    PySetSlot::Occupied {
                        key: existing,
                        hash: existing_hash,
                    } => {
                        if existing_hash == hash && existing == key {
                            return;
                        }
                    }
                }
            }
            perturb >>= 5;
            i = (i * 5 + 1 + perturb) & mask;
        }
    }

    fn remove_with_hash(&mut self, key: K, hash: i64) {
        let (index, found) = self.lookup(key, hash);
        if found {
            self.slots[index] = PySetSlot::Dummy;
            self.used -= 1;
        }
    }

    fn lookup(&self, key: K, hash: i64) -> (usize, bool) {
        let mask = self.slots.len() - 1;
        let mut i = (hash as usize) & mask;
        let mut perturb = hash as usize;
        loop {
            let probes = if i + 9 <= mask { 9 } else { 0 };
            for offset in 0..=probes {
                let index = i + offset;
                match self.slots[index] {
                    PySetSlot::Empty => return (index, false),
                    PySetSlot::Dummy => {}
                    PySetSlot::Occupied {
                        key: existing,
                        hash: existing_hash,
                    } => {
                        if existing_hash == hash && existing == key {
                            return (index, true);
                        }
                    }
                }
            }
            perturb >>= 5;
            i = (i * 5 + 1 + perturb) & mask;
        }
    }

    fn resize(&mut self, minused: usize) {
        let mut newsize = 8usize;
        while newsize <= minused {
            newsize <<= 1;
        }
        let old_slots = std::mem::replace(&mut self.slots, vec![PySetSlot::Empty; newsize]);
        self.fill = self.used;
        self.used = 0;
        for slot in old_slots {
            if let PySetSlot::Occupied { key, hash } = slot {
                self.insert_clean(key, hash);
                self.used += 1;
            }
        }
    }

    fn insert_clean(&mut self, key: K, hash: i64) {
        let mask = self.slots.len() - 1;
        let mut i = (hash as usize) & mask;
        let mut perturb = hash as usize;
        loop {
            if matches!(self.slots[i], PySetSlot::Empty) {
                self.slots[i] = PySetSlot::Occupied { key, hash };
                return;
            }
            if i + 9 <= mask {
                for step in 1..=9 {
                    let index = i + step;
                    if matches!(self.slots[index], PySetSlot::Empty) {
                        self.slots[index] = PySetSlot::Occupied { key, hash };
                        return;
                    }
                }
            }
            perturb >>= 5;
            i = (i * 5 + 1 + perturb) & mask;
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct TtKey {
    hash: u64,
    current_player: Player,
    moves_left_in_turn: u8,
}

#[derive(Clone, Copy, Debug)]
struct TtEntry {
    depth: usize,
    score: f64,
    flag: TtFlag,
    best_move: Option<[Cube; 2]>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TtFlag {
    Exact,
    Lower,
    Upper,
}

#[derive(Clone, Debug)]
struct SearchGame {
    board: FxHashMap<Cube, Player>,
    stone_order: Vec<Cube>,
    current_player: Player,
    moves_left_in_turn: u8,
    winner: Option<Player>,
    game_over: bool,
    move_count: usize,
}

#[derive(Clone, Copy, Debug)]
struct SavedState {
    current_player: Player,
    moves_left_in_turn: u8,
    winner: Option<Player>,
    game_over: bool,
}

#[derive(Clone, Debug)]
struct SealSearch {
    root_game: SearchGame,
    root_player: Player,
    tt: FxHashMap<TtKey, TtEntry>,
    hash: u64,
    rc_stack: Vec<usize>,
    history: FxHashMap<Cube, i32>,
    wc: FxHashMap<WindowKey, [u8; 2]>,
    wc_order: Vec<WindowKey>,
    hot_one: PySet<WindowKey>,
    hot_two: PySet<WindowKey>,
    wp: FxHashMap<EvalWindowKey, i32>,
    eval_score: f64,
    cand_refcount: FxHashMap<Cube, usize>,
    cand_set: PySet<Cube>,
}

#[cfg(not(target_arch = "wasm32"))]
#[derive(Serialize)]
pub(crate) struct SealDebugTurn {
    stones: [Cube; 2],
    score: f64,
}

#[cfg(not(target_arch = "wasm32"))]
#[derive(Serialize)]
pub(crate) struct SealDebugReport {
    best: [Cube; 2],
    candidates: Vec<Cube>,
    initial_turns: Vec<[Cube; 2]>,
    turns: Vec<SealDebugTurn>,
}

pub(crate) fn choose_seal_move(game: &Game) -> Result<[Cube; 2], String> {
    let mut search = SealSearch::new(game);
    Ok(search.choose_move())
}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn debug_seal_root(game: &Game) -> Result<SealDebugReport, String> {
    let mut search = SealSearch::new(game);
    let mut probe = search.root_game.clone();
    let mut candidates = search.cand_set.iter().collect::<Vec<_>>();
    candidates.sort_unstable_by(|a, b| {
        let da = search.move_delta(*a, probe.current_player);
        let db = search.move_delta(*b, probe.current_player);
        db.partial_cmp(&da).unwrap_or(std::cmp::Ordering::Equal)
    });
    let turns = search.generate_turns(&probe);
    if turns.is_empty() {
        return Err("seal could not find a legal move".to_string());
    }
    let (best, scores) = search.search_root(&mut probe, &turns, 3);
    let mut report_turns = turns
        .iter()
        .copied()
        .map(|stones| SealDebugTurn {
            stones,
            score: scores.get(&stones).copied().unwrap_or(0.0),
        })
        .collect::<Vec<_>>();
    report_turns.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| pair_key(a.stones).cmp(&pair_key(b.stones)))
    });
    Ok(SealDebugReport {
        best,
        candidates,
        initial_turns: turns,
        turns: report_turns,
    })
}

impl SearchGame {
    fn from_game(game: &Game) -> Self {
        let mut board = FxHashMap::default();
        let mut stone_order = Vec::with_capacity(game.stone_count() as usize);
        board.insert(Cube::ORIGIN, Player::One);
        stone_order.push(Cube::ORIGIN);
        for (turn_index, turn) in game.turns().enumerate() {
            let player = if turn_index % 2 == 0 { Player::Two } else { Player::One };
            for coord in turn.stones {
                board.insert(coord, player);
                stone_order.push(coord);
            }
        }
        Self {
            board,
            stone_order,
            current_player: game.current_player(),
            moves_left_in_turn: 2,
            winner: game.winner(),
            game_over: game.winner().is_some(),
            move_count: game.stone_count() as usize,
        }
    }
}

impl SealSearch {
    fn new(game: &Game) -> Self {
        let search_game = SearchGame::from_game(game);
        let root_player = search_game.current_player;
        let mut search = Self {
            root_game: search_game.clone(),
            root_player,
            tt: FxHashMap::default(),
            hash: 0,
            rc_stack: Vec::new(),
            history: FxHashMap::default(),
            wc: FxHashMap::default(),
            wc_order: Vec::new(),
            hot_one: PySet::new(),
            hot_two: PySet::new(),
            wp: FxHashMap::default(),
            eval_score: 0.0,
            cand_refcount: FxHashMap::default(),
            cand_set: PySet::new(),
        };
        search.rebuild(&search_game);
        search
    }

    fn choose_move(&mut self) -> [Cube; 2] {
        let mut game = self.root_game.clone();

        let turns = self.generate_turns(&game);
        if turns.is_empty() {
            return [Cube::ORIGIN, Cube::ORIGIN];
        }

        let mut ordered_turns = turns;
        let mut best_move = ordered_turns[0];

        for depth in 1..=3 {
            let (result, scores) = self.search_root(&mut game, &ordered_turns, depth);
            best_move = result;
            let maximizing = game.current_player == self.root_player;
            ordered_turns.sort_by(|a, b| {
                let sa = scores.get(a).copied().unwrap_or(0.0);
                let sb = scores.get(b).copied().unwrap_or(0.0);
                if maximizing {
                    sb.partial_cmp(&sa).unwrap_or(std::cmp::Ordering::Equal)
                } else {
                    sa.partial_cmp(&sb).unwrap_or(std::cmp::Ordering::Equal)
                }
            });
            if scores.get(&result).copied().unwrap_or(0.0).abs() >= WIN_SCORE {
                break;
            }
        }

        best_move
    }

    fn rebuild(&mut self, game: &SearchGame) {
        self.hash = 0;
        self.rc_stack.clear();
        self.wc.clear();
        self.wc_order.clear();
        self.hot_one.clear();
        self.hot_two.clear();
        self.wp.clear();
        self.eval_score = 0.0;
        self.cand_refcount.clear();
        self.cand_set.clear();

        let mut seen6 = FxHashSet::default();
        let mut seen_eval = FxHashSet::default();
        let pattern_values = pattern_values();
        let pow3 = pow3();

        for &coord in &game.stone_order {
            let player = game.board[&coord];
            self.hash ^= zobrist(coord, player);

            for (axis, dir) in POSITIVE_DIRS.into_iter().enumerate() {
                for k in 0..WIN_LENGTH {
                    let start = offset(coord, scale(negate(dir), k));
                    let wkey = WindowKey {
                        axis: axis as u8,
                        start,
                    };
                    if !seen6.insert(wkey) {
                        continue;
                    }
                    let mut one_count = 0u8;
                    let mut two_count = 0u8;
                    for step in 0..WIN_LENGTH {
                        let cell = offset(start, scale(dir, step));
                        match game.board.get(&cell) {
                            Some(Player::One) => one_count += 1,
                            Some(Player::Two) => two_count += 1,
                            None => {}
                        }
                    }
                    if one_count > 0 || two_count > 0 {
                        if self.wc.insert(wkey, [one_count, two_count]).is_none() {
                            self.wc_order.push(wkey);
                        }
                    }
                }

                for k in 0..WIN_LENGTH {
                    let start = offset(coord, scale(negate(dir), k));
                    let wkey = EvalWindowKey {
                        axis: axis as u8,
                        start,
                    };
                    if !seen_eval.insert(wkey) {
                        continue;
                    }
                    let mut pat_int = 0i32;
                    let mut has_piece = false;
                    for j in 0..WIN_LENGTH {
                        let cell = offset(start, scale(dir, j));
                        match game.board.get(&cell) {
                            Some(player) => {
                                pat_int += cell_value(*player, self.root_player) * pow3[j as usize];
                                has_piece = true;
                            }
                            None => {}
                        }
                    }
                    if has_piece {
                        self.wp.insert(wkey, pat_int);
                        self.eval_score += pattern_values[pat_int as usize];
                    }
                }
            }
        }

        for &wkey in &self.wc_order {
            let counts = self.wc[&wkey];
            if counts[0] >= 4 {
                self.hot_one.insert(wkey);
            }
            if counts[1] >= 4 {
                self.hot_two.insert(wkey);
            }
        }

        let mut candidate_order = Vec::new();
        for &coord in &game.stone_order {
            for &dir in neighbor_offsets() {
                let neighbor = offset(coord, dir);
                if game.board.contains_key(&neighbor) {
                    continue;
                }
                let entry = self.cand_refcount.entry(neighbor).or_insert(0);
                if *entry == 0 {
                    candidate_order.push(neighbor);
                }
                *entry += 1;
            }
        }
        for coord in candidate_order {
            self.cand_set.insert(coord);
        }
    }

    fn tt_key(&self, game: &SearchGame) -> TtKey {
        TtKey {
            hash: self.hash,
            current_player: game.current_player,
            moves_left_in_turn: game.moves_left_in_turn,
        }
    }

    fn move_delta(&self, coord: Cube, player: Player) -> f64 {
        let pattern_values = pattern_values();
        let pow3 = pow3();
        let cell_val = cell_value(player, self.root_player);
        let mut delta = 0.0;

        for (axis, dir) in POSITIVE_DIRS.into_iter().enumerate() {
            for k in 0..WIN_LENGTH {
                let start = offset(coord, scale(negate(dir), k));
                let wkey = EvalWindowKey {
                    axis: axis as u8,
                    start,
                };
                let old_pi = self.wp.get(&wkey).copied().unwrap_or(0);
                let new_pi = old_pi + cell_val * pow3[k as usize];
                delta += pattern_values[new_pi as usize] - pattern_values[old_pi as usize];
            }
        }

        delta
    }

    fn find_instant_win(&self, game: &SearchGame, player: Player) -> Option<[Cube; 2]> {
        let hot = self.hot_windows(player);
        for wkey in hot.iter() {
            let counts = self.wc.get(&wkey).copied().unwrap_or([0, 0]);
            let (p_idx, o_idx) = player_indices(player);
            if counts[p_idx] < (WIN_LENGTH - 2) as u8 || counts[o_idx] != 0 {
                continue;
            }
            let dir = POSITIVE_DIRS[wkey.axis as usize];
            let mut empties = Vec::with_capacity(2);
            for j in 0..WIN_LENGTH {
                let cell = offset(wkey.start, scale(dir, j));
                if !game.board.contains_key(&cell) {
                    empties.push(cell);
                }
            }
            match empties.len() {
                1 => {
                    let win_cell = empties[0];
                    let other = self
                        .cand_set
                        .iter()
                        .find(|&coord| coord != win_cell)
                        .unwrap_or(win_cell);
                    return Some(python_order_pair(win_cell, other));
                }
                2 => return Some(python_order_pair(empties[0], empties[1])),
                _ => {}
            }
        }
        None
    }

    fn find_threat_cells(&self, game: &SearchGame, player: Player) -> PySet<Cube> {
        let mut threat_cells = PySet::new();
        let hot = self.hot_windows(player);
        let (p_idx, o_idx) = player_indices(player);

        for wkey in hot.iter() {
            let counts = self.wc.get(&wkey).copied().unwrap_or([0, 0]);
            if counts[o_idx] != 0 || counts[p_idx] < 4 {
                continue;
            }
            let dir = POSITIVE_DIRS[wkey.axis as usize];
            for j in 0..WIN_LENGTH {
                let cell = offset(wkey.start, scale(dir, j));
                if !game.board.contains_key(&cell) {
                    threat_cells.insert(cell);
                }
            }
        }

        threat_cells
    }

    fn filter_turns_by_threats(
        &self,
        game: &SearchGame,
        turns: Vec<[Cube; 2]>,
    ) -> Vec<[Cube; 2]> {
        let opponent = game.current_player.other();
        let hot = self.hot_windows(opponent);
        let (p_idx, o_idx) = player_indices(opponent);
        let mut must_hit = Vec::new();

        for wkey in hot.iter() {
            let counts = self.wc.get(&wkey).copied().unwrap_or([0, 0]);
            if counts[p_idx] < (WIN_LENGTH - 2) as u8 || counts[o_idx] != 0 {
                continue;
            }
            let dir = POSITIVE_DIRS[wkey.axis as usize];
            let empties = (0..WIN_LENGTH)
                .map(|j| offset(wkey.start, scale(dir, j)))
                .filter(|cell| !game.board.contains_key(cell))
                .collect::<FxHashSet<_>>();
            must_hit.push(empties);
        }

        if must_hit.is_empty() {
            return turns;
        }

        turns
            .into_iter()
            .filter(|turn| must_hit.iter().all(|window| window.contains(&turn[0]) || window.contains(&turn[1])))
            .collect()
    }

    fn make(&mut self, game: &mut SearchGame, coord: Cube) {
        let player = game.current_player;
        let state = self.cand_refcount.remove(&coord).unwrap_or(0);
        self.rc_stack.push(state);
        self.cand_set.remove(coord);
        self.hash ^= zobrist(coord, player);

        let cell_val = cell_value(player, self.root_player);
        let pattern_values = pattern_values();
        let pow3 = pow3();

        let mut won = false;
        for (axis, dir) in POSITIVE_DIRS.into_iter().enumerate() {
            for k in 0..WIN_LENGTH {
                let start = offset(coord, scale(negate(dir), k));
                let wkey = WindowKey {
                    axis: axis as u8,
                    start,
                };
                let p_idx = player_index(player);
                let is_new = !self.wc.contains_key(&wkey);
                let (became_hot, is_win) = {
                    let counts = self.wc.entry(wkey).or_insert([0, 0]);
                    counts[p_idx] += 1;
                    (
                        counts[p_idx] >= 4,
                        counts[p_idx] == WIN_LENGTH as u8 && counts[1 - p_idx] == 0,
                    )
                };
                if is_new {
                    self.wc_order.push(wkey);
                }
                if became_hot {
                    self.hot_windows_mut(player).insert(wkey);
                }
                if is_win {
                    won = true;
                }
            }

            for k in 0..WIN_LENGTH {
                let start = offset(coord, scale(negate(dir), k));
                let wkey = EvalWindowKey {
                    axis: axis as u8,
                    start,
                };
                let old_pi = self.wp.get(&wkey).copied().unwrap_or(0);
                let new_pi = old_pi + cell_val * pow3[k as usize];
                self.eval_score += pattern_values[new_pi as usize] - pattern_values[old_pi as usize];
                self.wp.insert(wkey, new_pi);
            }
        }

        for &delta in neighbor_offsets() {
            let neighbor = offset(coord, delta);
            *self.cand_refcount.entry(neighbor).or_insert(0) += 1;
            if !game.board.contains_key(&neighbor) {
                self.cand_set.insert(neighbor);
            }
        }

        game.board.insert(coord, player);
        game.stone_order.push(coord);
        game.move_count += 1;
        if won {
            game.winner = Some(player);
            game.game_over = true;
        } else {
            game.moves_left_in_turn -= 1;
            if game.moves_left_in_turn == 0 {
                game.current_player = player.other();
                game.moves_left_in_turn = 2;
            }
        }
    }

    fn undo(&mut self, game: &mut SearchGame, coord: Cube, state: SavedState, player: Player) {
        game.board.remove(&coord);
        let popped = game.stone_order.pop();
        debug_assert_eq!(popped, Some(coord));
        game.move_count -= 1;
        game.current_player = state.current_player;
        game.moves_left_in_turn = state.moves_left_in_turn;
        game.winner = state.winner;
        game.game_over = state.game_over;

        self.hash ^= zobrist(coord, player);

        let cell_val = cell_value(player, self.root_player);
        let pattern_values = pattern_values();
        let pow3 = pow3();

        for (axis, dir) in POSITIVE_DIRS.into_iter().enumerate() {
            for k in 0..WIN_LENGTH {
                let start = offset(coord, scale(negate(dir), k));
                let wkey = WindowKey {
                    axis: axis as u8,
                    start,
                };
                let mut remove_window = false;
                let mut remove_hot = false;
                if let Some(counts) = self.wc.get_mut(&wkey) {
                    let p_idx = player_index(player);
                    counts[p_idx] -= 1;
                    remove_hot = counts[p_idx] < 4;
                    remove_window = counts[0] == 0 && counts[1] == 0;
                }
                if remove_hot {
                    self.hot_windows_mut(player).remove(wkey);
                }
                if remove_window {
                    self.wc.remove(&wkey);
                }
            }

            for k in 0..WIN_LENGTH {
                let start = offset(coord, scale(negate(dir), k));
                let wkey = EvalWindowKey {
                    axis: axis as u8,
                    start,
                };
                if let Some(old_pi) = self.wp.get(&wkey).copied() {
                    let new_pi = old_pi - cell_val * pow3[k as usize];
                    self.eval_score += pattern_values[new_pi as usize] - pattern_values[old_pi as usize];
                    if new_pi == 0 {
                        self.wp.remove(&wkey);
                    } else {
                        self.wp.insert(wkey, new_pi);
                    }
                }
            }
        }

        for &delta in neighbor_offsets() {
            let neighbor = offset(coord, delta);
            if let Some(count) = self.cand_refcount.get_mut(&neighbor) {
                *count -= 1;
                if *count == 0 {
                    self.cand_refcount.remove(&neighbor);
                    self.cand_set.remove(neighbor);
                }
            }
        }

        let saved_rc = self.rc_stack.pop().unwrap_or(0);
        if saved_rc > 0 {
            self.cand_refcount.insert(coord, saved_rc);
            self.cand_set.insert(coord);
        }
    }

    fn make_turn(&mut self, game: &mut SearchGame, turn: [Cube; 2]) -> Vec<(Cube, SavedState, Player)> {
        let mut undo_info = Vec::with_capacity(2);
        let first_player = game.current_player;
        let first_state = SavedState {
            current_player: game.current_player,
            moves_left_in_turn: game.moves_left_in_turn,
            winner: game.winner,
            game_over: game.game_over,
        };
        self.make(game, turn[0]);
        undo_info.push((turn[0], first_state, first_player));
        if game.game_over {
            return undo_info;
        }

        let second_player = game.current_player;
        let second_state = SavedState {
            current_player: game.current_player,
            moves_left_in_turn: game.moves_left_in_turn,
            winner: game.winner,
            game_over: game.game_over,
        };
        self.make(game, turn[1]);
        undo_info.push((turn[1], second_state, second_player));
        undo_info
    }

    fn undo_turn(&mut self, game: &mut SearchGame, undo_info: Vec<(Cube, SavedState, Player)>) {
        for (coord, state, player) in undo_info.into_iter().rev() {
            self.undo(game, coord, state, player);
        }
    }

    fn generate_turns(&mut self, game: &SearchGame) -> Vec<[Cube; 2]> {
        if let Some(win_turn) = self.find_instant_win(game, game.current_player) {
            return vec![win_turn];
        }

        let mut candidates = self.cand_set.iter().collect::<Vec<_>>();
        if candidates.len() < 2 {
            return if let Some(&coord) = candidates.first() {
                vec![[coord, coord]]
            } else {
                Vec::new()
            };
        }

        let maximizing = game.current_player == self.root_player;
        candidates.sort_by(|a, b| {
            let da = self.move_delta(*a, game.current_player);
            let db = self.move_delta(*b, game.current_player);
            if maximizing {
                db.partial_cmp(&da).unwrap_or(std::cmp::Ordering::Equal)
            } else {
                da.partial_cmp(&db).unwrap_or(std::cmp::Ordering::Equal)
            }
        });
        candidates.truncate(ROOT_CANDIDATE_CAP);

        if !game.board.is_empty() {
            let count = game.stone_order.len() as i32;
            let cq = game.stone_order.iter().map(|coord| coord.x()).sum::<i32>() / count;
            let cr = game.stone_order.iter().map(|coord| coord.z()).sum::<i32>() / count;
            let center = Cube::from_axial(cq, cr);
            let max_r = game
                .stone_order
                .iter()
                .map(|coord| coord.distance(center) as i32)
                .max()
                .unwrap_or(0);
            let colony_dist = max_r + 3;
            let mut rng = RuntimeRng::new();
            let dir = ALL_DIRS[rng.index(ALL_DIRS.len())];
            let colony = offset(center, scale(dir, colony_dist));
            if !game.board.contains_key(&colony) {
                candidates.push(colony);
            }
        }

        let n = candidates.len();
        let turns = ROOT_PAIRS
            .iter()
            .copied()
            .filter(|&(i, j)| i < n && j < n)
            .map(|(i, j)| [candidates[i], candidates[j]])
            .collect::<Vec<_>>();
        self.filter_turns_by_threats(game, turns)
    }

    fn generate_threat_turns(
        &self,
        game: &SearchGame,
        my_threats: &PySet<Cube>,
        opp_threats: &PySet<Cube>,
    ) -> Vec<[Cube; 2]> {
        if let Some(win_turn) = self.find_instant_win(game, game.current_player) {
            return vec![win_turn];
        }

        let maximizing = game.current_player == self.root_player;
        let sign = if maximizing { 1.0 } else { -1.0 };

        let opp_cells = opp_threats
            .iter()
            .filter(|coord| self.cand_set.contains(*coord))
            .collect::<Vec<_>>();
        let my_cells = my_threats
            .iter()
            .filter(|coord| self.cand_set.contains(*coord))
            .collect::<Vec<_>>();

        let primary = if !opp_cells.is_empty() {
            opp_cells
        } else if !my_cells.is_empty() {
            my_cells
        } else {
            return Vec::new();
        };

        if primary.len() >= 2 {
            let mut pairs = Vec::new();
            for first in 0..primary.len() {
                for second in (first + 1)..primary.len() {
                    pairs.push([primary[first], primary[second]]);
                }
            }
            pairs.sort_by(|a, b| {
                let sa = self.move_delta(a[0], game.current_player) + self.move_delta(a[1], game.current_player);
                let sb = self.move_delta(b[0], game.current_player) + self.move_delta(b[1], game.current_player);
                if maximizing {
                    sb.partial_cmp(&sa).unwrap_or(std::cmp::Ordering::Equal)
                } else {
                    sa.partial_cmp(&sb).unwrap_or(std::cmp::Ordering::Equal)
                }
            });
            return pairs;
        }

        let threat_cell = primary[0];
        let mut best_companion = None;
        let mut best_delta = f64::NEG_INFINITY;
        for coord in self.cand_set.iter() {
            if coord == threat_cell {
                continue;
            }
            let delta = self.move_delta(coord, game.current_player) * sign;
            if delta > best_delta {
                best_delta = delta;
                best_companion = Some(coord);
            }
        }

        best_companion
            .map(|coord| vec![python_order_pair(threat_cell, coord)])
            .unwrap_or_default()
    }

    fn quiescence(&mut self, game: &mut SearchGame, mut alpha: f64, mut beta: f64, qdepth: usize) -> f64 {
        if game.game_over {
            return match game.winner {
                Some(winner) if winner == self.root_player => WIN_SCORE,
                Some(_) => -WIN_SCORE,
                None => 0.0,
            };
        }

        if let Some(win_turn) = self.find_instant_win(game, game.current_player) {
            let undo_info = self.make_turn(game, win_turn);
            let score = if game.winner == Some(self.root_player) {
                WIN_SCORE
            } else {
                -WIN_SCORE
            };
            self.undo_turn(game, undo_info);
            return score;
        }

        let stand_pat = self.eval_score;
        let current = game.current_player;
        let opponent = current.other();
        let my_threats = self.find_threat_cells(game, current);
        let opp_threats = self.find_threat_cells(game, opponent);

        if (my_threats.is_empty() && opp_threats.is_empty()) || qdepth == 0 {
            return stand_pat;
        }

        let maximizing = current == self.root_player;
        if maximizing {
            if stand_pat >= beta {
                return stand_pat;
            }
            alpha = alpha.max(stand_pat);
        } else {
            if stand_pat <= alpha {
                return stand_pat;
            }
            beta = beta.min(stand_pat);
        }

        let threat_turns = self.generate_threat_turns(game, &my_threats, &opp_threats);
        if threat_turns.is_empty() {
            return stand_pat;
        }

        if maximizing {
            let mut value = stand_pat;
            for turn in threat_turns {
                let undo_info = self.make_turn(game, turn);
                let child_val = if game.game_over {
                    if game.winner == Some(self.root_player) {
                        WIN_SCORE
                    } else {
                        -WIN_SCORE
                    }
                } else {
                    self.quiescence(game, alpha, beta, qdepth - 1)
                };
                self.undo_turn(game, undo_info);
                if child_val > value {
                    value = child_val;
                }
                alpha = alpha.max(value);
                if alpha >= beta {
                    break;
                }
            }
            value
        } else {
            let mut value = stand_pat;
            for turn in threat_turns {
                let undo_info = self.make_turn(game, turn);
                let child_val = if game.game_over {
                    if game.winner == Some(self.root_player) {
                        WIN_SCORE
                    } else {
                        -WIN_SCORE
                    }
                } else {
                    self.quiescence(game, alpha, beta, qdepth - 1)
                };
                self.undo_turn(game, undo_info);
                if child_val < value {
                    value = child_val;
                }
                beta = beta.min(value);
                if alpha >= beta {
                    break;
                }
            }
            value
        }
    }

    fn search_root(
        &mut self,
        game: &mut SearchGame,
        turns: &[[Cube; 2]],
        depth: usize,
    ) -> ([Cube; 2], FxHashMap<[Cube; 2], f64>) {
        let maximizing = game.current_player == self.root_player;
        let mut best_turn = turns[0];
        let mut alpha = f64::NEG_INFINITY;
        let mut beta = f64::INFINITY;
        let mut scores = FxHashMap::default();

        for &turn in turns {
            let undo_info = self.make_turn(game, turn);
            let score = if game.game_over {
                if game.winner == Some(self.root_player) {
                    WIN_SCORE
                } else {
                    -WIN_SCORE
                }
            } else {
                self.minimax(game, depth - 1, alpha, beta)
            };
            self.undo_turn(game, undo_info);
            scores.insert(turn, score);

            if maximizing && score > alpha {
                alpha = score;
                best_turn = turn;
            } else if !maximizing && score < beta {
                beta = score;
                best_turn = turn;
            }
        }

        let best_score = if maximizing { alpha } else { beta };
        self.tt.insert(
            self.tt_key(game),
            TtEntry {
                depth,
                score: best_score,
                flag: TtFlag::Exact,
                best_move: Some(best_turn),
            },
        );
        (best_turn, scores)
    }

    fn minimax(&mut self, game: &mut SearchGame, depth: usize, mut alpha: f64, mut beta: f64) -> f64 {
        if game.game_over {
            return match game.winner {
                Some(winner) if winner == self.root_player => WIN_SCORE,
                Some(_) => -WIN_SCORE,
                None => 0.0,
            };
        }

        let tt_key = self.tt_key(game);
        let mut tt_move = None;
        if let Some(entry) = self.tt.get(&tt_key).copied() {
            tt_move = entry.best_move;
            if entry.depth >= depth {
                match entry.flag {
                    TtFlag::Exact => return entry.score,
                    TtFlag::Lower => alpha = alpha.max(entry.score),
                    TtFlag::Upper => beta = beta.min(entry.score),
                }
                if alpha >= beta {
                    return entry.score;
                }
            }
        }

        if depth == 0 {
            let score = self.quiescence(game, alpha, beta, MAX_QDEPTH);
            self.tt.insert(
                tt_key,
                TtEntry {
                    depth: 0,
                    score,
                    flag: TtFlag::Exact,
                    best_move: None,
                },
            );
            return score;
        }

        if let Some(win_turn) = self.find_instant_win(game, game.current_player) {
            let undo_info = self.make_turn(game, win_turn);
            let score = if game.winner == Some(self.root_player) {
                WIN_SCORE
            } else {
                -WIN_SCORE
            };
            self.undo_turn(game, undo_info);
            self.tt.insert(
                tt_key,
                TtEntry {
                    depth,
                    score,
                    flag: TtFlag::Exact,
                    best_move: Some(win_turn),
                },
            );
            return score;
        }

        let opponent = game.current_player.other();
        if self.find_instant_win(game, opponent).is_some() {
            let hot = self.hot_windows(opponent);
            let (p_idx, o_idx) = player_indices(opponent);
            let mut must_hit = Vec::new();
            for wkey in hot.iter() {
                let counts = self.wc.get(&wkey).copied().unwrap_or([0, 0]);
                if counts[p_idx] < (WIN_LENGTH - 2) as u8 || counts[o_idx] != 0 {
                    continue;
                }
                let dir = POSITIVE_DIRS[wkey.axis as usize];
                let empties = (0..WIN_LENGTH)
                    .map(|j| offset(wkey.start, scale(dir, j)))
                    .filter(|cell| !game.board.contains_key(cell))
                    .collect::<FxHashSet<_>>();
                must_hit.push(empties);
            }
            if must_hit.len() > 1 {
                let all_cells = must_hit
                    .iter()
                    .flat_map(|cells| cells.iter().copied())
                    .collect::<FxHashSet<_>>();
                let mut can_block = false;
                'outer: for &a in &all_cells {
                    for &b in &all_cells {
                        if must_hit.iter().all(|window| window.contains(&a) || window.contains(&b)) {
                            can_block = true;
                            break 'outer;
                        }
                    }
                }
                if !can_block {
                    let score = if opponent == self.root_player {
                        WIN_SCORE
                    } else {
                        -WIN_SCORE
                    };
                    self.tt.insert(
                        tt_key,
                        TtEntry {
                            depth,
                            score,
                            flag: TtFlag::Exact,
                            best_move: None,
                        },
                    );
                    return score;
                }
            }
        }

        let orig_alpha = alpha;
        let orig_beta = beta;
        let maximizing = game.current_player == self.root_player;

        let mut candidates = self.cand_set.iter().collect::<Vec<_>>();
        let mut turns = if candidates.len() < 2 {
            if candidates.is_empty() {
                self.tt.insert(
                    tt_key,
                    TtEntry {
                        depth,
                        score: self.eval_score,
                        flag: TtFlag::Exact,
                        best_move: None,
                    },
                );
                return self.eval_score;
            }
            let coord = candidates[0];
            vec![[coord, coord]]
        } else {
            candidates.sort_by(|a, b| {
                let ka = self.history.get(a).copied().unwrap_or(0) as f64
                    + self.move_delta(*a, game.current_player)
                        * if maximizing { DELTA_WEIGHT } else { -DELTA_WEIGHT };
                let kb = self.history.get(b).copied().unwrap_or(0) as f64
                    + self.move_delta(*b, game.current_player)
                        * if maximizing { DELTA_WEIGHT } else { -DELTA_WEIGHT };
                kb.partial_cmp(&ka).unwrap_or(std::cmp::Ordering::Equal)
            });
            candidates.truncate(INNER_CANDIDATE_CAP);
            let n = candidates.len();
            let turns = INNER_PAIRS
                .iter()
                .copied()
                .filter(|&(i, j)| i < n && j < n)
                .map(|(i, j)| [candidates[i], candidates[j]])
                .collect::<Vec<_>>();
            self.filter_turns_by_threats(game, turns)
        };

        if turns.is_empty() {
            self.tt.insert(
                tt_key,
                TtEntry {
                    depth,
                    score: self.eval_score,
                    flag: TtFlag::Exact,
                    best_move: None,
                },
            );
            return self.eval_score;
        }

        if let Some(tt_move) = tt_move {
            if let Some(index) = turns.iter().position(|turn| *turn == tt_move) {
                turns.swap(0, index);
            }
        }

        let mut best_move = None;
        let value = if maximizing {
            let mut value = f64::NEG_INFINITY;
            for turn in turns {
                let undo_info = self.make_turn(game, turn);
                let child_val = if game.game_over {
                    if game.winner == Some(self.root_player) {
                        WIN_SCORE
                    } else {
                        -WIN_SCORE
                    }
                } else {
                    self.minimax(game, depth - 1, alpha, beta)
                };
                self.undo_turn(game, undo_info);
                if child_val > value {
                    value = child_val;
                    best_move = Some(turn);
                }
                alpha = alpha.max(value);
                if alpha >= beta {
                    *self.history.entry(turn[0]).or_insert(0) += (depth * depth) as i32;
                    *self.history.entry(turn[1]).or_insert(0) += (depth * depth) as i32;
                    break;
                }
            }
            value
        } else {
            let mut value = f64::INFINITY;
            for turn in turns {
                let undo_info = self.make_turn(game, turn);
                let child_val = if game.game_over {
                    if game.winner == Some(self.root_player) {
                        WIN_SCORE
                    } else {
                        -WIN_SCORE
                    }
                } else {
                    self.minimax(game, depth - 1, alpha, beta)
                };
                self.undo_turn(game, undo_info);
                if child_val < value {
                    value = child_val;
                    best_move = Some(turn);
                }
                beta = beta.min(value);
                if alpha >= beta {
                    *self.history.entry(turn[0]).or_insert(0) += (depth * depth) as i32;
                    *self.history.entry(turn[1]).or_insert(0) += (depth * depth) as i32;
                    break;
                }
            }
            value
        };

        let flag = if value <= orig_alpha {
            TtFlag::Upper
        } else if value >= orig_beta {
            TtFlag::Lower
        } else {
            TtFlag::Exact
        };
        self.tt.insert(
            tt_key,
            TtEntry {
                depth,
                score: value,
                flag,
                best_move,
            },
        );
        value
    }

    fn hot_windows(&self, player: Player) -> &PySet<WindowKey> {
        match player {
            Player::One => &self.hot_one,
            Player::Two => &self.hot_two,
        }
    }

    fn hot_windows_mut(&mut self, player: Player) -> &mut PySet<WindowKey> {
        match player {
            Player::One => &mut self.hot_one,
            Player::Two => &mut self.hot_two,
        }
    }
}

impl PyHashKey for Cube {
    fn py_hash(self) -> i64 {
        py_tuple_hash(&[self.x() as i64, self.z() as i64])
    }
}

impl PyHashKey for WindowKey {
    fn py_hash(self) -> i64 {
        py_tuple_hash(&[self.axis as i64, self.start.x() as i64, self.start.z() as i64])
    }
}

fn player_index(player: Player) -> usize {
    match player {
        Player::One => 0,
        Player::Two => 1,
    }
}

fn player_indices(player: Player) -> (usize, usize) {
    let p_idx = player_index(player);
    (p_idx, 1 - p_idx)
}

fn cell_value(player: Player, root_player: Player) -> i32 {
    if player == root_player {
        1
    } else {
        2
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn cube_key(coord: Cube) -> (i32, i32, i32) {
    (coord.x(), coord.y(), coord.z())
}

#[cfg(not(target_arch = "wasm32"))]
fn pair_key(pair: [Cube; 2]) -> ((i32, i32, i32), (i32, i32, i32)) {
    (cube_key(pair[0]), cube_key(pair[1]))
}

fn py_int_hash(value: i64) -> i64 {
    if value == -1 { -2 } else { value }
}

fn py_tuple_hash(values: &[i64]) -> i64 {
    const PRIME_1: u64 = 11_400_714_785_074_694_791;
    const PRIME_2: u64 = 14_029_467_366_897_019_727;
    const PRIME_5: u64 = 2_870_177_450_012_600_261;

    let mut acc = PRIME_5;
    for &value in values {
        let lane = py_int_hash(value) as u64;
        acc = acc.wrapping_add(lane.wrapping_mul(PRIME_2));
        acc = acc.rotate_left(31);
        acc = acc.wrapping_mul(PRIME_1);
    }
    acc = acc.wrapping_add((values.len() as u64) ^ (PRIME_5 ^ 3_527_539));
    let mut hash = acc as i64;
    if hash == -1 {
        hash = 1_546_275_796;
    }
    hash
}

fn python_order_pair(a: Cube, b: Cube) -> [Cube; 2] {
    if (a.x(), a.z()) <= (b.x(), b.z()) {
        [a, b]
    } else {
        [b, a]
    }
}

fn offset(base: Cube, delta: Cube) -> Cube {
    cube(base.x() + delta.x(), base.y() + delta.y(), base.z() + delta.z())
}

fn scale(delta: Cube, factor: i32) -> Cube {
    cube(delta.x() * factor, delta.y() * factor, delta.z() * factor)
}

fn negate(delta: Cube) -> Cube {
    cube(-delta.x(), -delta.y(), -delta.z())
}

fn zobrist(coord: Cube, player: Player) -> u64 {
    let key = (coord.x(), coord.z(), player_index(player) as u8);
    let state = zobrist_state();
    let mut state = state.lock().expect("zobrist mutex poisoned");
    if let Some(&value) = state.values.get(&key) {
        return value;
    }
    let value = state.rng.next_u64();
    state.values.insert(key, value);
    value
}

struct ZobristState {
    rng: PyMt19937,
    values: HashMap<(i32, i32, u8), u64>,
}

fn zobrist_state() -> &'static Mutex<ZobristState> {
    static STATE: OnceLock<Mutex<ZobristState>> = OnceLock::new();
    STATE.get_or_init(|| {
        Mutex::new(ZobristState {
            rng: PyMt19937::new(42),
            values: HashMap::new(),
        })
    })
}

struct PyMt19937 {
    state: [u32; 624],
    index: usize,
}

impl PyMt19937 {
    fn new(seed: u32) -> Self {
        let mut state = [0u32; 624];
        state[0] = seed;
        for index in 1..624 {
            state[index] = 1812433253u32
                .wrapping_mul(state[index - 1] ^ (state[index - 1] >> 30))
                .wrapping_add(index as u32);
        }
        Self { state, index: 624 }
    }

    fn next_u32(&mut self) -> u32 {
        if self.index >= 624 {
            self.twist();
        }
        let mut y = self.state[self.index];
        self.index += 1;
        y ^= y >> 11;
        y ^= (y << 7) & 0x9D2C5680;
        y ^= (y << 15) & 0xEFC60000;
        y ^= y >> 18;
        y
    }

    fn next_u64(&mut self) -> u64 {
        let low = self.next_u32() as u64;
        let high = self.next_u32() as u64;
        (high << 32) | low
    }

    fn twist(&mut self) {
        const UPPER_MASK: u32 = 0x80000000;
        const LOWER_MASK: u32 = 0x7fffffff;
        const MATRIX_A: u32 = 0x9908b0df;
        for index in 0..624 {
            let y = (self.state[index] & UPPER_MASK)
                | (self.state[(index + 1) % 624] & LOWER_MASK);
            let mut next = self.state[(index + 397) % 624] ^ (y >> 1);
            if y & 1 != 0 {
                next ^= MATRIX_A;
            }
            self.state[index] = next;
        }
        self.index = 0;
    }
}

fn pattern_values() -> &'static [f64] {
    static VALUES: OnceLock<Vec<f64>> = OnceLock::new();
    VALUES.get_or_init(|| {
        serde_json::from_str(include_str!("../data/seal_pattern_values_full.json"))
            .expect("valid seal pattern values")
    })
}

fn pow3() -> &'static [i32; 6] {
    static POW3: [i32; 6] = [1, 3, 9, 27, 81, 243];
    &POW3
}

fn neighbor_offsets() -> &'static [Cube] {
    static OFFSETS: OnceLock<Vec<Cube>> = OnceLock::new();
    OFFSETS.get_or_init(|| {
        let mut offsets = Vec::new();
        for dq in -2i32..=2 {
            for dr in -2i32..=2 {
                if dq == 0 && dr == 0 {
                    continue;
                }
                let ds: i32 = -dq - dr;
                if dq.abs().max(dr.abs()).max(ds.abs()) <= 2 {
                    offsets.push(Cube::from_axial(dq, dr));
                }
            }
        }
        offsets
    })
}

