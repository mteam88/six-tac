use hex_tic_tac_engine::{Cube, Game, Player};
use rustc_hash::FxHashSet;

use crate::shared::{
    choose_random_legal_move, collect_threat_windows, evaluate_position, filter_pairs_by_threats,
    find_immediate_win, minimal_threat_cover_size, ranked_pairs, INNER_CANDIDATE_CAP,
    ROOT_CANDIDATE_CAP, WIN_SCORE,
};

const FORCED_THREAT_SCORE: i32 = WIN_SCORE / 2;
const DUAL_BLOCK_THREAT_SCORE: i32 = 16_000;
const SINGLE_BLOCK_THREAT_SCORE: i32 = 4_500;
const ALL_DIRS: [Cube; 6] = [
    crate::shared::cube(1, -1, 0),
    crate::shared::cube(1, 0, -1),
    crate::shared::cube(0, 1, -1),
    crate::shared::cube(-1, 1, 0),
    crate::shared::cube(-1, 0, 1),
    crate::shared::cube(0, -1, 1),
];

pub(crate) fn choose_orca_move(game: &Game) -> Result<[Cube; 2], String> {
    let player = game.current_player();
    let mut pairs = ranked_pairs(game, player, ROOT_CANDIDATE_CAP);
    if pairs.is_empty() {
        return choose_random_legal_move(game);
    }
    if let Some(pair) = find_immediate_win(game, &pairs) {
        return Ok(pair);
    }

    let opponent_threats = collect_threat_windows(game, player.other());
    let filtered = filter_pairs_by_threats(&pairs, &opponent_threats);
    if !filtered.is_empty() {
        pairs = filtered;
    }

    let mut probe = game.clone();
    let mut forced_pair = None;
    let mut forced_score = i32::MIN;
    for &pair in &pairs {
        if probe.play(pair).is_err() {
            continue;
        }
        let cover = minimal_threat_cover_size(&collect_threat_windows(&probe, player));
        let score = evaluate_orca_position(&probe, player);
        probe.undo();
        if cover > 2 && score > forced_score {
            forced_score = score;
            forced_pair = Some(pair);
        }
    }
    if let Some(pair) = forced_pair {
        return Ok(pair);
    }

    let mut best_pair = pairs[0];
    let mut best_score = i32::MIN;
    let mut alpha = i32::MIN / 2;
    let beta = i32::MAX / 2;

    for pair in pairs {
        if probe.play(pair).is_err() {
            continue;
        }
        let score = minimax(&mut probe, 1, alpha, beta, player);
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
        return evaluate_orca_position(game, root_player);
    }

    let current_player = game.current_player();
    let mut pairs = ranked_pairs(game, current_player, INNER_CANDIDATE_CAP.saturating_sub(1));
    if pairs.is_empty() {
        return evaluate_orca_position(game, root_player);
    }
    if let Some(pair) = find_immediate_win(game, &pairs) {
        return if current_player == root_player {
            let _ = game.play(pair);
            game.undo();
            WIN_SCORE
        } else {
            let _ = game.play(pair);
            game.undo();
            -WIN_SCORE
        };
    }

    let opponent_threats = collect_threat_windows(game, current_player.other());
    let filtered = filter_pairs_by_threats(&pairs, &opponent_threats);
    if !filtered.is_empty() {
        pairs = filtered;
    }

    let maximizing = current_player == root_player;
    let mut value = if maximizing { i32::MIN } else { i32::MAX };
    for pair in pairs {
        if game.play(pair).is_err() {
            continue;
        }
        let child = minimax(game, depth - 1, alpha, beta, root_player);
        game.undo();
        if maximizing {
            value = value.max(child);
            alpha = alpha.max(value);
        } else {
            value = value.min(child);
            beta = beta.min(value);
        }
        if alpha >= beta {
            break;
        }
    }
    value
}

fn evaluate_orca_position(game: &Game, root_player: Player) -> i32 {
    evaluate_position(game, root_player) * 2
        + evaluate_side(game, root_player)
        - evaluate_side(game, root_player.other())
}

fn evaluate_side(game: &Game, player: Player) -> i32 {
    let stones = game.stones_for(player).collect::<Vec<_>>();
    let stone_set = stones.iter().copied().collect::<FxHashSet<_>>();
    let threats = collect_threat_windows(game, player);
    let cover = minimal_threat_cover_size(&threats);
    let distinct_threat_cells = threats
        .iter()
        .flat_map(|window| window.cells().iter().copied())
        .collect::<FxHashSet<_>>()
        .len() as i32;

    let threat_pressure = match cover {
        0 => threats.len() as i32 * 250,
        1 => SINGLE_BLOCK_THREAT_SCORE + threats.len() as i32 * 900 + distinct_threat_cells * 250,
        2 => DUAL_BLOCK_THREAT_SCORE + threats.len() as i32 * 2_200 + distinct_threat_cells * 450,
        _ => FORCED_THREAT_SCORE,
    };

    let mut longest_line = 0;
    let mut strong_lines = 0;
    let mut adjacent_pairs = 0;
    let mut center_proximity = 0;

    for stone in stones.iter().copied() {
        let line_length = game.line_length_through(player, stone) as i32;
        longest_line = longest_line.max(line_length);
        if line_length >= 4 {
            strong_lines += 1;
        }
        adjacent_pairs += ALL_DIRS
            .iter()
            .copied()
            .filter(|&dir| stone_set.contains(&stone.offset(dir)))
            .count() as i32;
        center_proximity += (10 - stone.distance(Cube::ORIGIN) as i32).max(0);
    }

    threat_pressure
        + longest_line * longest_line * 180
        + strong_lines * 140
        + (adjacent_pairs / 2) * 14
        + center_proximity * 4
}
