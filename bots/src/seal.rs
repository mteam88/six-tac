use hex_tic_tac_engine::{Cube, Game, Player};

use crate::shared::{
    choose_random_legal_move, collect_threat_windows, evaluate_position,
    filter_pairs_by_threats, find_immediate_win, ranked_pairs, INNER_CANDIDATE_CAP,
    ROOT_CANDIDATE_CAP, SEARCH_DEPTH, WIN_SCORE,
};

pub(crate) fn choose_seal_move(game: &Game) -> Result<[Cube; 2], String> {
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
        let score = minimax(&mut probe, SEARCH_DEPTH.saturating_sub(1), alpha, beta, player);
        probe.undo();
        if score > best_score {
            best_score = score;
            best_pair = pair;
        }
        alpha = alpha.max(score);
    }

    Ok(best_pair)
}

fn minimax(game: &mut Game, depth: usize, mut alpha: i32, mut beta: i32, root_player: Player) -> i32 {
    if let Some(winner) = game.winner() {
        return if winner == root_player { WIN_SCORE } else { -WIN_SCORE };
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
            game.undo();
            WIN_SCORE
        } else {
            let _ = game.play(pair);
            game.undo();
            -WIN_SCORE
        };
    }

    let threat_windows = collect_threat_windows(game, current_player.other());
    let filtered = filter_pairs_by_threats(&pairs, &threat_windows);
    if !filtered.is_empty() {
        pairs = filtered;
    }

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
