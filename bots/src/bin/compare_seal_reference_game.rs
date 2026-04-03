#[cfg(target_arch = "wasm32")]
fn main() {}

#[cfg(not(target_arch = "wasm32"))]
use hex_tic_tac_engine::{Cube, Game, TurnList};
#[cfg(not(target_arch = "wasm32"))]
use serde::Deserialize;
#[cfg(not(target_arch = "wasm32"))]
use six_tac_bots::{choose_move, BotName};
#[cfg(not(target_arch = "wasm32"))]
use std::env;
#[cfg(not(target_arch = "wasm32"))]
use std::fs;
#[cfg(not(target_arch = "wasm32"))]
use std::path::PathBuf;
#[cfg(not(target_arch = "wasm32"))]
use std::process::Command;

#[cfg(not(target_arch = "wasm32"))]
#[derive(Deserialize)]
struct FrontendGameFile {
    #[serde(default)]
    #[allow(dead_code)]
    format: Option<String>,
    #[serde(rename = "gameJson")]
    game_json: Option<String>,
    turns: Option<Vec<serde_json::Value>>,
}

#[cfg(not(target_arch = "wasm32"))]
fn main() -> Result<(), String> {
    let mut repo = "/tmp/HexTicTacToe".to_string();
    let mut game_file = None::<PathBuf>;
    let mut limit = None::<usize>;

    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--repo" => repo = args.next().ok_or("missing value for --repo")?,
            "--game-file" => game_file = Some(PathBuf::from(args.next().ok_or("missing value for --game-file")?)),
            "--limit" => {
                limit = Some(
                    args.next()
                        .ok_or("missing value for --limit")?
                        .parse()
                        .map_err(|_| "invalid --limit")?,
                )
            }
            other => return Err(format!("unknown arg: {other}")),
        }
    }

    let game_file = game_file.ok_or("usage: --game-file PATH")?;
    let turn_list = load_turn_list(&game_file)?;
    let total_positions = limit.unwrap_or(turn_list.turns.len()).min(turn_list.turns.len());

    let mut prefixes = Vec::with_capacity(total_positions);
    let mut game = Game::new();
    for turn in turn_list.turns.iter().take(total_positions).copied() {
        prefixes.push(game.to_json().map_err(|error| error.to_string())?);
        game.play(turn.stones).map_err(|error| error.to_string())?;
    }

    let reference_moves = reference_moves(&repo, &prefixes)?;
    let mut mismatches = 0usize;
    let mut game = Game::new();

    for (index, turn) in turn_list.turns.iter().take(total_positions).copied().enumerate() {
        let local = normalize_pair(choose_move(BotName::Seal, &game)?);
        let reference = normalize_pair(reference_moves[index]);
        if local != reference {
            mismatches += 1;
            eprintln!("mismatch #{mismatches} at ply {index}");
            eprintln!("  game: {}", prefixes[index]);
            eprintln!("  local:     {}", format_pair(local));
            eprintln!("  reference: {}", format_pair(reference));
        }
        game.play(turn.stones).map_err(|error| error.to_string())?;
    }

    println!(
        "checked {total_positions} positions from {}, mismatches: {mismatches}, match rate: {:.1}%",
        game_file.display(),
        100.0 * (total_positions.saturating_sub(mismatches)) as f64 / total_positions.max(1) as f64
    );
    Ok(())
}

#[cfg(not(target_arch = "wasm32"))]
fn load_turn_list(path: &PathBuf) -> Result<TurnList, String> {
    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let wrapper = serde_json::from_str::<FrontendGameFile>(&content).map_err(|error| error.to_string())?;
    if let Some(game_json) = wrapper.game_json {
        return TurnList::from_json_str(&game_json).map_err(|error| error.to_string());
    }
    if let Some(turns) = wrapper.turns {
        return serde_json::from_value(serde_json::json!({ "turns": turns }))
            .map_err(|error| error.to_string());
    }
    TurnList::from_json_str(&content).map_err(|error| error.to_string())
}

#[cfg(not(target_arch = "wasm32"))]
fn reference_moves(repo: &str, prefixes: &[String]) -> Result<Vec<[Cube; 2]>, String> {
    let temp_path = env::temp_dir().join("seal-prefixes.json");
    fs::write(&temp_path, serde_json::to_vec(prefixes).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;

    let script = r#"
import json, os, sys
repo = sys.argv[1]
prefix_file = sys.argv[2]
sys.path.insert(0, repo)
from ai import MinimaxBot
from game import HexGame

with open(prefix_file) as f:
    prefixes = json.load(f)

pattern_path = os.path.join(repo, 'learned_eval', 'results_baseline_8k', 'pattern_values.json')
results = []
for game_json in prefixes:
    game = HexGame()
    game.make_move(0, 0)
    if game_json.strip():
        turns = json.loads(game_json).get('turns', [])
        for turn in turns:
            for stone in turn.get('stones', []):
                if not game.make_move(stone['x'], stone['z']):
                    raise RuntimeError(f'failed to play stone {stone}')
    bot = MinimaxBot(time_limit=0.05, pattern_path=pattern_path)
    move = bot.get_move(game)
    results.append(move)
print(json.dumps(results))
"#;

    let output = Command::new("python3")
        .arg("-c")
        .arg(script)
        .arg(repo)
        .arg(&temp_path)
        .output()
        .map_err(|error| format!("failed to run python3: {error}"))?;

    let _ = fs::remove_file(&temp_path);

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    let raw = String::from_utf8(output.stdout).map_err(|error| error.to_string())?;
    let moves = serde_json::from_str::<Vec<Vec<(i32, i32)>>>(&raw).map_err(|error| error.to_string())?;
    moves
        .into_iter()
        .map(|entry| match entry.as_slice() {
            [a, b] => Ok([Cube::from_axial(a.0, a.1), Cube::from_axial(b.0, b.1)]),
            [a] => {
                let coord = Cube::from_axial(a.0, a.1);
                Ok([coord, coord])
            }
            _ => Err(format!("unexpected reference move shape: {entry:?}")),
        })
        .collect()
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
