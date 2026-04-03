use hex_tic_tac_engine::{Cube, Game, Player};
use rustc_hash::{FxHashMap, FxHashSet};

use crate::shared::{
    choose_random_legal_move, collect_frontier_candidates, evaluate_position, find_immediate_win,
    legal_pairs_from_candidates, negate, offset, scale, POSITIVE_DIRS, WINDOW_LENGTH, WIN_SCORE,
};

const ALL_DIRS: [Cube; 6] = [
    cube(1, -1, 0),
    cube(1, 0, -1),
    cube(0, 1, -1),
    cube(-1, 1, 0),
    cube(-1, 0, 1),
    cube(0, -1, 1),
];

const ROOT_CELL_CAP: usize = 10;
const INNER_CELL_CAP: usize = 7;
const ROOT_PAIR_CAP: usize = 20;
const INNER_PAIR_CAP: usize = 8;
const SEARCH_DEPTH: usize = 2;
const FORCED_WIN_BONUS: i32 = 260_000;
const IMMEDIATE_THREAT_BONUS: i32 = 24_000;
const OPP_IMMEDIATE_WIN_PENALTY: i32 = 320_000;

#[derive(Clone, Copy)]
struct ScoredCell {
    coord: Cube,
    score: i32,
}

#[derive(Clone, Copy)]
struct ScoredPair {
    pair: [Cube; 2],
    score: i32,
}

#[derive(Clone, Copy)]
struct WindowPattern {
    empties: [Cube; WINDOW_LENGTH as usize],
    empties_len: u8,
    stone_count: u8,
}

struct TacticalSummary {
    pressure_score: i32,
    immediate_threats: Vec<WindowPattern>,
}

impl WindowPattern {
    fn new() -> Self {
        Self {
            empties: [Cube::ORIGIN; WINDOW_LENGTH as usize],
            empties_len: 0,
            stone_count: 0,
        }
    }

    fn push_empty(&mut self, coord: Cube) {
        self.empties[self.empties_len as usize] = coord;
        self.empties_len += 1;
    }

    fn empties(&self) -> &[Cube] {
        &self.empties[..self.empties_len as usize]
    }

    fn contains_either(&self, first: Cube, second: Cube) -> bool {
        self.empties()
            .iter()
            .any(|&coord| coord == first || coord == second)
    }
}

pub(crate) fn choose_hydra_move(game: &Game) -> Result<[Cube; 2], String> {
    let player = game.current_player();
    let mut pairs = ordered_pairs_rich(game, player, ROOT_CELL_CAP, ROOT_PAIR_CAP);
    if pairs.is_empty() {
        return choose_random_legal_move(game);
    }

    let raw_pairs = scored_pairs(&pairs);
    if let Some(pair) = find_immediate_win(game, &raw_pairs) {
        return Ok(pair);
    }

    let forced_blocks = immediate_threats(game, player.other());
    if !forced_blocks.is_empty() {
        let original_pairs = pairs.clone();
        retain_pairs_covering_threats(&mut pairs, &forced_blocks);
        if pairs.is_empty() {
            pairs = original_pairs;
        }
    }

    let mut probe = game.clone();
    let mut best_pair = pairs[0].pair;
    let mut best_score = i32::MIN;
    let mut alpha = i32::MIN / 2;
    let beta = i32::MAX / 2;

    for entry in pairs {
        if probe.play(entry.pair).is_err() {
            continue;
        }
        let score = -negamax(
            &mut probe,
            SEARCH_DEPTH.saturating_sub(1),
            -beta,
            -alpha,
            player,
        );
        probe.undo();
        if score > best_score {
            best_score = score;
            best_pair = entry.pair;
        }
        alpha = alpha.max(score);
    }

    Ok(best_pair)
}

fn negamax(game: &mut Game, depth: usize, mut alpha: i32, beta: i32, root_player: Player) -> i32 {
    if let Some(winner) = game.winner() {
        return if winner == root_player {
            WIN_SCORE + depth as i32
        } else {
            -WIN_SCORE - depth as i32
        };
    }

    if depth == 0 {
        return static_eval(game, root_player);
    }

    let current_player = game.current_player();
    let mut pairs = ordered_pairs_fast(game, current_player, INNER_CELL_CAP, INNER_PAIR_CAP);
    if pairs.is_empty() {
        return static_eval(game, root_player);
    }

    let raw_pairs = scored_pairs(&pairs);
    if let Some(pair) = find_immediate_win(game, &raw_pairs) {
        let _ = game.play(pair);
        let score = -negamax(game, depth.saturating_sub(1), -beta, -alpha, root_player);
        game.undo();
        return score;
    }

    let forced_blocks = immediate_threats(game, current_player.other());
    if !forced_blocks.is_empty() {
        retain_pairs_covering_threats(&mut pairs, &forced_blocks);
        if pairs.is_empty() {
            return if current_player == root_player {
                -WIN_SCORE + depth as i32
            } else {
                WIN_SCORE - depth as i32
            };
        }
    }

    let mut best = i32::MIN;
    for entry in pairs {
        if game.play(entry.pair).is_err() {
            continue;
        }
        let score = -negamax(game, depth - 1, -beta, -alpha, root_player);
        game.undo();
        best = best.max(score);
        alpha = alpha.max(score);
        if alpha >= beta {
            break;
        }
    }

    best
}

fn ordered_pairs_rich(
    game: &Game,
    player: Player,
    cell_cap: usize,
    pair_cap: usize,
) -> Vec<ScoredPair> {
    let candidates = candidate_cells(game, player, cell_cap);
    if candidates.len() < 2 {
        return Vec::new();
    }

    let coords = candidates
        .iter()
        .map(|entry| entry.coord)
        .collect::<Vec<_>>();
    let mut probe = game.clone();
    let mut pairs = legal_pairs_from_candidates(game, &coords)
        .into_iter()
        .filter_map(|pair| {
            score_pair_with_probe(&mut probe, game, pair, player)
                .map(|score| ScoredPair { pair, score })
        })
        .collect::<Vec<_>>();

    sort_and_truncate_pairs(&mut pairs, pair_cap);
    pairs
}

fn ordered_pairs_fast(
    game: &Game,
    player: Player,
    cell_cap: usize,
    pair_cap: usize,
) -> Vec<ScoredPair> {
    let candidates = candidate_cells(game, player, cell_cap);
    if candidates.len() < 2 {
        return Vec::new();
    }

    let mut pairs = Vec::new();
    for first in 0..candidates.len() {
        for second in (first + 1)..candidates.len() {
            let pair = [candidates[first].coord, candidates[second].coord];
            let score = candidates[first].score
                + candidates[second].score
                + pair_alignment_bonus(pair, player, game);
            pairs.push(ScoredPair { pair, score });
        }
    }

    sort_and_truncate_pairs(&mut pairs, pair_cap);
    pairs
}

fn candidate_cells(game: &Game, player: Player, cell_cap: usize) -> Vec<ScoredCell> {
    let mut seen = FxHashSet::default();
    let mut scores = FxHashMap::default();

    for coord in collect_frontier_candidates(game, 2) {
        seen.insert(coord);
        scores.insert(coord, base_cell_score(game, coord, player));
    }
    if seen.len() < 2 {
        for coord in collect_frontier_candidates(game, 8) {
            seen.insert(coord);
            scores
                .entry(coord)
                .or_insert_with(|| base_cell_score(game, coord, player));
        }
    }

    for (focus_player, scale_factor) in [(player, 1), (player.other(), -1)] {
        for window in player_windows(game, focus_player) {
            let bonus = window_cell_bonus(window.stone_count as i32);
            for &empty in window.empties() {
                seen.insert(empty);
                let entry = scores
                    .entry(empty)
                    .or_insert_with(|| base_cell_score(game, empty, player));
                *entry += if scale_factor > 0 {
                    bonus
                } else {
                    bonus * 4 / 5
                };
                if window.stone_count >= 4 {
                    *entry += 140;
                }
            }
        }
    }

    let mut cells = seen
        .into_iter()
        .map(|coord| ScoredCell {
            coord,
            score: scores[&coord],
        })
        .collect::<Vec<_>>();
    cells.sort_unstable_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| cube_key(a.coord).cmp(&cube_key(b.coord)))
    });
    cells.truncate(cell_cap.max(2));
    cells
}

fn score_pair_with_probe(
    probe: &mut Game,
    game: &Game,
    pair: [Cube; 2],
    player: Player,
) -> Option<i32> {
    probe.play(pair).ok()?;

    let score = if probe.winner() == Some(player) {
        WIN_SCORE - 1
    } else {
        let self_summary = tactical_summary(probe, player);
        let opponent_summary = tactical_summary(probe, player.other());
        let self_cover = min_cover_size(&self_summary.immediate_threats);

        let mut score = 3 * evaluate_position(probe, player) + self_summary.pressure_score
            - opponent_summary.pressure_score;

        score += pair_alignment_bonus(pair, player, game);
        score += self_summary.immediate_threats.len() as i32 * IMMEDIATE_THREAT_BONUS;
        if self_cover > 2 {
            score += FORCED_WIN_BONUS;
        } else if self_cover == 2 {
            score += IMMEDIATE_THREAT_BONUS / 2;
        }

        if !opponent_summary.immediate_threats.is_empty() {
            score -= OPP_IMMEDIATE_WIN_PENALTY
                + opponent_summary.immediate_threats.len() as i32 * 20_000;
        }

        score
    };

    probe.undo();
    Some(score)
}

fn static_eval(game: &Game, root_player: Player) -> i32 {
    let root_summary = tactical_summary(game, root_player);
    let opp_summary = tactical_summary(game, root_player.other());

    let mut score = 4 * evaluate_position(game, root_player) + root_summary.pressure_score
        - opp_summary.pressure_score
        + cluster_score(game, root_player)
        - cluster_score(game, root_player.other());

    if game.current_player() == root_player {
        if !root_summary.immediate_threats.is_empty() {
            score += FORCED_WIN_BONUS / 2;
        }
        if !opp_summary.immediate_threats.is_empty() {
            score -= OPP_IMMEDIATE_WIN_PENALTY / 2;
        }
    } else {
        if !opp_summary.immediate_threats.is_empty() {
            score -= OPP_IMMEDIATE_WIN_PENALTY;
        }
        let cover = min_cover_size(&root_summary.immediate_threats);
        if cover > 2 {
            score += FORCED_WIN_BONUS;
        } else if cover == 2 {
            score += IMMEDIATE_THREAT_BONUS;
        }
    }

    score
}

fn player_windows(game: &Game, player: Player) -> Vec<WindowPattern> {
    let mut windows = Vec::new();
    scan_windows(game, player, |pattern| windows.push(pattern));
    windows
}

fn tactical_summary(game: &Game, player: Player) -> TacticalSummary {
    let mut pressure_score = 0;
    let mut immediate_threats = Vec::new();

    scan_windows(game, player, |pattern| {
        pressure_score += window_pressure_for_pattern(pattern);
        if pattern.stone_count >= 4 && pattern.empties_len <= 2 {
            immediate_threats.push(pattern);
        }
    });

    TacticalSummary {
        pressure_score,
        immediate_threats,
    }
}

fn immediate_threats(game: &Game, player: Player) -> Vec<WindowPattern> {
    tactical_summary(game, player).immediate_threats
}

fn scan_windows(game: &Game, player: Player, mut visit: impl FnMut(WindowPattern)) {
    let occupied = game.stones().collect::<FxHashMap<_, _>>();
    let seen_capacity = occupied.len() * POSITIVE_DIRS.len() * WINDOW_LENGTH as usize;
    let mut seen = FxHashSet::with_capacity_and_hasher(seen_capacity, Default::default());

    for (&coord, _) in &occupied {
        for (axis_idx, dir) in POSITIVE_DIRS.iter().copied().enumerate() {
            let rev = negate(dir);
            for back in 0..WINDOW_LENGTH {
                let start = offset(coord, scale(rev, back));
                if !seen.insert((axis_idx, start)) {
                    continue;
                }

                let mut blocked = false;
                let mut pattern = WindowPattern::new();
                for step in 0..WINDOW_LENGTH {
                    let cell = offset(start, scale(dir, step));
                    match occupied.get(&cell) {
                        Some(owner) if *owner == player => pattern.stone_count += 1,
                        Some(_) => {
                            blocked = true;
                            break;
                        }
                        None => pattern.push_empty(cell),
                    }
                }

                if !blocked && pattern.stone_count > 0 {
                    visit(pattern);
                }
            }
        }
    }
}

fn min_cover_size(threats: &[WindowPattern]) -> usize {
    if threats.is_empty() {
        return 0;
    }

    let mut cells = Vec::new();
    let mut seen = FxHashSet::default();
    for threat in threats {
        for &cell in threat.empties() {
            if seen.insert(cell) {
                cells.push(cell);
            }
        }
    }

    for &cell in &cells {
        if threats
            .iter()
            .all(|threat| threat.empties().contains(&cell))
        {
            return 1;
        }
    }

    for first in 0..cells.len() {
        for second in (first + 1)..cells.len() {
            let a = cells[first];
            let b = cells[second];
            if threats
                .iter()
                .all(|threat| threat.empties().contains(&a) || threat.empties().contains(&b))
            {
                return 2;
            }
        }
    }

    3
}

fn retain_pairs_covering_threats(pairs: &mut Vec<ScoredPair>, threats: &[WindowPattern]) {
    pairs.retain(|entry| {
        threats
            .iter()
            .all(|threat| threat.contains_either(entry.pair[0], entry.pair[1]))
    });
}

fn window_pressure_for_pattern(window: WindowPattern) -> i32 {
    let base = match window.stone_count {
        0 => 0,
        1 => 3,
        2 => 12,
        3 => 50,
        4 => 240,
        5 => 1_600,
        _ => 0,
    };
    base + if window.empties_len <= 2 { 80 } else { 0 }
}

fn window_cell_bonus(stone_count: i32) -> i32 {
    match stone_count {
        0 => 0,
        1 => 4,
        2 => 14,
        3 => 60,
        4 => 260,
        5 => 1_200,
        _ => 0,
    }
}

fn base_cell_score(game: &Game, coord: Cube, player: Player) -> i32 {
    let mut score = ((12 - coord.distance(Cube::ORIGIN) as i32).max(0)) * 3;
    for dir in ALL_DIRS {
        match game.stone_at(offset(coord, dir)) {
            Some(owner) if owner == player => score += 20,
            Some(_) => score += 18,
            None => {}
        }
        match game.stone_at(offset(coord, scale(dir, 2))) {
            Some(owner) if owner == player => score += 8,
            Some(_) => score += 6,
            None => {}
        }
    }
    score
}

fn pair_alignment_bonus(pair: [Cube; 2], player: Player, game: &Game) -> i32 {
    let mut score = 0;
    let distance = pair[0].distance(pair[1]) as i32;
    score += match distance {
        1 => 28,
        2 => 22,
        3 => 12,
        _ => 0,
    };

    for dir in POSITIVE_DIRS {
        let line_a = 1
            + run_length(game, pair[0], dir, player)
            + run_length(game, pair[0], negate(dir), player);
        let line_b = 1
            + run_length(game, pair[1], dir, player)
            + run_length(game, pair[1], negate(dir), player);
        score += (line_a.max(line_b) * 6) as i32;
        if are_same_axis(pair[0], pair[1], dir) {
            score += 20;
        }
    }

    score
}

fn cluster_score(game: &Game, player: Player) -> i32 {
    let stones = game.stones_for(player).collect::<FxHashSet<_>>();
    if stones.is_empty() {
        return 0;
    }

    let mut visited = FxHashSet::default();
    let mut best = 0;
    let mut frontier_links = 0;

    for &start in &stones {
        if visited.contains(&start) {
            continue;
        }
        let mut size = 0;
        let mut stack = vec![start];
        while let Some(current) = stack.pop() {
            if !visited.insert(current) {
                continue;
            }
            size += 1;
            for dir in ALL_DIRS {
                let next = offset(current, dir);
                if stones.contains(&next) && !visited.contains(&next) {
                    stack.push(next);
                }
                if stones.contains(&offset(current, scale(dir, 2))) {
                    frontier_links += 1;
                }
            }
        }
        best = best.max(size);
    }

    best * 18 + frontier_links * 2
}

fn run_length(game: &Game, start: Cube, delta: Cube, player: Player) -> i32 {
    let mut count = 0;
    let mut cursor = offset(start, delta);
    while game.stone_at(cursor) == Some(player) {
        count += 1;
        cursor = offset(cursor, delta);
    }
    count
}

fn are_same_axis(a: Cube, b: Cube, dir: Cube) -> bool {
    let delta = cube(b.x() - a.x(), b.y() - a.y(), b.z() - a.z());
    for step in 1..=5 {
        if scale(dir, step) == delta || scale(negate(dir), step) == delta {
            return true;
        }
    }
    false
}

const fn cube(x: i32, y: i32, z: i32) -> Cube {
    match Cube::new(x, y, z) {
        Some(value) => value,
        None => panic!("invalid cube constant"),
    }
}

fn cube_key(coord: Cube) -> (i32, i32, i32) {
    (coord.x(), coord.y(), coord.z())
}

fn pair_key(pair: [Cube; 2]) -> ((i32, i32, i32), (i32, i32, i32)) {
    (cube_key(pair[0]), cube_key(pair[1]))
}

fn scored_pairs(entries: &[ScoredPair]) -> Vec<[Cube; 2]> {
    entries.iter().map(|entry| entry.pair).collect()
}

fn sort_and_truncate_pairs(pairs: &mut Vec<ScoredPair>, pair_cap: usize) {
    pairs.sort_unstable_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| pair_key(a.pair).cmp(&pair_key(b.pair)))
    });
    pairs.truncate(pair_cap.max(1));
}
