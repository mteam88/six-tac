#![forbid(unsafe_code)]

mod ambrosia;
#[cfg(not(target_arch = "wasm32"))]
pub mod arena;
mod hydra;
mod seal;
mod shared;

use hex_tic_tac_engine::{Cube, Game};
use serde::{Deserialize, Serialize};
use std::fmt;
use std::str::FromStr;
use wasm_bindgen::prelude::*;

#[cfg(not(target_arch = "wasm32"))]
pub use arena::{
    run_compare, run_compare_with_progress, run_elo, run_elo_with_progress, run_match,
    run_match_with_progress, BotRecord, CompareConfig, CompareProgress, CompareSummary,
    CompareVerdict, EloConfig, EloMatchupSummary, EloProgress, EloStanding, EloSummary,
    MatchConfig, MatchProgress, MatchSummary, SeatRecord,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BotName {
    Sprout,
    Seal,
    Ambrosia,
    Hydra,
}

impl BotName {
    pub const ALL: [Self; 4] = [Self::Sprout, Self::Seal, Self::Ambrosia, Self::Hydra];

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Sprout => "sprout",
            Self::Seal => "seal",
            Self::Ambrosia => "ambrosia",
            Self::Hydra => "hydra",
        }
    }
}

impl FromStr for BotName {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "sprout" => Ok(Self::Sprout),
            "seal" => Ok(Self::Seal),
            "ambrosia" => Ok(Self::Ambrosia),
            "hydra" => Ok(Self::Hydra),
            _ => Err(format!("unknown bot: {value}")),
        }
    }
}

impl fmt::Display for BotName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

pub fn choose_move(bot_name: BotName, game: &Game) -> Result<[Cube; 2], String> {
    let mut rng = shared::RuntimeRng::new();
    choose_move_with_rng(bot_name, game, &mut rng)
}

pub(crate) fn choose_move_with_rng<R: shared::IndexRng>(
    bot_name: BotName,
    game: &Game,
    rng: &mut R,
) -> Result<[Cube; 2], String> {
    match bot_name {
        BotName::Sprout => shared::choose_random_legal_move_with_rng(game, rng),
        BotName::Seal => seal::choose_seal_move(game),
        BotName::Ambrosia => ambrosia::choose_ambrosia_move(game),
        BotName::Hydra => hydra::choose_hydra_move(game),
    }
}

#[derive(Serialize)]
struct BotMoveView {
    stones: [Cube; 2],
}

#[derive(Serialize)]
struct BotListView {
    bots: [BotName; 4],
}

#[derive(Deserialize)]
struct BotRequest {
    game_json: String,
    bot_name: String,
}

#[wasm_bindgen]
pub fn list_bots_json() -> Result<String, JsValue> {
    serde_json::to_string(&BotListView { bots: BotName::ALL })
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

    let stones = choose_move(bot_name, &game).map_err(|error| JsValue::from_str(&error))?;

    serde_json::to_string(&BotMoveView { stones })
        .map_err(|error| JsValue::from_str(&error.to_string()))
}

#[wasm_bindgen]
pub fn best_move_request_json(request_json: &str) -> Result<String, JsValue> {
    let request = serde_json::from_str::<BotRequest>(request_json)
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    best_move_json(&request.bot_name, &request.game_json)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_named_bots() {
        assert_eq!(BotName::from_str("ambrosia").unwrap(), BotName::Ambrosia);
        assert_eq!(BotName::from_str("hydra").unwrap(), BotName::Hydra);
        assert!(BotName::from_str("abrosia").is_err());
    }

    #[test]
    fn all_named_bots_produce_legal_opening_moves() {
        let game = Game::new();
        for bot in BotName::ALL {
            let stones = choose_move(bot, &game).unwrap();
            assert!(
                game.is_legal(stones),
                "{bot} returned an illegal opening move"
            );
        }
    }
}
