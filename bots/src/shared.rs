use hex_tic_tac_engine::{Cube, Game, Player};
use js_sys::Math;
use rustc_hash::{FxHashMap, FxHashSet};

pub(crate) const POSITIVE_DIRS: [Cube; 3] = [cube(1, -1, 0), cube(1, 0, -1), cube(0, 1, -1)];
pub(crate) const WINDOW_LENGTH: i32 = 6;
pub(crate) const FRONTIER_RADIUS: i32 = 2;
pub(crate) const FALLBACK_RADIUS: i32 = 8;
pub(crate) const ROOT_CANDIDATE_CAP: usize = 12;
pub(crate) const INNER_CANDIDATE_CAP: usize = 8;
pub(crate) const SEARCH_DEPTH: usize = 2;
pub(crate) const WIN_SCORE: i32 = 1_000_000;
pub(crate) const WINDOW_SCORES: [i32; 7] = [0, 2, 10, 48, 220, 1_200, WIN_SCORE / 2];

#[derive(Clone, Copy)]
pub(crate) struct ScoredCandidate {
    pub(crate) coord: Cube,
    pub(crate) score: i32,
}

pub(crate) const fn cube(x: i32, y: i32, z: i32) -> Cube {
    match Cube::new(x, y, z) {
        Some(value) => value,
        None => panic!("invalid cube constant"),
    }
}

pub(crate) fn choose_random_legal_move(game: &Game) -> Result<[Cube; 2], String> {
    let candidates = collect_frontier_candidates(game, FALLBACK_RADIUS);
    let legal_pairs = legal_pairs_from_candidates(game, &candidates);
    if legal_pairs.is_empty() {
        return Err("sprout could not find a legal move".to_string());
    }
    Ok(legal_pairs[random_index(legal_pairs.len())])
}

pub(crate) fn ranked_pairs(game: &Game, player: Player, candidate_cap: usize) -> Vec<[Cube; 2]> {
    let mut candidates = rank_candidates(game, player, FRONTIER_RADIUS, candidate_cap);
    if candidates.len() < 2 {
        candidates = rank_candidates(game, player, FALLBACK_RADIUS, candidate_cap.max(12));
    }

    let mut pairs = Vec::new();
    for first in 0..candidates.len() {
        for second in (first + 1)..candidates.len() {
            let pair = [candidates[first].coord, candidates[second].coord];
            if game.is_legal(pair) {
                pairs.push((pair, candidates[first].score + candidates[second].score));
            }
        }
    }

    pairs.sort_by(|a, b| b.1.cmp(&a.1));
    pairs.into_iter().map(|entry| entry.0).collect()
}

pub(crate) fn rank_candidates(
    game: &Game,
    player: Player,
    radius: i32,
    candidate_cap: usize,
) -> Vec<ScoredCandidate> {
    let own = game.stones_for(player).collect::<FxHashSet<_>>();
    let opp = game.stones_for(player.other()).collect::<FxHashSet<_>>();
    let mut scored = collect_frontier_candidates(game, radius)
        .into_iter()
        .map(|coord| ScoredCandidate {
            coord,
            score: score_candidate_cell(coord, &own, &opp),
        })
        .collect::<Vec<_>>();
    scored.sort_by(|a, b| b.score.cmp(&a.score));
    scored.truncate(candidate_cap.max(2));
    scored
}

pub(crate) fn legal_pairs_from_candidates(game: &Game, candidates: &[Cube]) -> Vec<[Cube; 2]> {
    let mut pairs = Vec::new();
    for first in 0..candidates.len() {
        for second in (first + 1)..candidates.len() {
            let pair = [candidates[first], candidates[second]];
            if game.is_legal(pair) {
                pairs.push(pair);
            }
        }
    }
    pairs
}

pub(crate) fn find_immediate_win(game: &Game, pairs: &[[Cube; 2]]) -> Option<[Cube; 2]> {
    let player = game.current_player();
    let mut probe = game.clone();
    for &pair in pairs {
        if probe.play(pair).is_ok() {
            let is_win = probe.winner() == Some(player);
            probe.undo();
            if is_win {
                return Some(pair);
            }
        }
    }
    None
}

pub(crate) fn collect_frontier_candidates(game: &Game, radius: i32) -> Vec<Cube> {
    let occupied = game.stones().map(|(cube, _)| cube).collect::<FxHashSet<_>>();
    let mut candidates = FxHashSet::default();

    for (stone, _) in game.stones() {
        for dx in -radius..=radius {
            for dy in -radius..=radius {
                let dz = -dx - dy;
                if dx.abs().max(dy.abs()).max(dz.abs()) > radius {
                    continue;
                }
                let candidate = cube(stone.x() + dx, stone.y() + dy, stone.z() + dz);
                if !occupied.contains(&candidate) {
                    candidates.insert(candidate);
                }
            }
        }
    }

    if candidates.len() < 2 {
        for dx in -2i32..=2 {
            for dy in -2i32..=2 {
                let dz = -dx - dy;
                if dx.abs().max(dy.abs()).max(dz.abs()) > 2 {
                    continue;
                }
                let candidate = cube(dx, dy, dz);
                if !occupied.contains(&candidate) {
                    candidates.insert(candidate);
                }
            }
        }
    }

    candidates.into_iter().collect()
}

pub(crate) fn evaluate_position(game: &Game, root_player: Player) -> i32 {
    let occupied = game.stones().collect::<FxHashMap<_, _>>();
    let mut seen = FxHashSet::default();
    let mut score = 0;

    for (&coord, _) in &occupied {
        for (axis_idx, dir) in POSITIVE_DIRS.iter().copied().enumerate() {
            let rev = negate(dir);
            for back in 0..WINDOW_LENGTH {
                let start = offset(coord, scale(rev, back));
                if !seen.insert((axis_idx, start)) {
                    continue;
                }

                let mut root_count = 0usize;
                let mut opp_count = 0usize;
                for step in 0..WINDOW_LENGTH {
                    let cell = offset(start, scale(dir, step));
                    match occupied.get(&cell) {
                        Some(player) if *player == root_player => root_count += 1,
                        Some(_) => opp_count += 1,
                        None => {}
                    }
                }

                if root_count > 0 && opp_count == 0 {
                    score += WINDOW_SCORES[root_count.min(6)];
                } else if opp_count > 0 && root_count == 0 {
                    score -= WINDOW_SCORES[opp_count.min(6)];
                }
            }
        }
    }

    score
}

pub(crate) fn collect_threat_windows(game: &Game, player: Player) -> Vec<FxHashSet<Cube>> {
    let occupied = game.stones().collect::<FxHashMap<_, _>>();
    let mut seen = FxHashSet::default();
    let mut windows = Vec::new();

    for (&coord, _) in &occupied {
        for (axis_idx, dir) in POSITIVE_DIRS.iter().copied().enumerate() {
            let rev = negate(dir);
            for back in 0..WINDOW_LENGTH {
                let start = offset(coord, scale(rev, back));
                if !seen.insert((axis_idx, start)) {
                    continue;
                }

                let mut player_count = 0usize;
                let mut opponent_count = 0usize;
                let mut empties = FxHashSet::default();
                for step in 0..WINDOW_LENGTH {
                    let cell = offset(start, scale(dir, step));
                    match occupied.get(&cell) {
                        Some(owner) if *owner == player => player_count += 1,
                        Some(_) => opponent_count += 1,
                        None => {
                            empties.insert(cell);
                        }
                    }
                }

                if player_count >= 4 && opponent_count == 0 && !empties.is_empty() {
                    windows.push(empties);
                }
            }
        }
    }

    windows
}

pub(crate) fn filter_pairs_by_threats(
    pairs: &[[Cube; 2]],
    threat_windows: &[FxHashSet<Cube>],
) -> Vec<[Cube; 2]> {
    if threat_windows.is_empty() {
        return pairs.to_vec();
    }

    pairs
        .iter()
        .copied()
        .filter(|pair| {
            threat_windows
                .iter()
                .all(|window| window.contains(&pair[0]) || window.contains(&pair[1]))
        })
        .collect()
}

fn score_candidate_cell(coord: Cube, own: &FxHashSet<Cube>, opp: &FxHashSet<Cube>) -> i32 {
    let mut score = 0;
    for dir in POSITIVE_DIRS {
        let rev = negate(dir);
        let own_span = count_direction(own, offset(coord, dir), dir)
            + count_direction(own, offset(coord, rev), rev);
        let opp_span = count_direction(opp, offset(coord, dir), dir)
            + count_direction(opp, offset(coord, rev), rev);

        score += own_span * own_span * 18;
        score += opp_span * opp_span * 15;
        if own_span >= 4 {
            score += 240;
        }
        if opp_span >= 4 {
            score += 210;
        }
    }

    score + ((10 - coord.distance(Cube::ORIGIN) as i32).max(0) * 4)
}

fn count_direction(stones: &FxHashSet<Cube>, start: Cube, delta: Cube) -> i32 {
    let mut cursor = start;
    let mut count = 0;
    while stones.contains(&cursor) {
        count += 1;
        cursor = offset(cursor, delta);
    }
    count
}

pub(crate) fn offset(base: Cube, delta: Cube) -> Cube {
    cube(base.x() + delta.x(), base.y() + delta.y(), base.z() + delta.z())
}

pub(crate) fn scale(delta: Cube, factor: i32) -> Cube {
    cube(delta.x() * factor, delta.y() * factor, delta.z() * factor)
}

pub(crate) fn negate(delta: Cube) -> Cube {
    cube(-delta.x(), -delta.y(), -delta.z())
}

fn random_index(length: usize) -> usize {
    (Math::floor(Math::random() * length as f64) as usize).min(length.saturating_sub(1))
}
