#![forbid(unsafe_code)]
#![warn(missing_docs)]

//! High-performance core engine for hex tic tac toe.
//!
//! The board is an infinite hex grid using cube coordinates.
//! This crate exposes a deliberately compact API:
//!
//! - the opening center stone for [`Player::One`] is implied;
//! - every public move is an atomic two-stone turn;
//! - the first explicit turn belongs to [`Player::Two`];
//! - game serialization is a JSON turn list, not a snapshot of full internal state.
//!
//! # Examples
//!
//! ```rust
//! use hex_tic_tac_engine::{Cube, Game, Player, TurnOutcome};
//!
//! let mut game = Game::new();
//! assert_eq!(game.current_player(), Player::Two);
//! assert_eq!(game.stone_count(), 1);
//!
//! assert_eq!(
//!     game.play([Cube::from_axial(1, 0), Cube::from_axial(2, 0)])?,
//!     TurnOutcome::TurnPassed {
//!         next_player: Player::One,
//!     }
//! );
//!
//! let json = game.to_json()?;
//! let restored = Game::from_json_str(&json)?;
//! assert_eq!(restored.turn_count(), 1);
//! # Ok::<(), Box<dyn std::error::Error>>(())
//! ```

use rustc_hash::{FxHashMap, FxHashSet};
use serde::{Deserialize, Serialize};
use std::error::Error;
use std::fmt;
use wasm_bindgen::prelude::*;

const WIN_LENGTH: u8 = 6;
const MAX_PLACEMENT_DISTANCE: u32 = 8;
const AXES: [(Cube, Cube); 3] = [
    (Cube::raw(1, -1, 0), Cube::raw(-1, 1, 0)),
    (Cube::raw(1, 0, -1), Cube::raw(-1, 0, 1)),
    (Cube::raw(0, 1, -1), Cube::raw(0, -1, 1)),
];

/// A player in a hex tic tac toe game.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Player {
    /// The opening player.
    One,
    /// The second player.
    Two,
}

impl Player {
    #[inline]
    const fn index(self) -> usize {
        match self {
            Self::One => 0,
            Self::Two => 1,
        }
    }

    /// Returns the opponent.
    #[must_use]
    #[inline]
    pub const fn other(self) -> Self {
        match self {
            Self::One => Self::Two,
            Self::Two => Self::One,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct CubeRepr {
    x: i32,
    y: i32,
    z: i32,
}

/// A cube coordinate on the infinite hex grid.
///
/// Cube coordinates always satisfy `x + y + z == 0`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(try_from = "CubeRepr", into = "CubeRepr")]
pub struct Cube {
    x: i32,
    y: i32,
    z: i32,
}

impl Cube {
    /// The center of the board.
    pub const ORIGIN: Self = Self::raw(0, 0, 0);

    /// Creates a cube coordinate if `x + y + z == 0`.
    #[must_use]
    #[inline]
    pub const fn new(x: i32, y: i32, z: i32) -> Option<Self> {
        if x + y + z == 0 {
            Some(Self { x, y, z })
        } else {
            None
        }
    }

    /// Creates a cube coordinate from axial coordinates `(q, r)`.
    #[must_use]
    #[inline]
    pub const fn from_axial(q: i32, r: i32) -> Self {
        Self::raw(q, -q - r, r)
    }

    #[inline]
    const fn raw(x: i32, y: i32, z: i32) -> Self {
        Self { x, y, z }
    }

    /// Returns the `x` component.
    #[must_use]
    #[inline]
    pub const fn x(self) -> i32 {
        self.x
    }

    /// Returns the `y` component.
    #[must_use]
    #[inline]
    pub const fn y(self) -> i32 {
        self.y
    }

    /// Returns the `z` component.
    #[must_use]
    #[inline]
    pub const fn z(self) -> i32 {
        self.z
    }

    /// Returns this cube coordinate as axial `(q, r)`.
    #[must_use]
    #[inline]
    pub const fn axial(self) -> (i32, i32) {
        (self.x, self.z)
    }

    /// Returns a neighboring coordinate by adding a cube delta.
    #[must_use]
    #[inline]
    pub const fn offset(self, delta: Cube) -> Self {
        Self::raw(self.x + delta.x, self.y + delta.y, self.z + delta.z)
    }

    /// Returns the hex distance to another coordinate.
    #[must_use]
    #[inline]
    pub const fn distance(self, other: Self) -> u32 {
        let dx = abs_i32(self.x - other.x) as u32;
        let dy = abs_i32(self.y - other.y) as u32;
        let dz = abs_i32(self.z - other.z) as u32;
        (dx + dy + dz) / 2
    }
}

/// Errors returned when constructing invalid cube coordinates.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CubeError;

impl fmt::Display for CubeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("invalid cube coordinate: x + y + z must equal 0")
    }
}

impl Error for CubeError {}

impl TryFrom<(i32, i32, i32)> for Cube {
    type Error = CubeError;

    fn try_from(value: (i32, i32, i32)) -> Result<Self, Self::Error> {
        Self::new(value.0, value.1, value.2).ok_or(CubeError)
    }
}

impl TryFrom<CubeRepr> for Cube {
    type Error = CubeError;

    fn try_from(value: CubeRepr) -> Result<Self, Self::Error> {
        Self::new(value.x, value.y, value.z).ok_or(CubeError)
    }
}

impl From<Cube> for CubeRepr {
    fn from(value: Cube) -> Self {
        Self {
            x: value.x,
            y: value.y,
            z: value.z,
        }
    }
}

/// A full explicit turn consisting of two stones.
///
/// The acting player is implied by the turn index:
/// turn `0` belongs to [`Player::Two`], turn `1` to [`Player::One`], and so on.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Turn {
    /// The two stones placed during the turn.
    pub stones: [Cube; 2],
}

impl Turn {
    /// Creates a new turn.
    #[must_use]
    #[inline]
    pub const fn new(stones: [Cube; 2]) -> Self {
        Self { stones }
    }
}

/// A turn-list representation of a game.
///
/// The implied opening stone at [`Cube::ORIGIN`] is not stored here.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TurnList {
    /// Explicit turns in play order.
    pub turns: Vec<Turn>,
}

impl TurnList {
    /// Serializes this turn list to compact JSON.
    pub fn to_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string(self)
    }

    /// Serializes this turn list to pretty-printed JSON.
    pub fn to_json_pretty(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string_pretty(self)
    }

    /// Parses a turn list from JSON.
    pub fn from_json_str(json: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(json)
    }
}

/// Result of applying a full two-stone turn.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TurnOutcome {
    /// The turn ended without a winner and control passed to the opponent.
    TurnPassed {
        /// The player who moves next.
        next_player: Player,
    },
    /// The turn created a winning line.
    Win {
        /// The winning player.
        winner: Player,
    },
}

/// Errors returned by [`Game::play`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TurnError {
    /// The first or second target cell is already occupied.
    Occupied(Cube),
    /// Both stones in the same turn target the same cell.
    DuplicateStone(Cube),
    /// A target cell is farther than the maximum allowed placement radius from all existing stones.
    TooFar(Cube),
    /// The game already has a winner.
    GameAlreadyOver(Player),
}

impl fmt::Display for TurnError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Occupied(cube) => write!(
                f,
                "cell ({}, {}, {}) is already occupied",
                cube.x(),
                cube.y(),
                cube.z()
            ),
            Self::DuplicateStone(cube) => write!(
                f,
                "turn contains the same cell twice: ({}, {}, {})",
                cube.x(),
                cube.y(),
                cube.z()
            ),
            Self::TooFar(cube) => write!(
                f,
                "cell ({}, {}, {}) is farther than {} hexes from every existing stone",
                cube.x(),
                cube.y(),
                cube.z(),
                MAX_PLACEMENT_DISTANCE
            ),
            Self::GameAlreadyOver(player) => write!(f, "game already won by {player:?}"),
        }
    }
}

impl Error for TurnError {}

/// Errors returned when reconstructing a game from a turn list.
#[derive(Debug)]
pub enum TurnListError {
    /// A specific turn was illegal when replayed.
    IllegalTurn {
        /// Zero-based turn index.
        turn_index: usize,
        /// The original legality error.
        source: TurnError,
    },
}

impl fmt::Display for TurnListError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::IllegalTurn { turn_index, source } => {
                write!(f, "turn {turn_index} is illegal: {source}")
            }
        }
    }
}

impl Error for TurnListError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::IllegalTurn { source, .. } => Some(source),
        }
    }
}

/// Errors returned when loading a game from JSON.
#[derive(Debug)]
pub enum GameJsonError {
    /// The JSON document could not be parsed.
    Json(serde_json::Error),
    /// The parsed turn list was structurally valid JSON but not a legal game.
    TurnList(TurnListError),
}

impl fmt::Display for GameJsonError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Json(source) => write!(f, "invalid game json: {source}"),
            Self::TurnList(source) => write!(f, "invalid turn list: {source}"),
        }
    }
}

impl Error for GameJsonError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Json(source) => Some(source),
            Self::TurnList(source) => Some(source),
        }
    }
}

impl From<serde_json::Error> for GameJsonError {
    fn from(value: serde_json::Error) -> Self {
        Self::Json(value)
    }
}

impl From<TurnListError> for GameJsonError {
    fn from(value: TurnListError) -> Self {
        Self::TurnList(value)
    }
}

/// Sparse, high-performance game state for hex tic tac toe.
///
/// The board is unbounded, so only occupied cells are stored.
/// The center opening stone is implied and always belongs to [`Player::One`].
#[derive(Clone, Debug)]
pub struct Game {
    occupied: FxHashMap<Cube, Player>,
    stones: [FxHashSet<Cube>; 2],
    winner: Option<Player>,
    history: Vec<Turn>,
}

impl Default for Game {
    fn default() -> Self {
        Self::new()
    }
}

impl Game {
    /// Creates the standard starting position.
    ///
    /// The returned state already includes the implied opening stone at
    /// [`Cube::ORIGIN`] for [`Player::One`], so [`Player::Two`] moves next.
    #[must_use]
    pub fn new() -> Self {
        Self::with_capacity(16)
    }

    /// Creates a game with space reserved for approximately `turns` explicit turns.
    #[must_use]
    pub fn with_capacity(turns: usize) -> Self {
        let stone_capacity = 1 + turns.saturating_mul(2);
        let occupied = FxHashMap::with_capacity_and_hasher(stone_capacity, Default::default());
        let player_capacity = stone_capacity.saturating_div(2).max(1);
        let stones = std::array::from_fn(|_| {
            FxHashSet::with_capacity_and_hasher(player_capacity, Default::default())
        });

        let mut game = Self {
            occupied,
            stones,
            winner: None,
            history: Vec::with_capacity(turns),
        };

        game.occupied.insert(Cube::ORIGIN, Player::One);
        game.stones[Player::One.index()].insert(Cube::ORIGIN);
        game
    }

    /// Reconstructs a game from a turn list.
    ///
    /// The implied opening at the origin is inserted automatically.
    ///
    /// # Errors
    ///
    /// Returns an error if any recorded turn is illegal.
    pub fn from_turn_list(turn_list: &TurnList) -> Result<Self, TurnListError> {
        let mut game = Self::with_capacity(turn_list.turns.len());

        for (turn_index, turn) in turn_list.turns.iter().copied().enumerate() {
            game.play(turn.stones)
                .map_err(|source| TurnListError::IllegalTurn { turn_index, source })?;
        }

        Ok(game)
    }

    /// Reconstructs a game from turn-list JSON.
    ///
    /// # Errors
    ///
    /// Returns [`GameJsonError::Json`] for malformed JSON and
    /// [`GameJsonError::TurnList`] for illegal turn sequences.
    pub fn from_json_str(json: &str) -> Result<Self, GameJsonError> {
        let turns = TurnList::from_json_str(json)?;
        Self::from_turn_list(&turns).map_err(GameJsonError::from)
    }

    /// Returns the player whose turn is currently active.
    ///
    /// If the game is over, this returns the winning player.
    #[must_use]
    #[inline]
    pub const fn current_player(&self) -> Player {
        match self.winner {
            Some(player) => player,
            None => player_for_turn_index(self.history.len()),
        }
    }

    /// Returns the winner, if any.
    #[must_use]
    #[inline]
    pub const fn winner(&self) -> Option<Player> {
        self.winner
    }

    /// Returns `true` if the game already has a winner.
    #[must_use]
    #[inline]
    pub const fn is_over(&self) -> bool {
        self.winner.is_some()
    }

    /// Returns the number of explicit two-stone turns that have been played.
    #[must_use]
    #[inline]
    pub fn turn_count(&self) -> u32 {
        self.history.len() as u32
    }

    /// Returns the total number of stones on the board, including the implied opening.
    #[must_use]
    #[inline]
    pub fn stone_count(&self) -> u32 {
        1 + self.turn_count() * 2
    }

    /// Returns the occupant at `coord`, if any.
    #[must_use]
    #[inline]
    pub fn stone_at(&self, coord: Cube) -> Option<Player> {
        self.occupied.get(&coord).copied()
    }

    /// Returns `true` if both target cells are currently empty, distinct, within the placement radius, and the game is not over.
    #[must_use]
    #[inline]
    pub fn is_legal(&self, stones: [Cube; 2]) -> bool {
        self.validate_turn_cells(stones).is_ok()
    }

    /// Applies a full two-stone turn for the current player.
    ///
    /// Both target cells must be empty before the turn starts.
    /// The two stones must also target distinct cells.
    ///
    /// # Errors
    ///
    /// Returns [`TurnError::GameAlreadyOver`] if the game is finished,
    /// [`TurnError::Occupied`] if either target is already occupied, or
    /// [`TurnError::DuplicateStone`] if the two targets are the same cell.
    pub fn play(&mut self, stones: [Cube; 2]) -> Result<TurnOutcome, TurnError> {
        self.validate_turn_cells(stones)?;

        let player = self.current_player();
        let [a, b] = stones;

        self.occupied.insert(a, player);
        self.occupied.insert(b, player);
        self.stones[player.index()].insert(a);
        self.stones[player.index()].insert(b);
        self.history.push(Turn::new(stones));

        if self.is_winning_placement(player, a) || self.is_winning_placement(player, b) {
            self.winner = Some(player);
            return Ok(TurnOutcome::Win { winner: player });
        }

        Ok(TurnOutcome::TurnPassed {
            next_player: player.other(),
        })
    }

    /// Undoes the last explicit two-stone turn.
    ///
    /// Returns the removed turn if one exists.
    pub fn undo(&mut self) -> Option<Turn> {
        let turn = self.history.pop()?;
        let [a, b] = turn.stones;

        self.occupied.remove(&a);
        self.occupied.remove(&b);

        let player = player_for_turn_index(self.history.len());
        self.stones[player.index()].remove(&a);
        self.stones[player.index()].remove(&b);
        self.winner = None;

        Some(turn)
    }

    /// Returns the length of the longest contiguous line for `player`
    /// passing through `coord`.
    #[must_use]
    pub fn line_length_through(&self, player: Player, coord: Cube) -> u8 {
        let mut best = 1;
        for (forward, backward) in AXES {
            let length = 1
                + self.count_direction(player, coord, forward)
                + self.count_direction(player, coord, backward);
            best = best.max(length);
        }
        best
    }

    /// Returns an iterator over all occupied cells as `(coord, player)` pairs.
    #[must_use]
    pub fn stones(&self) -> impl Iterator<Item = (Cube, Player)> + '_ {
        self.occupied
            .iter()
            .map(|(&coord, &player)| (coord, player))
    }

    /// Returns an iterator over all stones owned by `player`.
    #[must_use]
    pub fn stones_for(&self, player: Player) -> impl Iterator<Item = Cube> + '_ {
        self.stones[player.index()].iter().copied()
    }

    /// Returns an iterator over all explicit turns in play order.
    #[must_use]
    pub fn turns(&self) -> impl Iterator<Item = Turn> + '_ {
        self.history.iter().copied()
    }

    /// Exports the game as a turn list.
    #[must_use]
    pub fn to_turn_list(&self) -> TurnList {
        TurnList {
            turns: self.history.clone(),
        }
    }

    /// Serializes the game to compact turn-list JSON.
    pub fn to_json(&self) -> Result<String, serde_json::Error> {
        self.to_turn_list().to_json()
    }

    /// Serializes the game to pretty-printed turn-list JSON.
    pub fn to_json_pretty(&self) -> Result<String, serde_json::Error> {
        self.to_turn_list().to_json_pretty()
    }

    #[inline]
    fn validate_turn_cells(&self, stones: [Cube; 2]) -> Result<(), TurnError> {
        if let Some(winner) = self.winner {
            return Err(TurnError::GameAlreadyOver(winner));
        }

        let [a, b] = stones;
        if a == b {
            return Err(TurnError::DuplicateStone(a));
        }
        if self.occupied.contains_key(&a) {
            return Err(TurnError::Occupied(a));
        }
        if self.occupied.contains_key(&b) {
            return Err(TurnError::Occupied(b));
        }
        if !self.is_within_placement_range(a) {
            return Err(TurnError::TooFar(a));
        }
        if !self.is_within_placement_range(b) {
            return Err(TurnError::TooFar(b));
        }

        Ok(())
    }

    #[inline]
    fn is_within_placement_range(&self, coord: Cube) -> bool {
        self.occupied
            .keys()
            .any(|&occupied| occupied.distance(coord) <= MAX_PLACEMENT_DISTANCE)
    }

    #[inline]
    fn is_winning_placement(&self, player: Player, coord: Cube) -> bool {
        self.line_length_through(player, coord) >= WIN_LENGTH
    }

    #[inline]
    fn count_direction(&self, player: Player, start: Cube, delta: Cube) -> u8 {
        let player_stones = &self.stones[player.index()];
        let mut cursor = start.offset(delta);
        let mut count = 0u8;

        while player_stones.contains(&cursor) {
            count += 1;
            cursor = cursor.offset(delta);
        }

        count
    }
}

#[inline]
const fn player_for_turn_index(turn_index: usize) -> Player {
    if turn_index % 2 == 0 {
        Player::Two
    } else {
        Player::One
    }
}

#[inline]
const fn abs_i32(value: i32) -> i32 {
    if value < 0 {
        -value
    } else {
        value
    }
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

fn game_from_json(game_json: &str) -> Result<Game, Box<dyn Error>> {
    if game_json.trim().is_empty() {
        Ok(Game::new())
    } else {
        Ok(Game::from_json_str(game_json)?)
    }
}

fn snapshot_from_game(game: &Game) -> Result<SnapshotView, Box<dyn Error>> {
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

fn snapshot_json_impl(game_json: &str) -> Result<String, Box<dyn Error>> {
    let game = game_from_json(game_json)?;
    Ok(serde_json::to_string(&snapshot_from_game(&game)?)?)
}

fn play_json_impl(game_json: &str, stones_json: &str) -> Result<String, Box<dyn Error>> {
    let stones = serde_json::from_str::<[Cube; 2]>(stones_json)?;
    let mut game = game_from_json(game_json)?;
    match game.play(stones)? {
        TurnOutcome::TurnPassed { .. } | TurnOutcome::Win { .. } => {
            Ok(serde_json::to_string(&snapshot_from_game(&game)?)?)
        }
    }
}

/// Returns a JSON snapshot of a game from turn-list JSON.
#[wasm_bindgen]
pub fn snapshot_json(game_json: &str) -> Result<String, JsValue> {
    snapshot_json_impl(game_json).map_err(|error| JsValue::from_str(&error.to_string()))
}

/// Applies a two-stone turn encoded as JSON and returns the next snapshot as JSON.
#[wasm_bindgen]
pub fn play_json(game_json: &str, stones_json: &str) -> Result<String, JsValue> {
    play_json_impl(game_json, stones_json).map_err(|error| JsValue::from_str(&error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standard_game_starts_after_implied_opening() {
        let game = Game::new();
        assert_eq!(game.turn_count(), 0);
        assert_eq!(game.stone_count(), 1);
        assert_eq!(game.stone_at(Cube::ORIGIN), Some(Player::One));
        assert_eq!(game.current_player(), Player::Two);
        assert_eq!(game.winner(), None);
    }

    #[test]
    fn turn_flow_is_atomic() {
        let mut game = Game::new();

        assert_eq!(
            game.play([Cube::from_axial(1, 0), Cube::from_axial(2, 0)])
                .unwrap(),
            TurnOutcome::TurnPassed {
                next_player: Player::One,
            }
        );
        assert_eq!(game.current_player(), Player::One);
        assert_eq!(game.turn_count(), 1);
        assert_eq!(game.stone_count(), 3);
    }

    #[test]
    fn rejects_duplicate_stone_in_same_turn() {
        let mut game = Game::new();
        let coord = Cube::from_axial(1, 0);
        let err = game.play([coord, coord]).unwrap_err();
        assert_eq!(err, TurnError::DuplicateStone(coord));
    }

    #[test]
    fn rejects_occupied_cells() {
        let mut game = Game::new();
        let err = game
            .play([Cube::ORIGIN, Cube::from_axial(1, 0)])
            .unwrap_err();
        assert_eq!(err, TurnError::Occupied(Cube::ORIGIN));
    }

    #[test]
    fn rejects_cells_outside_max_placement_distance() {
        let mut game = Game::new();
        let coord = Cube::from_axial(9, 0);
        let err = game
            .play([coord, Cube::from_axial(1, 0)])
            .unwrap_err();
        assert_eq!(err, TurnError::TooFar(coord));
        assert!(!game.is_legal([coord, Cube::from_axial(1, 0)]));
    }

    #[test]
    fn detects_wins_after_full_turn() {
        let mut game = Game::new();

        for &coord in &[
            Cube::from_axial(10, 0),
            Cube::from_axial(11, 0),
            Cube::from_axial(12, 0),
            Cube::from_axial(13, 0),
            Cube::from_axial(14, 0),
        ] {
            game.occupied.insert(coord, Player::Two);
            game.stones[Player::Two.index()].insert(coord);
        }

        let outcome = game
            .play([Cube::from_axial(15, 0), Cube::from_axial(20, 0)])
            .unwrap();
        assert_eq!(
            outcome,
            TurnOutcome::Win {
                winner: Player::Two
            }
        );
        assert_eq!(game.winner(), Some(Player::Two));
        assert_eq!(game.current_player(), Player::Two);
    }

    #[test]
    fn undo_restores_previous_state() {
        let mut game = Game::new();
        let turn = Turn::new([Cube::from_axial(1, 0), Cube::from_axial(2, 0)]);

        game.play(turn.stones).unwrap();

        assert_eq!(game.undo(), Some(turn));
        assert_eq!(game.current_player(), Player::Two);
        assert_eq!(game.turn_count(), 0);
        assert_eq!(game.stone_count(), 1);
        assert_eq!(game.stone_at(turn.stones[0]), None);
        assert_eq!(game.stone_at(turn.stones[1]), None);
        assert_eq!(game.stone_at(Cube::ORIGIN), Some(Player::One));
    }

    #[test]
    fn json_round_trip_uses_turn_list() {
        let mut game = Game::new();
        game.play([Cube::from_axial(1, 0), Cube::from_axial(2, 0)])
            .unwrap();
        game.play([Cube::from_axial(0, 1), Cube::from_axial(0, 2)])
            .unwrap();

        let json = game.to_json().unwrap();
        let restored = Game::from_json_str(&json).unwrap();

        assert_eq!(restored.turn_count(), 2);
        assert_eq!(restored.current_player(), game.current_player());
        assert_eq!(restored.winner(), game.winner());
        assert_eq!(restored.to_turn_list(), game.to_turn_list());
        assert_eq!(restored.stone_count(), game.stone_count());
    }

    #[test]
    fn illegal_turn_list_is_rejected() {
        let err = Game::from_turn_list(&TurnList {
            turns: vec![Turn::new([Cube::ORIGIN, Cube::from_axial(2, 0)])],
        })
        .unwrap_err();

        match err {
            TurnListError::IllegalTurn { turn_index, source } => {
                assert_eq!(turn_index, 0);
                assert_eq!(source, TurnError::Occupied(Cube::ORIGIN));
            }
        }
    }

    #[test]
    fn invalid_cube_json_is_rejected() {
        let err = TurnList::from_json_str(
            r#"{"turns":[{"stones":[{"x":1,"y":1,"z":1},{"x":2,"y":-2,"z":0}]}]}"#,
        )
        .unwrap_err();

        assert!(err.to_string().contains("x + y + z must equal 0"));
    }

    #[test]
    fn cube_distance_matches_hex_metric() {
        let a = Cube::from_axial(0, 0);
        let b = Cube::from_axial(3, -2);
        assert_eq!(a.distance(b), 3);
    }
}
