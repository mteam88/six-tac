use hex_tic_tac_engine::{Cube, Game, Player, TurnOutcome};
use serde::{Deserialize, Serialize};
use std::io::{self, Read};

#[derive(Deserialize)]
#[serde(tag = "command", rename_all = "snake_case")]
enum Request {
    Snapshot { game_json: String },
    Play { game_json: String, stones: [Cube; 2] },
}

#[derive(Serialize)]
struct StoneView {
    x: i32,
    y: i32,
    z: i32,
    player: Player,
}

#[derive(Serialize)]
struct SnapshotView {
    current_player: Player,
    winner: Option<Player>,
    turn_count: u32,
    stone_count: u32,
    turns_json: String,
    stones: Vec<StoneView>,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;
    let request: Request = serde_json::from_str(&input)?;

    let snapshot = match request {
        Request::Snapshot { game_json } => snapshot_from_json(&game_json)?,
        Request::Play { game_json, stones } => {
            let mut game = game_from_json(&game_json)?;
            match game.play(stones)? {
                TurnOutcome::TurnPassed { .. } | TurnOutcome::Win { .. } => snapshot_from_game(&game)?,
            }
        }
    };

    println!("{}", serde_json::to_string(&snapshot)?);
    Ok(())
}

fn game_from_json(game_json: &str) -> Result<Game, Box<dyn std::error::Error>> {
    if game_json.trim().is_empty() {
        Ok(Game::new())
    } else {
        Ok(Game::from_json_str(game_json)?)
    }
}

fn snapshot_from_json(game_json: &str) -> Result<SnapshotView, Box<dyn std::error::Error>> {
    let game = game_from_json(game_json)?;
    snapshot_from_game(&game)
}

fn snapshot_from_game(game: &Game) -> Result<SnapshotView, Box<dyn std::error::Error>> {
    let mut stones = game
        .stones()
        .map(|(cube, player)| StoneView {
            x: cube.x(),
            y: cube.y(),
            z: cube.z(),
            player,
        })
        .collect::<Vec<_>>();

    stones.sort_by_key(|stone| (stone.x, stone.y, stone.z));

    Ok(SnapshotView {
        current_player: game.current_player(),
        winner: game.winner(),
        turn_count: game.turn_count(),
        stone_count: game.stone_count(),
        turns_json: game.to_json()?,
        stones,
    })
}
