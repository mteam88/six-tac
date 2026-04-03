#![forbid(unsafe_code)]

mod ambrosia;
mod seal;
mod shared;

use hex_tic_tac_engine::Game;
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum BotName {
    Sprout,
    Seal,
    Ambrosia,
}

impl BotName {
    fn from_str(value: &str) -> Result<Self, String> {
        match value {
            "sprout" => Ok(Self::Sprout),
            "seal" => Ok(Self::Seal),
            "ambrosia" => Ok(Self::Ambrosia),
            _ => Err(format!("unknown bot: {value}")),
        }
    }
}

#[derive(Serialize)]
struct BotMoveView {
    stones: [hex_tic_tac_engine::Cube; 2],
}

#[derive(Serialize)]
struct BotListView {
    bots: [BotName; 3],
}

#[derive(Deserialize)]
struct BotRequest {
    game_json: String,
    bot_name: String,
}

#[wasm_bindgen]
pub fn list_bots_json() -> Result<String, JsValue> {
    serde_json::to_string(&BotListView {
        bots: [BotName::Sprout, BotName::Seal, BotName::Ambrosia],
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
        BotName::Sprout => shared::choose_random_legal_move(&game),
        BotName::Seal => seal::choose_seal_move(&game),
        BotName::Ambrosia => ambrosia::choose_ambrosia_move(&game),
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
