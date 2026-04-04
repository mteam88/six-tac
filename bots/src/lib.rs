mod ambrosia;
#[cfg(not(target_arch = "wasm32"))]
pub mod arena;
mod hydra;
#[cfg(not(target_arch = "wasm32"))]
mod kraken;
mod orca;
mod seal_vendor;
mod shared;

use hex_tic_tac_engine::{Cube, Game};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::fmt;
use std::str::FromStr;
use wasm_bindgen::prelude::*;

#[cfg(not(target_arch = "wasm32"))]
pub use arena::{
    run_compare, run_compare_with_frontend_games, run_compare_with_frontend_games_and_progress,
    run_compare_with_progress, run_elo, run_elo_with_frontend_games,
    run_elo_with_frontend_games_and_progress, run_elo_with_progress, run_match,
    run_match_with_frontend_games, run_match_with_frontend_games_and_progress,
    run_match_with_progress, BotRecord, CompareConfig, CompareProgress, CompareSummary,
    CompareVerdict, EloConfig, EloMatchupSummary, EloProgress, EloStanding, EloSummary,
    FrontendGameFile, FrontendGameSource, MatchConfig, MatchProgress, MatchSummary, SeatRecord,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BotName {
    Sprout,
    Seal,
    Ambrosia,
    Hydra,
    Orca,
    Kraken,
}

impl BotName {
    #[cfg(target_arch = "wasm32")]
    pub const ALL: [Self; 5] = [
        Self::Sprout,
        Self::Seal,
        Self::Ambrosia,
        Self::Hydra,
        Self::Orca,
    ];

    #[cfg(not(target_arch = "wasm32"))]
    pub const ALL: [Self; 6] = [
        Self::Sprout,
        Self::Seal,
        Self::Ambrosia,
        Self::Hydra,
        Self::Orca,
        Self::Kraken,
    ];

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Sprout => "sprout",
            Self::Seal => "seal",
            Self::Ambrosia => "ambrosia",
            Self::Hydra => "hydra",
            Self::Orca => "orca",
            Self::Kraken => "kraken",
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
            "orca" => Ok(Self::Orca),
            "kraken" => Ok(Self::Kraken),
            _ => Err(format!("unknown bot: {value}")),
        }
    }
}

impl fmt::Display for BotName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[cfg(not(target_arch = "wasm32"))]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum BotParams {
    #[default]
    None,
    Kraken {
        sims: usize,
    },
}

#[cfg(not(target_arch = "wasm32"))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct BotSpec {
    pub name: BotName,
    pub params: BotParams,
}

#[cfg(not(target_arch = "wasm32"))]
impl BotSpec {
    #[must_use]
    pub const fn new(name: BotName) -> Self {
        Self {
            name,
            params: BotParams::None,
        }
    }

    #[must_use]
    pub const fn kraken_with_sims(sims: usize) -> Self {
        Self {
            name: BotName::Kraken,
            params: BotParams::Kraken { sims },
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl Default for BotSpec {
    fn default() -> Self {
        Self::new(BotName::Sprout)
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl From<BotName> for BotSpec {
    fn from(name: BotName) -> Self {
        Self::new(name)
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl FromStr for BotSpec {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let (name_text, params_text) = match value.split_once('@') {
            Some((name, params)) => (name, Some(params)),
            None => (value, None),
        };

        let name = BotName::from_str(name_text)?;
        let mut spec = Self::from(name);

        let Some(params_text) = params_text else {
            return Ok(spec);
        };
        if params_text.trim().is_empty() {
            return Err(format!("missing parameters for bot spec: {value}"));
        }

        match name {
            BotName::Kraken => {
                let mut sims = None;
                for part in params_text.split(',') {
                    let (key, raw_value) = part
                        .split_once('=')
                        .ok_or_else(|| format!("invalid bot parameter '{part}' in {value}"))?;
                    let key = key.trim();
                    let raw_value = raw_value.trim();
                    match key {
                        "sims" | "n_sims" => {
                            if sims.is_some() {
                                return Err(format!("duplicate sims parameter in {value}"));
                            }
                            let parsed = raw_value.parse::<usize>().map_err(|error| {
                                format!("invalid sims value '{raw_value}': {error}")
                            })?;
                            if parsed == 0 {
                                return Err("kraken sims must be at least 1".to_string());
                            }
                            sims = Some(parsed);
                        }
                        _ => {
                            return Err(format!("unknown parameter '{key}' for bot {name}"));
                        }
                    }
                }

                if let Some(sims) = sims {
                    spec.params = BotParams::Kraken { sims };
                    Ok(spec)
                } else {
                    Err(format!("kraken bot specs must include sims=...: {value}"))
                }
            }
            _ => Err(format!("bot {name} does not accept parameters: {value}")),
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl fmt::Display for BotSpec {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.params {
            BotParams::None => write!(f, "{}", self.name),
            BotParams::Kraken { sims } => write!(f, "{}@sims={sims}", self.name),
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl Serialize for BotSpec {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl<'de> Deserialize<'de> for BotSpec {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::from_str(&value).map_err(serde::de::Error::custom)
    }
}

pub fn choose_move(bot_name: BotName, game: &Game) -> Result<[Cube; 2], String> {
    let mut rng = shared::RuntimeRng::new();
    choose_move_with_rng(bot_name, game, &mut rng)
}

#[cfg(not(target_arch = "wasm32"))]
pub fn choose_move_cached(
    bot_name: BotName,
    game: &Game,
    cache_key: Option<&str>,
) -> Result<[Cube; 2], String> {
    match bot_name {
        BotName::Kraken => kraken::choose_kraken_move_cached(game, cache_key),
        _ => choose_move(bot_name, game),
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub fn choose_move_cached_peek(
    bot_name: BotName,
    game: &Game,
    cache_key: Option<&str>,
) -> Result<[Cube; 2], String> {
    match bot_name {
        BotName::Kraken => kraken::choose_kraken_move_cached_peek(game, cache_key),
        _ => choose_move(bot_name, game),
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub fn choose_move_uncached(bot_name: BotName, game: &Game) -> Result<[Cube; 2], String> {
    match bot_name {
        BotName::Kraken => kraken::choose_kraken_move_uncached(game),
        _ => choose_move(bot_name, game),
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub fn is_bot_available(bot_name: BotName) -> bool {
    match bot_name {
        BotName::Kraken => kraken::is_kraken_available(),
        _ => true,
    }
}

pub(crate) fn choose_move_with_rng<R: shared::IndexRng>(
    bot_name: BotName,
    game: &Game,
    rng: &mut R,
) -> Result<[Cube; 2], String> {
    match bot_name {
        BotName::Sprout => shared::choose_random_legal_move_with_rng(game, rng),
        BotName::Seal => seal_vendor::choose_seal_move(game),
        BotName::Ambrosia => ambrosia::choose_ambrosia_move(game),
        BotName::Hydra => hydra::choose_hydra_move(game),
        BotName::Orca => orca::choose_orca_move(game),
        #[cfg(not(target_arch = "wasm32"))]
        BotName::Kraken => kraken::choose_kraken_move(game),
        #[cfg(target_arch = "wasm32")]
        BotName::Kraken => {
            Err("kraken is only available through the native bot service".to_string())
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn choose_move_for_spec_with_rng<R: shared::IndexRng>(
    spec: BotSpec,
    game: &Game,
    rng: &mut R,
) -> Result<[Cube; 2], String> {
    match spec {
        BotSpec {
            name: BotName::Kraken,
            params: BotParams::Kraken { sims },
        } => kraken::choose_kraken_move_with_sims(game, sims),
        BotSpec {
            name: BotName::Kraken,
            params: BotParams::None,
        } => kraken::choose_kraken_move(game),
        BotSpec { name, .. } => choose_move_with_rng(name, game, rng),
    }
}

#[derive(Serialize)]
struct BotMoveView {
    stones: [Cube; 2],
}

#[derive(Serialize)]
struct BotListView {
    bots: Vec<BotName>,
}

#[derive(Deserialize)]
struct BotRequest {
    game_json: String,
    bot_name: String,
}

#[wasm_bindgen]
pub fn list_bots_json() -> Result<String, JsValue> {
    serde_json::to_string(&BotListView {
        bots: BotName::ALL.to_vec(),
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
        assert_eq!(BotName::from_str("orca").unwrap(), BotName::Orca);
        assert_eq!(BotName::from_str("kraken").unwrap(), BotName::Kraken);
        assert!(BotName::from_str("abrosia").is_err());
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn parses_bot_specs() {
        assert_eq!(
            BotSpec::from_str("hydra").unwrap(),
            BotSpec::from(BotName::Hydra)
        );
        assert_eq!(
            BotSpec::from_str("kraken@sims=400").unwrap(),
            BotSpec::kraken_with_sims(400)
        );
        assert_eq!(
            BotSpec::from_str("kraken@n_sims=800").unwrap(),
            BotSpec::kraken_with_sims(800)
        );
        assert!(BotSpec::from_str("hydra@sims=10").is_err());
        assert!(BotSpec::from_str("kraken@depth=4").is_err());
    }

    #[test]
    fn all_named_bots_produce_legal_opening_moves() {
        let game = Game::new();
        for bot in BotName::ALL {
            #[cfg(not(target_arch = "wasm32"))]
            if bot == BotName::Kraken && !crate::kraken::is_kraken_available() {
                continue;
            }

            let stones = choose_move(bot, &game).unwrap();
            assert!(
                game.is_legal(stones),
                "{bot} returned an illegal opening move"
            );
        }
    }
}
