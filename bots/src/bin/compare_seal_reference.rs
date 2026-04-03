#[cfg(target_arch = "wasm32")]
fn main() {}

#[cfg(not(target_arch = "wasm32"))]
use hex_tic_tac_engine::{Cube, Game};
#[cfg(not(target_arch = "wasm32"))]
use six_tac_bots::{choose_move, BotName};
#[cfg(not(target_arch = "wasm32"))]
use std::env;
#[cfg(not(target_arch = "wasm32"))]
use std::process::Command;

#[cfg(not(target_arch = "wasm32"))]
fn main() -> Result<(), String> {
    let mut repo = "/tmp/HexTicTacToe".to_string();
    let mut positions = 20usize;
    let mut max_turns = 10usize;

    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--repo" => repo = args.next().ok_or("missing value for --repo")?,
            "--positions" => {
                positions = args
                    .next()
                    .ok_or("missing value for --positions")?
                    .parse()
                    .map_err(|_| "invalid --positions")?
            }
            "--max-turns" => {
                max_turns = args
                    .next()
                    .ok_or("missing value for --max-turns")?
                    .parse()
                    .map_err(|_| "invalid --max-turns")?
            }
            other => return Err(format!("unknown arg: {other}")),
        }
    }

    let mut mismatches = 0usize;
    for index in 0..positions {
        let game = sample_game(index, max_turns)?;
        let game_json = game.to_json().map_err(|error| error.to_string())?;
        let local = normalize_pair(choose_move(BotName::Seal, &game)?);
        let reference = normalize_pair(reference_move(&repo, &game_json)?);

        if local != reference {
            mismatches += 1;
            eprintln!("mismatch #{mismatches} at sample {index}");
            eprintln!("  game: {game_json}");
            eprintln!("  local:     {}", format_pair(local));
            eprintln!("  reference: {}", format_pair(reference));
        }
    }

    println!(
        "checked {positions} positions, mismatches: {mismatches}, match rate: {:.1}%",
        100.0 * (positions.saturating_sub(mismatches)) as f64 / positions.max(1) as f64
    );
    Ok(())
}

#[cfg(not(target_arch = "wasm32"))]
fn sample_game(seed: usize, max_turns: usize) -> Result<Game, String> {
    let mut game = Game::new();
    let plies = 2 + (seed % max_turns.max(1));
    for _ in 0..plies {
        if game.winner().is_some() {
            break;
        }
        let previous = game.clone();
        let active = if game.turn_count() % 2 == 0 {
            BotName::Sprout
        } else {
            BotName::Orca
        };
        let pair = choose_move(active, &game)?;
        game.play(pair).map_err(|error| error.to_string())?;
        if game.winner().is_some() {
            return Ok(previous);
        }
    }
    Ok(game)
}

#[cfg(not(target_arch = "wasm32"))]
fn reference_move(repo: &str, game_json: &str) -> Result<[Cube; 2], String> {
    let script = r#"
import json, os, sys
repo = sys.argv[1]
game_json = sys.argv[2]
sys.path.insert(0, repo)
from ai import MinimaxBot
from game import HexGame

game = HexGame()
game.make_move(0, 0)
if game_json.strip():
    turns = json.loads(game_json).get('turns', [])
    for turn in turns:
        for stone in turn.get('stones', []):
            if not game.make_move(stone['x'], stone['z']):
                raise RuntimeError(f'failed to play stone {stone}')

bot = MinimaxBot(
    time_limit=0.05,
    pattern_path=os.path.join(repo, 'learned_eval', 'results_baseline_8k', 'pattern_values.json'),
)
move = bot.get_move(game)
print(json.dumps(move))
"#;

    let output = Command::new("python3")
        .arg("-c")
        .arg(script)
        .arg(repo)
        .arg(game_json)
        .output()
        .map_err(|error| format!("failed to run python3: {error}"))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    let raw = String::from_utf8(output.stdout).map_err(|error| error.to_string())?;
    if let Ok(axial) = serde_json::from_str::<[(i32, i32); 2]>(raw.trim()) {
        return Ok([
            Cube::from_axial(axial[0].0, axial[0].1),
            Cube::from_axial(axial[1].0, axial[1].1),
        ]);
    }
    if let Ok(axial) = serde_json::from_str::<[(i32, i32); 1]>(raw.trim()) {
        let coord = Cube::from_axial(axial[0].0, axial[0].1);
        return Ok([coord, coord]);
    }
    Err(format!("failed to parse reference move {raw:?}"))
}

#[cfg(not(target_arch = "wasm32"))]
fn normalize_pair(mut pair: [Cube; 2]) -> [Cube; 2] {
    if cube_key(pair[1]) < cube_key(pair[0]) {
        pair.swap(0, 1);
    }
    pair
}

#[cfg(not(target_arch = "wasm32"))]
fn cube_key(coord: Cube) -> (i32, i32, i32) {
    (coord.x(), coord.y(), coord.z())
}

#[cfg(not(target_arch = "wasm32"))]
fn format_pair(pair: [Cube; 2]) -> String {
    format!(
        "[({}, {}, {}), ({}, {}, {})]",
        pair[0].x(),
        pair[0].y(),
        pair[0].z(),
        pair[1].x(),
        pair[1].y(),
        pair[1].z()
    )
}
