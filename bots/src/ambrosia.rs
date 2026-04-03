use hex_tic_tac_engine::{Cube, Game, Player};
use rustc_hash::FxHashSet;

use crate::shared::{
    choose_random_legal_move, collect_frontier_candidates, find_immediate_win,
    legal_pairs_from_candidates, negate, offset, rank_candidates, scale, FALLBACK_RADIUS,
    POSITIVE_DIRS, WINDOW_LENGTH,
};

pub(crate) fn choose_ambrosia_move(game: &Game) -> Result<[Cube; 2], String> {
    let player = game.current_player();
    let mut candidates = rank_candidates(game, player, FALLBACK_RADIUS, 18)
        .into_iter()
        .map(|candidate| candidate.coord)
        .collect::<Vec<_>>();
    if candidates.len() < 2 {
        candidates = collect_frontier_candidates(game, FALLBACK_RADIUS);
    }

    let pairs = legal_pairs_from_candidates(game, &candidates);
    if pairs.is_empty() {
        return choose_random_legal_move(game);
    }
    if let Some(pair) = find_immediate_win(game, &pairs) {
        return Ok(pair);
    }

    let mut probe = game.clone();
    let mut best_pair = pairs[0];
    let mut best_score = f64::NEG_INFINITY;
    for pair in pairs.into_iter().take(96) {
        if probe.play(pair).is_err() {
            continue;
        }
        let score = ambrosia_score(&probe, player);
        probe.undo();
        if score > best_score {
            best_score = score;
            best_pair = pair;
        }
    }

    Ok(best_pair)
}

fn ambrosia_score(game: &Game, player: Player) -> f64 {
    3.0 * longest_run(game, player) as f64
        + 1.0 * line_pressure_score(game, player)
        + 5.0 * open_threat_count(game, player, 2) as f64
        + 12.0 * double_threat_count(game, player) as f64
        + 4.0 * gap_threat_count(game, player) as f64
        - 1.8 * line_pressure_score(game, player.other())
        + 1.5 * largest_cluster_size(game, player) as f64
        - 2.0 * isolated_piece_count(game, player) as f64
        + 0.8 * center_proximity_score(game, player)
}

fn longest_run(game: &Game, player: Player) -> i32 {
    game.stones_for(player)
        .map(|stone| game.line_length_through(player, stone) as i32)
        .max()
        .unwrap_or(0)
}

fn line_pressure_score(game: &Game, player: Player) -> f64 {
    let mut total = 0.0;
    for stone in game.stones_for(player) {
        for dir in POSITIVE_DIRS {
            let backward = negate(dir);
            if game.stone_at(offset(stone, backward)) == Some(player) {
                continue;
            }
            let span = 1 + run_length(game, stone, dir, player);
            total += (span * span * (1 + count_open_ends(game, stone, dir, player))) as f64;
        }
    }
    total
}

fn open_threat_count(game: &Game, player: Player, distance_from_win: i32) -> i32 {
    let min_len = WINDOW_LENGTH - distance_from_win;
    let mut count = 0;
    for stone in game.stones_for(player) {
        for dir in POSITIVE_DIRS {
            let backward = negate(dir);
            if game.stone_at(offset(stone, backward)) == Some(player) {
                continue;
            }
            let span = 1 + run_length(game, stone, dir, player);
            if span >= min_len && count_open_ends(game, stone, dir, player) >= 1 {
                count += 1;
            }
        }
    }
    count
}

fn double_threat_count(game: &Game, player: Player) -> i32 {
    let mut seen = FxHashSet::default();
    let mut count = 0;
    for stone in game.stones_for(player) {
        for dir in POSITIVE_DIRS {
            for distance in 1..=2 {
                let candidate = offset(stone, scale(dir, distance));
                if !seen.insert(candidate) || game.stone_at(candidate).is_some() {
                    continue;
                }
                if POSITIVE_DIRS
                    .iter()
                    .copied()
                    .filter(|axis| {
                        virtual_line_length(game, candidate, *axis, player) >= WINDOW_LENGTH - 1
                    })
                    .count()
                    >= 2
                {
                    count += 1;
                }
            }
        }
    }
    count
}

fn gap_threat_count(game: &Game, player: Player) -> i32 {
    let mut count = 0;
    for stone in game.stones_for(player) {
        for dir in POSITIVE_DIRS {
            let gap = offset(stone, dir);
            let far = offset(gap, dir);
            if game.stone_at(gap).is_none()
                && game.stone_at(far) == Some(player)
                && virtual_line_length(game, gap, dir, player) >= WINDOW_LENGTH - 1
            {
                count += 1;
            }
        }
    }
    count
}

fn largest_cluster_size(game: &Game, player: Player) -> i32 {
    let stones = game.stones_for(player).collect::<FxHashSet<_>>();
    if stones.is_empty() {
        return 0;
    }

    let mut visited = FxHashSet::default();
    let mut best = 0;
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
            for dir in directions() {
                let neighbour = offset(current, dir);
                if stones.contains(&neighbour) && !visited.contains(&neighbour) {
                    stack.push(neighbour);
                }
            }
        }
        best = best.max(size);
    }
    best
}

fn isolated_piece_count(game: &Game, player: Player) -> i32 {
    let stones = game.stones_for(player).collect::<FxHashSet<_>>();
    stones
        .iter()
        .filter(|&&stone| {
            !directions().iter().copied().any(|dir| {
                stones.contains(&offset(stone, dir))
                    || stones.contains(&offset(stone, scale(dir, 2)))
            })
        })
        .count() as i32
}

fn center_proximity_score(game: &Game, player: Player) -> f64 {
    game.stones_for(player)
        .map(|stone| 1.0 / (1.0 + stone.distance(Cube::ORIGIN) as f64))
        .sum()
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

fn count_open_ends(game: &Game, start: Cube, delta: Cube, player: Player) -> i32 {
    let backward = negate(delta);
    let front = offset(
        start,
        scale(delta, run_length(game, start, delta, player) + 1),
    );
    let back = offset(
        start,
        scale(backward, run_length(game, start, backward, player) + 1),
    );
    i32::from(game.stone_at(front).is_none()) + i32::from(game.stone_at(back).is_none())
}

fn virtual_line_length(game: &Game, candidate: Cube, axis: Cube, player: Player) -> i32 {
    1 + run_length(game, candidate, axis, player)
        + run_length(game, candidate, negate(axis), player)
}

fn directions() -> [Cube; 6] {
    [
        POSITIVE_DIRS[0],
        POSITIVE_DIRS[1],
        POSITIVE_DIRS[2],
        negate(POSITIVE_DIRS[0]),
        negate(POSITIVE_DIRS[1]),
        negate(POSITIVE_DIRS[2]),
    ]
}
