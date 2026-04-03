use hex_tic_tac_engine::{Cube, Game, Player};
use rustc_hash::FxHashSet;

use crate::shared::{
    choose_random_legal_move, collect_frontier_candidates, cube, find_immediate_win,
    legal_pairs_from_candidates, negate, offset, rank_candidates, scale, FALLBACK_RADIUS,
    POSITIVE_DIRS, WINDOW_LENGTH,
};

const ALL_DIRS: [Cube; 6] = [
    cube(1, -1, 0),
    cube(1, 0, -1),
    cube(0, 1, -1),
    cube(-1, 1, 0),
    cube(-1, 0, 1),
    cube(0, -1, 1),
];

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
    let stones = game.stones_for(player).collect::<Vec<_>>();
    let opponent_stones = game.stones_for(player.other()).collect::<Vec<_>>();
    let stone_set = stones.iter().copied().collect::<FxHashSet<_>>();
    let (longest_run, pressure, open_threats) = analyze_lines(game, &stones, player, Some(2));
    let (_, opponent_pressure, _) = analyze_lines(game, &opponent_stones, player.other(), None);

    3.0 * longest_run as f64
        + 1.0 * pressure
        + 5.0 * open_threats as f64
        + 12.0 * double_threat_count(game, &stones, player) as f64
        + 4.0 * gap_threat_count(game, &stones, player) as f64
        - 1.8 * opponent_pressure
        + 1.5 * largest_cluster_size(&stone_set) as f64
        - 2.0 * isolated_piece_count(&stone_set) as f64
        + 0.8 * center_proximity_score(&stones)
}

fn analyze_lines(
    game: &Game,
    stones: &[Cube],
    player: Player,
    distance_from_win: Option<i32>,
) -> (i32, f64, i32) {
    let min_len = distance_from_win.map(|distance| WINDOW_LENGTH - distance);
    let mut longest_run = 0;
    let mut pressure = 0.0;
    let mut open_threats = 0;

    for stone in stones.iter().copied() {
        for dir in POSITIVE_DIRS {
            let backward = negate(dir);
            if game.stone_at(offset(stone, backward)) == Some(player) {
                continue;
            }
            let (span, open_ends) = span_and_open_ends(game, stone, dir, player);
            longest_run = longest_run.max(span);
            pressure += (span * span * (1 + open_ends)) as f64;
            if min_len.is_some_and(|min_len| span >= min_len && open_ends >= 1) {
                open_threats += 1;
            }
        }
    }

    (longest_run, pressure, open_threats)
}

fn double_threat_count(game: &Game, stones: &[Cube], player: Player) -> i32 {
    let mut seen = FxHashSet::with_capacity_and_hasher(stones.len() * 6, Default::default());
    let mut count = 0;
    for stone in stones.iter().copied() {
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

fn gap_threat_count(game: &Game, stones: &[Cube], player: Player) -> i32 {
    let mut count = 0;
    for stone in stones.iter().copied() {
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

fn largest_cluster_size(stones: &FxHashSet<Cube>) -> i32 {
    if stones.is_empty() {
        return 0;
    }

    let mut visited = FxHashSet::default();
    let mut best = 0;
    for &start in stones {
        if visited.contains(&start) {
            continue;
        }
        let mut size = 0;
        let mut stack = Vec::with_capacity(stones.len());
        stack.push(start);
        while let Some(current) = stack.pop() {
            if !visited.insert(current) {
                continue;
            }
            size += 1;
            for dir in ALL_DIRS {
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

fn isolated_piece_count(stones: &FxHashSet<Cube>) -> i32 {
    stones
        .iter()
        .filter(|&&stone| {
            !ALL_DIRS.iter().copied().any(|dir| {
                stones.contains(&offset(stone, dir))
                    || stones.contains(&offset(stone, scale(dir, 2)))
            })
        })
        .count() as i32
}

fn center_proximity_score(stones: &[Cube]) -> f64 {
    stones
        .iter()
        .copied()
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

fn span_and_open_ends(game: &Game, start: Cube, delta: Cube, player: Player) -> (i32, i32) {
    let backward = negate(delta);
    let back_open = i32::from(game.stone_at(offset(start, backward)).is_none());

    let mut span = 1;
    let mut cursor = offset(start, delta);
    while game.stone_at(cursor) == Some(player) {
        span += 1;
        cursor = offset(cursor, delta);
    }

    let front_open = i32::from(game.stone_at(cursor).is_none());
    (span, back_open + front_open)
}

fn virtual_line_length(game: &Game, candidate: Cube, axis: Cube, player: Player) -> i32 {
    1 + run_length(game, candidate, axis, player)
        + run_length(game, candidate, negate(axis), player)
}

