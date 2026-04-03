use crate::{choose_move_with_rng, shared, BotName};
use hex_tic_tac_engine::{Game, Player};
use rayon::prelude::*;
use serde::Serialize;
use std::time::Instant;

#[derive(Clone, Copy, Debug, Serialize)]
pub struct MatchConfig {
    pub first: BotName,
    pub second: BotName,
    pub games: usize,
    pub max_turns: usize,
    pub seed: u64,
}

impl MatchConfig {
    #[must_use]
    pub const fn new(first: BotName, second: BotName) -> Self {
        Self {
            first,
            second,
            games: 100,
            max_turns: 512,
            seed: 1,
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
pub struct EloConfig {
    pub games_per_pair: usize,
    pub max_turns: usize,
    pub seed: u64,
    pub k_factor: f64,
    pub initial_rating: f64,
}

impl EloConfig {
    #[must_use]
    pub const fn new() -> Self {
        Self {
            games_per_pair: 100,
            max_turns: 512,
            seed: 1,
            k_factor: 32.0,
            initial_rating: 1500.0,
        }
    }
}

impl Default for EloConfig {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
pub struct CompareConfig {
    pub candidate: BotName,
    pub baseline: BotName,
    pub max_games: usize,
    pub batch_size: usize,
    pub min_games: usize,
    pub max_turns: usize,
    pub seed: u64,
    pub confidence_z: f64,
}

impl CompareConfig {
    #[must_use]
    pub const fn new(candidate: BotName, baseline: BotName) -> Self {
        Self {
            candidate,
            baseline,
            max_games: 1000,
            batch_size: 100,
            min_games: 200,
            max_turns: 512,
            seed: 1,
            confidence_z: 1.96,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Serialize)]
pub struct SeatRecord {
    pub games: usize,
    pub wins: usize,
    pub losses: usize,
    pub unfinished: usize,
}

#[derive(Clone, Copy, Debug, Serialize)]
pub struct BotRecord {
    pub bot: BotName,
    pub wins: usize,
    pub losses: usize,
    pub unfinished: usize,
    pub as_player_one: SeatRecord,
    pub as_player_two: SeatRecord,
}

impl BotRecord {
    fn new(bot: BotName) -> Self {
        Self {
            bot,
            wins: 0,
            losses: 0,
            unfinished: 0,
            as_player_one: SeatRecord::default(),
            as_player_two: SeatRecord::default(),
        }
    }

    fn seat_mut(&mut self, player: Player) -> &mut SeatRecord {
        match player {
            Player::One => &mut self.as_player_one,
            Player::Two => &mut self.as_player_two,
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
pub struct MatchSummary {
    pub config: MatchConfig,
    pub first: BotRecord,
    pub second: BotRecord,
    pub total_games: usize,
    pub finished_games: usize,
    pub unfinished_games: usize,
    pub average_turns: f64,
    pub elapsed_ms: u128,
    pub games_per_second: f64,
}

#[derive(Clone, Copy, Debug, Serialize)]
pub struct EloStanding {
    pub bot: BotName,
    pub rating: f64,
    pub wins: usize,
    pub losses: usize,
    pub unfinished: usize,
    pub as_player_one: SeatRecord,
    pub as_player_two: SeatRecord,
}

impl EloStanding {
    fn new(bot: BotName, initial_rating: f64) -> Self {
        Self {
            bot,
            rating: initial_rating,
            wins: 0,
            losses: 0,
            unfinished: 0,
            as_player_one: SeatRecord::default(),
            as_player_two: SeatRecord::default(),
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
pub struct EloMatchupSummary {
    pub first: BotName,
    pub second: BotName,
    pub wins_first: usize,
    pub wins_second: usize,
    pub unfinished: usize,
    pub average_turns: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct EloSummary {
    pub config: EloConfig,
    pub standings: Vec<EloStanding>,
    pub matchups: Vec<EloMatchupSummary>,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CompareVerdict {
    LikelyBetter,
    Inconclusive,
    LikelyWorse,
}

#[derive(Clone, Copy, Debug, Serialize)]
pub struct CompareSummary {
    pub config: CompareConfig,
    pub candidate: BotRecord,
    pub baseline: BotRecord,
    pub total_games: usize,
    pub finished_games: usize,
    pub unfinished_games: usize,
    pub average_turns: f64,
    pub elapsed_ms: u128,
    pub games_per_second: f64,
    pub batches_run: usize,
    pub stopped_early: bool,
    pub candidate_score: f64,
    pub score_ci_low: f64,
    pub score_ci_high: f64,
    pub estimated_elo_diff: f64,
    pub elo_ci_low: f64,
    pub elo_ci_high: f64,
    pub verdict: CompareVerdict,
}

#[derive(Clone, Copy, Debug, Serialize)]
pub struct MatchProgress {
    pub completed_games: usize,
    pub total_games: usize,
    pub first_wins: usize,
    pub second_wins: usize,
    pub unfinished_games: usize,
    pub elapsed_ms: u128,
}

#[derive(Clone, Copy, Debug, Serialize)]
pub struct EloProgress {
    pub completed_pairs: usize,
    pub total_pairs: usize,
    pub first: BotName,
    pub second: BotName,
    pub elapsed_ms: u128,
}

#[derive(Clone, Copy, Debug, Serialize)]
pub struct CompareProgress {
    pub completed_games: usize,
    pub max_games: usize,
    pub batches_run: usize,
    pub candidate_wins: usize,
    pub baseline_wins: usize,
    pub unfinished_games: usize,
    pub candidate_score: f64,
    pub score_ci_low: f64,
    pub score_ci_high: f64,
    pub elapsed_ms: u128,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendGameFile {
    pub format: &'static str,
    pub game_json: String,
    pub title: String,
    pub source: FrontendGameSource,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendGameSource {
    pub kind: &'static str,
    pub matchup: String,
    pub game_number: usize,
    pub first_bot: BotName,
    pub second_bot: BotName,
    pub player_one_bot: BotName,
    pub player_two_bot: BotName,
    pub winner_bot: Option<BotName>,
    pub winner_player: Option<Player>,
    pub finished: bool,
    pub max_turns: usize,
    pub seed: u64,
    pub turns: usize,
}

#[derive(Clone, Copy, Debug)]
enum GameOutcome {
    Win { winner: BotName },
    TurnLimit,
}

#[derive(Clone, Copy, Debug)]
enum SeatOutcome {
    Win,
    Loss,
    Unfinished,
}

#[derive(Clone, Debug)]
struct GameStats {
    turns: usize,
    outcome: GameOutcome,
    game_json: Option<String>,
}

#[derive(Clone, Debug)]
struct GameRun {
    game_index: usize,
    first_seat: Player,
    stats: GameStats,
}

#[derive(Clone, Copy, Debug)]
struct ScoreStats {
    mean: f64,
    low: f64,
    high: f64,
}

#[derive(Clone, Copy, Debug)]
struct AggregateMatch {
    candidate: BotRecord,
    baseline: BotRecord,
    total_games: usize,
    finished_games: usize,
    unfinished_games: usize,
    total_turns: usize,
}

const MATCH_PROGRESS_BATCH_GAMES: usize = 128;

fn progress_batch_games(total_games: usize) -> usize {
    if total_games <= 8 {
        2
    } else if total_games <= 32 {
        4
    } else if total_games <= 128 {
        8
    } else {
        MATCH_PROGRESS_BATCH_GAMES
    }
}

impl AggregateMatch {
    fn new(candidate: BotName, baseline: BotName) -> Self {
        Self {
            candidate: BotRecord::new(candidate),
            baseline: BotRecord::new(baseline),
            total_games: 0,
            finished_games: 0,
            unfinished_games: 0,
            total_turns: 0,
        }
    }
}

pub fn run_match(config: MatchConfig) -> Result<MatchSummary, String> {
    Ok(run_match_internal(config, false, |_| {})?.0)
}

pub fn run_match_with_progress<F>(
    config: MatchConfig,
    on_progress: F,
) -> Result<MatchSummary, String>
where
    F: FnMut(MatchProgress),
{
    Ok(run_match_internal(config, false, on_progress)?.0)
}

pub fn run_match_with_frontend_games(
    config: MatchConfig,
) -> Result<(MatchSummary, Vec<FrontendGameFile>), String> {
    run_match_with_frontend_games_and_progress(config, |_| {})
}

pub fn run_match_with_frontend_games_and_progress<F>(
    config: MatchConfig,
    on_progress: F,
) -> Result<(MatchSummary, Vec<FrontendGameFile>), String>
where
    F: FnMut(MatchProgress),
{
    let (summary, runs) = run_match_internal(config, true, on_progress)?;
    Ok((summary, export_frontend_games(runs, config, "harness_match", 0)))
}

pub fn run_elo(bots: &[BotName], config: EloConfig) -> Result<EloSummary, String> {
    Ok(run_elo_internal(bots, config, false, |_| {})?.0)
}

pub fn run_elo_with_progress<F>(
    bots: &[BotName],
    config: EloConfig,
    on_progress: F,
) -> Result<EloSummary, String>
where
    F: FnMut(EloProgress),
{
    Ok(run_elo_internal(bots, config, false, on_progress)?.0)
}

pub fn run_elo_with_frontend_games(
    bots: &[BotName],
    config: EloConfig,
) -> Result<(EloSummary, Vec<FrontendGameFile>), String> {
    run_elo_with_frontend_games_and_progress(bots, config, |_| {})
}

pub fn run_elo_with_frontend_games_and_progress<F>(
    bots: &[BotName],
    config: EloConfig,
    on_progress: F,
) -> Result<(EloSummary, Vec<FrontendGameFile>), String>
where
    F: FnMut(EloProgress),
{
    run_elo_internal(bots, config, true, on_progress)
}

pub fn run_compare(config: CompareConfig) -> Result<CompareSummary, String> {
    Ok(run_compare_internal(config, false, |_| {})?.0)
}

pub fn run_compare_with_progress<F>(
    config: CompareConfig,
    on_progress: F,
) -> Result<CompareSummary, String>
where
    F: FnMut(CompareProgress),
{
    Ok(run_compare_internal(config, false, on_progress)?.0)
}

pub fn run_compare_with_frontend_games(
    config: CompareConfig,
) -> Result<(CompareSummary, Vec<FrontendGameFile>), String> {
    run_compare_with_frontend_games_and_progress(config, |_| {})
}

pub fn run_compare_with_frontend_games_and_progress<F>(
    config: CompareConfig,
    on_progress: F,
) -> Result<(CompareSummary, Vec<FrontendGameFile>), String>
where
    F: FnMut(CompareProgress),
{
    run_compare_internal(config, true, on_progress)
}

fn run_match_internal<F>(
    config: MatchConfig,
    capture_games: bool,
    mut on_progress: F,
) -> Result<(MatchSummary, Vec<GameRun>), String>
where
    F: FnMut(MatchProgress),
{
    validate_match_config(config)?;

    let started = Instant::now();
    let mut aggregate = AggregateMatch::new(config.first, config.second);
    let mut completed_games = 0usize;
    let mut runs = Vec::new();

    let progress_batch_games = progress_batch_games(config.games);
    while completed_games < config.games {
        let batch_games = progress_batch_games.min(config.games - completed_games);
        let batch = run_match_batch(config, completed_games, batch_games, capture_games)?;
        merge_match_summary(&mut aggregate, &batch.summary);
        completed_games += batch_games;
        if capture_games {
            runs.extend(batch.runs);
        }

        on_progress(MatchProgress {
            completed_games,
            total_games: config.games,
            first_wins: aggregate.candidate.wins,
            second_wins: aggregate.baseline.wins,
            unfinished_games: aggregate.unfinished_games,
            elapsed_ms: started.elapsed().as_millis(),
        });
    }

    Ok((
        finalize_match_summary(config, aggregate, started.elapsed().as_millis()),
        runs,
    ))
}

fn run_elo_internal<F>(
    bots: &[BotName],
    config: EloConfig,
    capture_games: bool,
    mut on_progress: F,
) -> Result<(EloSummary, Vec<FrontendGameFile>), String>
where
    F: FnMut(EloProgress),
{
    validate_elo_config(bots, config)?;

    let started = Instant::now();
    let total_pairs = bots.len() * (bots.len() - 1) / 2;
    let mut completed_pairs = 0usize;
    let mut standings = bots
        .iter()
        .copied()
        .map(|bot| EloStanding::new(bot, config.initial_rating))
        .collect::<Vec<_>>();
    let mut matchups = Vec::new();
    let mut exported_games = Vec::new();

    for first_index in 0..bots.len() {
        for second_index in (first_index + 1)..bots.len() {
            let first = bots[first_index];
            let second = bots[second_index];
            let match_config = MatchConfig {
                first,
                second,
                games: config.games_per_pair,
                max_turns: config.max_turns,
                seed: mix_seed(
                    config.seed,
                    ((first_index as u64) << 32) | second_index as u64,
                ),
            };
            let (summary, runs) = run_match_internal(match_config, capture_games, |_| {})?;

            let (left, right) = standings.split_at_mut(second_index);
            let first_standing = &mut left[first_index];
            let second_standing = &mut right[0];

            accumulate_standing(first_standing, &summary.first);
            accumulate_standing(second_standing, &summary.second);
            apply_elo_series(
                &mut first_standing.rating,
                &mut second_standing.rating,
                summary.first.wins,
                summary.second.wins,
                summary.unfinished_games,
                config.k_factor,
            );

            matchups.push(EloMatchupSummary {
                first: summary.first.bot,
                second: summary.second.bot,
                wins_first: summary.first.wins,
                wins_second: summary.second.wins,
                unfinished: summary.unfinished_games,
                average_turns: summary.average_turns,
            });

            if capture_games {
                exported_games.extend(export_frontend_games(
                    runs,
                    match_config,
                    "harness_elo",
                    0,
                ));
            }

            completed_pairs += 1;
            on_progress(EloProgress {
                completed_pairs,
                total_pairs,
                first,
                second,
                elapsed_ms: started.elapsed().as_millis(),
            });
        }
    }

    standings.sort_by(|a, b| {
        b.rating
            .total_cmp(&a.rating)
            .then_with(|| a.bot.as_str().cmp(b.bot.as_str()))
    });

    Ok((
        EloSummary {
            config,
            standings,
            matchups,
        },
        exported_games,
    ))
}

fn run_compare_internal<F>(
    config: CompareConfig,
    capture_games: bool,
    mut on_progress: F,
) -> Result<(CompareSummary, Vec<FrontendGameFile>), String>
where
    F: FnMut(CompareProgress),
{
    validate_compare_config(config)?;

    let started = Instant::now();
    let mut aggregate = AggregateMatch::new(config.candidate, config.baseline);
    let mut batches_run = 0usize;
    let mut stopped_early = false;
    let mut exported_games = Vec::new();

    while aggregate.total_games < config.max_games {
        let games = config
            .batch_size
            .min(config.max_games.saturating_sub(aggregate.total_games));
        let match_config = MatchConfig {
            first: config.candidate,
            second: config.baseline,
            games,
            max_turns: config.max_turns,
            seed: mix_seed(config.seed, batches_run as u64),
        };
        let game_offset = aggregate.total_games;
        let (summary, runs) = run_match_internal(match_config, capture_games, |_| {})?;
        merge_match_summary(&mut aggregate, &summary);
        batches_run += 1;

        if capture_games {
            exported_games.extend(export_frontend_games(
                runs,
                match_config,
                "harness_compare",
                game_offset,
            ));
        }

        let stats = score_stats(
            aggregate.candidate.wins,
            aggregate.baseline.wins,
            aggregate.unfinished_games,
            aggregate.total_games,
            config.confidence_z,
        );
        on_progress(CompareProgress {
            completed_games: aggregate.total_games,
            max_games: config.max_games,
            batches_run,
            candidate_wins: aggregate.candidate.wins,
            baseline_wins: aggregate.baseline.wins,
            unfinished_games: aggregate.unfinished_games,
            candidate_score: stats.mean,
            score_ci_low: stats.low,
            score_ci_high: stats.high,
            elapsed_ms: started.elapsed().as_millis(),
        });

        if aggregate.total_games >= config.min_games && (stats.low > 0.5 || stats.high < 0.5) {
            stopped_early = true;
            break;
        }
    }

    Ok((
        finalize_compare_summary(
            config,
            aggregate,
            batches_run,
            stopped_early,
            started.elapsed().as_millis(),
        ),
        exported_games,
    ))
}

struct MatchBatch {
    summary: MatchSummary,
    runs: Vec<GameRun>,
}

fn run_match_batch(
    config: MatchConfig,
    start_game_index: usize,
    games: usize,
    capture_game_json: bool,
) -> Result<MatchBatch, String> {
    let runs = (0..games)
        .into_par_iter()
        .with_min_len(16)
        .map(|index| run_single_game(config, start_game_index + index, capture_game_json))
        .collect::<Result<Vec<_>, _>>()?;

    let mut aggregate = AggregateMatch::new(config.first, config.second);
    for run in &runs {
        aggregate.total_games += 1;
        aggregate.total_turns += run.stats.turns;
        apply_result_to_aggregate(&mut aggregate, run);
    }

    Ok(MatchBatch {
        summary: MatchSummary {
            config,
            first: aggregate.candidate,
            second: aggregate.baseline,
            total_games: aggregate.total_games,
            finished_games: aggregate.finished_games,
            unfinished_games: aggregate.unfinished_games,
            average_turns: aggregate.total_turns as f64 / aggregate.total_games as f64,
            elapsed_ms: 0,
            games_per_second: 0.0,
        },
        runs,
    })
}

fn finalize_match_summary(
    config: MatchConfig,
    aggregate: AggregateMatch,
    elapsed_ms: u128,
) -> MatchSummary {
    MatchSummary {
        config,
        first: aggregate.candidate,
        second: aggregate.baseline,
        total_games: aggregate.total_games,
        finished_games: aggregate.finished_games,
        unfinished_games: aggregate.unfinished_games,
        average_turns: aggregate.total_turns as f64 / aggregate.total_games as f64,
        elapsed_ms,
        games_per_second: if elapsed_ms == 0 {
            aggregate.total_games as f64
        } else {
            aggregate.total_games as f64 / (elapsed_ms as f64 / 1_000.0)
        },
    }
}

fn finalize_compare_summary(
    config: CompareConfig,
    aggregate: AggregateMatch,
    batches_run: usize,
    stopped_early: bool,
    elapsed_ms: u128,
) -> CompareSummary {
    let score = score_stats(
        aggregate.candidate.wins,
        aggregate.baseline.wins,
        aggregate.unfinished_games,
        aggregate.total_games,
        config.confidence_z,
    );
    let verdict = if score.low > 0.5 {
        CompareVerdict::LikelyBetter
    } else if score.high < 0.5 {
        CompareVerdict::LikelyWorse
    } else {
        CompareVerdict::Inconclusive
    };

    CompareSummary {
        config,
        candidate: aggregate.candidate,
        baseline: aggregate.baseline,
        total_games: aggregate.total_games,
        finished_games: aggregate.finished_games,
        unfinished_games: aggregate.unfinished_games,
        average_turns: aggregate.total_turns as f64 / aggregate.total_games as f64,
        elapsed_ms,
        games_per_second: if elapsed_ms == 0 {
            aggregate.total_games as f64
        } else {
            aggregate.total_games as f64 / (elapsed_ms as f64 / 1_000.0)
        },
        batches_run,
        stopped_early,
        candidate_score: score.mean,
        score_ci_low: score.low,
        score_ci_high: score.high,
        estimated_elo_diff: elo_from_score(score.mean),
        elo_ci_low: elo_from_score(score.low),
        elo_ci_high: elo_from_score(score.high),
        verdict,
    }
}

fn export_frontend_games(
    runs: Vec<GameRun>,
    config: MatchConfig,
    kind: &'static str,
    game_index_offset: usize,
) -> Vec<FrontendGameFile> {
    runs.into_iter()
        .map(|mut run| {
            run.game_index += game_index_offset;
            frontend_game_from_run(run, config, kind)
        })
        .collect()
}

fn frontend_game_from_run(
    run: GameRun,
    config: MatchConfig,
    kind: &'static str,
) -> FrontendGameFile {
    let matchup = format!("{} vs {}", config.first, config.second);
    let player_one_bot = if run.first_seat == Player::One {
        config.first
    } else {
        config.second
    };
    let player_two_bot = if run.first_seat == Player::Two {
        config.first
    } else {
        config.second
    };
    let winner_bot = match run.stats.outcome {
        GameOutcome::Win { winner } => Some(winner),
        GameOutcome::TurnLimit => None,
    };
    let winner_player = winner_bot.map(|winner| {
        if winner == config.first {
            run.first_seat
        } else {
            run.first_seat.other()
        }
    });

    FrontendGameFile {
        format: "six-tac-game/v1",
        game_json: run
            .stats
            .game_json
            .expect("frontend game export requires captured game json"),
        title: format!("{matchup} • game {}", run.game_index + 1),
        source: FrontendGameSource {
            kind,
            matchup,
            game_number: run.game_index + 1,
            first_bot: config.first,
            second_bot: config.second,
            player_one_bot,
            player_two_bot,
            winner_bot,
            winner_player,
            finished: winner_bot.is_some(),
            max_turns: config.max_turns,
            seed: config.seed,
            turns: run.stats.turns,
        },
    }
}

fn validate_match_config(config: MatchConfig) -> Result<(), String> {
    if config.games == 0 {
        return Err("games must be at least 1".to_string());
    }
    if config.max_turns == 0 {
        return Err("max_turns must be at least 1".to_string());
    }
    Ok(())
}

fn validate_elo_config(bots: &[BotName], config: EloConfig) -> Result<(), String> {
    if bots.len() < 2 {
        return Err("elo mode needs at least two bots".to_string());
    }
    if config.games_per_pair == 0 {
        return Err("games_per_pair must be at least 1".to_string());
    }
    if config.max_turns == 0 {
        return Err("max_turns must be at least 1".to_string());
    }
    for (index, bot) in bots.iter().enumerate() {
        if bots[..index].contains(bot) {
            return Err(format!("duplicate bot in elo pool: {bot}"));
        }
    }
    Ok(())
}

fn validate_compare_config(config: CompareConfig) -> Result<(), String> {
    if config.candidate == config.baseline {
        return Err("candidate and baseline must be different".to_string());
    }
    if config.max_games == 0 {
        return Err("max_games must be at least 1".to_string());
    }
    if config.batch_size == 0 {
        return Err("batch_size must be at least 1".to_string());
    }
    if config.min_games == 0 {
        return Err("min_games must be at least 1".to_string());
    }
    if config.min_games > config.max_games {
        return Err("min_games cannot exceed max_games".to_string());
    }
    if config.max_turns == 0 {
        return Err("max_turns must be at least 1".to_string());
    }
    if !config.confidence_z.is_finite() || config.confidence_z <= 0.0 {
        return Err("confidence_z must be a positive finite number".to_string());
    }
    Ok(())
}

fn run_single_game(
    config: MatchConfig,
    game_index: usize,
    capture_game_json: bool,
) -> Result<GameRun, String> {
    let mut seat_rng = MatchRng::new(mix_seed(config.seed, game_index as u64));
    let first_gets_first_move = seat_rng.next_u64() & 1 == 0;
    let first_seat = if first_gets_first_move {
        Player::Two
    } else {
        Player::One
    };
    let second_seat = first_seat.other();

    let stats = play_game(
        Game::new(),
        config.first,
        first_seat,
        config.second,
        second_seat,
        config.max_turns,
        seat_rng.next_u64(),
        capture_game_json,
    )?;

    Ok(GameRun {
        game_index,
        first_seat,
        stats,
    })
}

fn apply_result_to_aggregate(aggregate: &mut AggregateMatch, run: &GameRun) {
    let second_seat = run.first_seat.other();
    let first_bot = aggregate.candidate.bot;
    let second_bot = aggregate.baseline.bot;

    match run.stats.outcome {
        GameOutcome::Win { winner } => {
            aggregate.finished_games += 1;
            record_seat_game(
                &mut aggregate.candidate,
                run.first_seat,
                if winner == first_bot {
                    SeatOutcome::Win
                } else {
                    SeatOutcome::Loss
                },
            );
            record_seat_game(
                &mut aggregate.baseline,
                second_seat,
                if winner == second_bot {
                    SeatOutcome::Win
                } else {
                    SeatOutcome::Loss
                },
            );
        }
        GameOutcome::TurnLimit => {
            aggregate.unfinished_games += 1;
            record_seat_game(
                &mut aggregate.candidate,
                run.first_seat,
                SeatOutcome::Unfinished,
            );
            record_seat_game(
                &mut aggregate.baseline,
                second_seat,
                SeatOutcome::Unfinished,
            );
        }
    }
}

fn record_seat_game(record: &mut BotRecord, seat: Player, outcome: SeatOutcome) {
    record.seat_mut(seat).games += 1;

    match outcome {
        SeatOutcome::Win => {
            record.wins += 1;
            record.seat_mut(seat).wins += 1;
        }
        SeatOutcome::Loss => {
            record.losses += 1;
            record.seat_mut(seat).losses += 1;
        }
        SeatOutcome::Unfinished => {
            record.unfinished += 1;
            record.seat_mut(seat).unfinished += 1;
        }
    }
}

fn accumulate_standing(standing: &mut EloStanding, record: &BotRecord) {
    standing.wins += record.wins;
    standing.losses += record.losses;
    standing.unfinished += record.unfinished;
    add_seat_record(&mut standing.as_player_one, record.as_player_one);
    add_seat_record(&mut standing.as_player_two, record.as_player_two);
}

fn merge_match_summary(aggregate: &mut AggregateMatch, summary: &MatchSummary) {
    aggregate.total_games += summary.total_games;
    aggregate.finished_games += summary.finished_games;
    aggregate.unfinished_games += summary.unfinished_games;
    aggregate.total_turns += (summary.average_turns * summary.total_games as f64).round() as usize;
    merge_bot_record(&mut aggregate.candidate, summary.first);
    merge_bot_record(&mut aggregate.baseline, summary.second);
}

fn merge_bot_record(target: &mut BotRecord, source: BotRecord) {
    target.wins += source.wins;
    target.losses += source.losses;
    target.unfinished += source.unfinished;
    add_seat_record(&mut target.as_player_one, source.as_player_one);
    add_seat_record(&mut target.as_player_two, source.as_player_two);
}

fn add_seat_record(target: &mut SeatRecord, source: SeatRecord) {
    target.games += source.games;
    target.wins += source.wins;
    target.losses += source.losses;
    target.unfinished += source.unfinished;
}

fn apply_elo_series(
    first_rating: &mut f64,
    second_rating: &mut f64,
    first_wins: usize,
    second_wins: usize,
    unfinished: usize,
    k_factor: f64,
) {
    for _ in 0..first_wins {
        apply_elo_result(first_rating, second_rating, 1.0, k_factor);
    }
    for _ in 0..second_wins {
        apply_elo_result(first_rating, second_rating, 0.0, k_factor);
    }
    for _ in 0..unfinished {
        apply_elo_result(first_rating, second_rating, 0.5, k_factor);
    }
}

fn apply_elo_result(first_rating: &mut f64, second_rating: &mut f64, first_score: f64, k: f64) {
    let first_expected = 1.0 / (1.0 + 10.0f64.powf((*second_rating - *first_rating) / 400.0));
    let second_expected = 1.0 - first_expected;
    let second_score = 1.0 - first_score;

    *first_rating += k * (first_score - first_expected);
    *second_rating += k * (second_score - second_expected);
}

fn score_stats(wins: usize, losses: usize, unfinished: usize, games: usize, z: f64) -> ScoreStats {
    debug_assert_eq!(wins + losses + unfinished, games);

    let n = games as f64;
    let mean = (wins as f64 + 0.5 * unfinished as f64) / n;
    if games <= 1 {
        return ScoreStats {
            mean,
            low: mean,
            high: mean,
        };
    }

    let z2 = z * z;
    let denom = 1.0 + z2 / n;
    let center = (mean + z2 / (2.0 * n)) / denom;
    let margin = (z / denom) * ((mean * (1.0 - mean) / n) + (z2 / (4.0 * n * n))).sqrt();

    ScoreStats {
        mean,
        low: (center - margin).clamp(0.0, 1.0),
        high: (center + margin).clamp(0.0, 1.0),
    }
}

fn elo_from_score(score: f64) -> f64 {
    let score = score.clamp(1e-9, 1.0 - 1e-9);
    400.0 * (score / (1.0 - score)).log10()
}

fn play_game(
    mut game: Game,
    first_bot: BotName,
    first_seat: Player,
    second_bot: BotName,
    second_seat: Player,
    max_turns: usize,
    seed: u64,
    capture_game_json: bool,
) -> Result<GameStats, String> {
    let mut rng = MatchRng::new(seed);

    while !game.is_over() && game.turn_count() < max_turns as u32 {
        let active_bot = if game.current_player() == first_seat {
            first_bot
        } else if game.current_player() == second_seat {
            second_bot
        } else {
            return Err("invalid seat assignment".to_string());
        };

        let stones = choose_move_with_rng(active_bot, &game, &mut rng)?;
        if !game.is_legal(stones) {
            return Err(format!(
                "{active_bot} produced an illegal move {:?} at turn {}",
                stones,
                game.turn_count()
            ));
        }
        game.play(stones)
            .map_err(|error| format!("{active_bot} move failed to apply: {error}"))?;
    }

    let outcome = match game.winner() {
        Some(player) if player == first_seat => GameOutcome::Win { winner: first_bot },
        Some(player) if player == second_seat => GameOutcome::Win { winner: second_bot },
        Some(_) => return Err("winner seat mismatch".to_string()),
        None => GameOutcome::TurnLimit,
    };

    Ok(GameStats {
        turns: game.turn_count() as usize,
        outcome,
        game_json: if capture_game_json {
            Some(game.to_json().map_err(|error| error.to_string())?)
        } else {
            None
        },
    })
}

fn mix_seed(seed: u64, value: u64) -> u64 {
    seed ^ value
        .wrapping_add(0x9E37_79B9_7F4A_7C15)
        .rotate_left(17)
        .wrapping_mul(0xBF58_476D_1CE4_E5B9)
}

#[derive(Clone, Copy, Debug)]
struct MatchRng {
    state: u64,
}

impl MatchRng {
    fn new(seed: u64) -> Self {
        let state = if seed == 0 {
            0xA076_1D64_78BD_642F
        } else {
            seed
        };
        Self { state }
    }

    fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
}

impl shared::IndexRng for MatchRng {
    fn index(&mut self, length: usize) -> usize {
        (self.next_u64() % length as u64) as usize
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_match_counts_all_games() {
        let summary = run_match(MatchConfig {
            games: 2,
            max_turns: 32,
            ..MatchConfig::new(BotName::Seal, BotName::Ambrosia)
        })
        .unwrap();

        assert_eq!(summary.total_games, 2);
        assert_eq!(
            summary.first.wins + summary.second.wins + summary.unfinished_games,
            2
        );
    }

    #[test]
    fn elo_runs_for_all_bots() {
        let summary = run_elo(
            &BotName::ALL,
            EloConfig {
                games_per_pair: 2,
                max_turns: 32,
                ..EloConfig::new()
            },
        )
        .unwrap();

        assert_eq!(summary.standings.len(), BotName::ALL.len());
        assert_eq!(
            summary.matchups.len(),
            BotName::ALL.len() * (BotName::ALL.len() - 1) / 2
        );
    }

    #[test]
    fn compare_produces_a_verdict() {
        let summary = run_compare(CompareConfig {
            candidate: BotName::Seal,
            baseline: BotName::Sprout,
            max_games: 20,
            batch_size: 5,
            min_games: 10,
            max_turns: 32,
            seed: 7,
            confidence_z: 1.96,
        })
        .unwrap();

        assert!(summary.total_games >= 10);
        assert_ne!(summary.verdict, CompareVerdict::Inconclusive);
    }
}
