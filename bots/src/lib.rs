#![forbid(unsafe_code)]

use hex_tic_tac_engine::{Cube, Game, Player};
use js_sys::Math;
use rustc_hash::{FxHashMap, FxHashSet};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

const POSITIVE_DIRS: [Cube; 3] = [cube(1, -1, 0), cube(1, 0, -1), cube(0, 1, -1)];
const WINDOW_LENGTH: i32 = 6;
const FRONTIER_RADIUS: i32 = 2;
const FALLBACK_RADIUS: i32 = 8;
const ROOT_CANDIDATE_CAP: usize = 12;
const INNER_CANDIDATE_CAP: usize = 8;
const SEARCH_DEPTH: usize = 2;
const WIN_SCORE: i32 = 1_000_000;
const WINDOW_SCORES: [i32; 7] = [0, 2, 10, 48, 220, 1_200, WIN_SCORE / 2];

const fn cube(x: i32, y: i32, z: i32) -> Cube {
    match Cube::new(x, y, z) {
        Some(value) => value,
        None => panic!("invalid cube constant"),
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum BotName {
    Sprout,
    Seal,
}

impl BotName {
    fn from_str(value: &str) -> Result<Self, String> {
        match value {
            "sprout" => Ok(Self::Sprout),
            "seal" => Ok(Self::Seal),
            _ => Err(format!("unknown bot: {value}")),
        }
    }
}

#[derive(Clone, Copy)]
struct ScoredCandidate {
    coord: Cube,
    score: i32,
}

#[derive(Serialize)]
struct BotMoveView {
    stones: [Cube; 2],
}

#[derive(Serialize)]
struct BotListView {
    bots: [BotName; 2],
}

#[derive(Deserialize)]
struct BotRequest {
    game_json: String,
    bot_name: String,
}

#[wasm_bindgen]
pub fn list_bots_json() -> Result<String, JsValue> {
    serde_json::to_string(&BotListView {
        bots: [BotName::Sprout, BotName::Seal],
    })
    .map_err(|error| JsValue::from_str(&error.to_string()))
}

#[wasm_bindgen]
pub fn best_move_json(bot_name: &str, game_json: &str) -> Result<String, JsValue> {
    let bot_name = BotName::from_str(bot_name).map_err(|error| JsValue::from_str(&error))?;
    let game = if game_json.trim().is_empty() {
        Game::new()
    } else {
        Game::from_json_str(game_json).map_err(|error| JsValue::from_str(&error.to_string()))?
    };

    let stones = match bot_name {
        BotName::Sprout => choose_random_legal_move(&game),
        // Seal is a Rust translation of the frontier-based, threat-aware minimax
        // bot shape used in Ramora0/HexTicTacToe, adapted to this engine's
        // turn-list format and implied opening rule.
        BotName::Seal => choose_seal_move(&game),
    }
    .map_err(|error| JsValue::from_str(&error))?;

    serde_json::to_string(&BotMoveView { stones })
        .map_err(|error| JsValue::from_str(&error.to_string()))
}

#[wasm_bindgen]
pub fn best_move_request_json(request_json: &str) -> Result<String, JsValue> {
    let request = serde_json::from_str::<BotRequest>(request_json)
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    best_move_json(&request.bot_name, &request.game_json)
}

fn choose_random_legal_move(game: &Game) -> Result<[Cube; 2], String> {
    let candidates = collect_frontier_candidates(game, FALLBACK_RADIUS);
    let legal_pairs = legal_pairs_from_candidates(game, &candidates);
    if legal_pairs.is_empty() {
        return Err("sprout could not find a legal move".to_string());
    }
    Ok(legal_pairs[random_index(legal_pairs.len())])
}

fn choose_seal_move(game: &Game) -> Result<[Cube; 2], String> {
    let player = game.current_player();
    let mut pairs = ranked_pairs(game, player, ROOT_CANDIDATE_CAP);
    if pairs.is_empty() {
        return choose_random_legal_move(game);
    }

    if let Some(pair) = find_immediate_win(game, &pairs) {
        return Ok(pair);
    }

    let threat_windows = collect_threat_windows(game, player.other());
    let filtered = filter_pairs_by_threats(&pairs, &threat_windows);
    if !filtered.is_empty() {
        pairs = filtered;
    }

    let mut probe = game.clone();
    let mut best_pair = pairs[0];
    let mut best_score = i32::MIN;
    let mut alpha = i32::MIN / 2;
    let beta = i32::MAX / 2;

    for pair in pairs {
        if probe.play(pair).is_err() {
            continue;
        }
        let score = minimax(
            &mut probe,
            SEARCH_DEPTH.saturating_sub(1),
            alpha,
            beta,
            player,
        );
        probe.undo();
        if score > best_score {
            best_score = score;
            best_pair = pair;
        }
        alpha = alpha.max(score);
    }

    Ok(best_pair)
}

fn minimax(
    game: &mut Game,
    depth: usize,
    mut alpha: i32,
    mut beta: i32,
    root_player: Player,
) -> i32 {
    if let Some(winner) = game.winner() {
        return if winner == root_player {
            WIN_SCORE
        } else {
            -WIN_SCORE
        };
    }
    if depth == 0 {
        return evaluate_position(game, root_player);
    }

    let current_player = game.current_player();
    let maximizing = current_player == root_player;
    let mut pairs = ranked_pairs(game, current_player, INNER_CANDIDATE_CAP);
    if pairs.is_empty() {
        return evaluate_position(game, root_player);
    }

    if let Some(pair) = find_immediate_win(game, &pairs) {
        return if current_player == root_player {
            let _ = game.play(pair);
            let score = WIN_SCORE;
            game.undo();
            score
        } else {
            let _ = game.play(pair);
            let score = -WIN_SCORE;
            game.undo();
            score
        };
    }

    let threat_windows = collect_threat_windows(game, current_player.other());
    let filtered = filter_pairs_by_threats(&pairs, &threat_windows);
    if !filtered.is_empty() {
        pairs = filtered;
    }

    if maximizing {
        let mut value = i32::MIN;
        for pair in pairs {
            if game.play(pair).is_err() {
                continue;
            }
            let child = minimax(game, depth - 1, alpha, beta, root_player);
            game.undo();
            value = value.max(child);
            alpha = alpha.max(value);
            if alpha >= beta {
                break;
            }
        }
        value
    } else {
        let mut value = i32::MAX;
        for pair in pairs {
            if game.play(pair).is_err() {
                continue;
            }
            let child = minimax(game, depth - 1, alpha, beta, root_player);
            game.undo();
            value = value.min(child);
            beta = beta.min(value);
            if alpha >= beta {
                break;
            }
        }
        value
    }
}

fn ranked_pairs(game: &Game, player: Player, candidate_cap: usize) -> Vec<[Cube; 2]> {
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

fn rank_candidates(
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

fn legal_pairs_from_candidates(game: &Game, candidates: &[Cube]) -> Vec<[Cube; 2]> {
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

fn find_immediate_win(game: &Game, pairs: &[[Cube; 2]]) -> Option<[Cube; 2]> {
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

fn collect_frontier_candidates(game: &Game, radius: i32) -> Vec<Cube> {
    let occupied = game
        .stones()
        .map(|(cube, _)| cube)
        .collect::<FxHashSet<_>>();
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

fn evaluate_position(game: &Game, root_player: Player) -> i32 {
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

fn collect_threat_windows(game: &Game, player: Player) -> Vec<FxHashSet<Cube>> {
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

fn filter_pairs_by_threats(
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

fn count_direction(stones: &FxHashSet<Cube>, start: Cube, delta: Cube) -> i32 {
    let mut cursor = start;
    let mut count = 0;
    while stones.contains(&cursor) {
        count += 1;
        cursor = offset(cursor, delta);
    }
    count
}

fn offset(base: Cube, delta: Cube) -> Cube {
    cube(
        base.x() + delta.x(),
        base.y() + delta.y(),
        base.z() + delta.z(),
    )
}

fn scale(delta: Cube, factor: i32) -> Cube {
    cube(delta.x() * factor, delta.y() * factor, delta.z() * factor)
}

fn negate(delta: Cube) -> Cube {
    cube(-delta.x(), -delta.y(), -delta.z())
}

fn random_index(length: usize) -> usize {
    (Math::floor(Math::random() * length as f64) as usize).min(length.saturating_sub(1))
}
