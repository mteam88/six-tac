use six_tac_bots::{
    run_compare, run_compare_with_progress, run_elo, run_elo_with_progress, run_match,
    run_match_with_progress, BotName, CompareConfig, CompareProgress, CompareSummary, EloConfig,
    EloProgress, EloSummary, MatchConfig, MatchProgress, MatchSummary,
};
use std::env;
use std::str::FromStr;

fn main() {
    if let Err(error) = run() {
        eprintln!("error: {error}");
        eprintln!();
        eprintln!("{}", usage());
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let args = env::args().skip(1).collect::<Vec<_>>();
    if args.is_empty() || args.iter().any(|arg| arg == "--help" || arg == "-h") {
        println!("{}", usage());
        return Ok(());
    }

    match args[0].as_str() {
        "list" => {
            for bot in BotName::ALL {
                println!("{bot}");
            }
            Ok(())
        }
        "match" => run_match_command(&args[1..]),
        "elo" => run_elo_command(&args[1..]),
        "compare" => run_compare_command(&args[1..]),
        _ => run_match_command(&args),
    }
}

fn run_match_command(args: &[String]) -> Result<(), String> {
    if args.len() < 2 {
        return Err("expected two bot names".to_string());
    }

    let mut config = MatchConfig::new(BotName::from_str(&args[0])?, BotName::from_str(&args[1])?);
    let mut json = false;
    let mut index = 2;
    while index < args.len() {
        match args[index].as_str() {
            "--games" | "-n" => {
                config.games = parse_usize_flag(args, &mut index, "--games")?;
            }
            "--max-turns" => {
                config.max_turns = parse_usize_flag(args, &mut index, "--max-turns")?;
            }
            "--seed" => {
                config.seed = parse_u64_flag(args, &mut index, "--seed")?;
            }
            "--json" => {
                json = true;
                index += 1;
            }
            other => return Err(format!("unrecognized flag: {other}")),
        }
    }

    let summary = if json {
        run_match(config)?
    } else {
        run_match_with_progress(config, print_match_progress)?
    };
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&summary).map_err(|error| error.to_string())?
        );
    } else {
        print_summary(&summary);
    }
    Ok(())
}

fn run_elo_command(args: &[String]) -> Result<(), String> {
    if args.is_empty() {
        return Err("expected at least two bot names, or 'all'".to_string());
    }

    let mut bots = Vec::new();
    let mut index = 0;
    if args[0] == "all" {
        bots.extend(BotName::ALL);
        index = 1;
    } else {
        while index < args.len() && !args[index].starts_with('-') {
            bots.push(BotName::from_str(&args[index])?);
            index += 1;
        }
    }

    let mut config = EloConfig::new();
    let mut json = false;
    while index < args.len() {
        match args[index].as_str() {
            "--games" | "-n" | "--games-per-pair" => {
                config.games_per_pair = parse_usize_flag(args, &mut index, "--games")?;
            }
            "--max-turns" => {
                config.max_turns = parse_usize_flag(args, &mut index, "--max-turns")?;
            }
            "--seed" => {
                config.seed = parse_u64_flag(args, &mut index, "--seed")?;
            }
            "--k-factor" => {
                config.k_factor = parse_f64_flag(args, &mut index, "--k-factor")?;
            }
            "--json" => {
                json = true;
                index += 1;
            }
            other => return Err(format!("unrecognized flag: {other}")),
        }
    }

    let summary = if json {
        run_elo(&bots, config)?
    } else {
        run_elo_with_progress(&bots, config, print_elo_progress)?
    };
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&summary).map_err(|error| error.to_string())?
        );
    } else {
        print_elo_summary(&summary);
    }
    Ok(())
}

fn run_compare_command(args: &[String]) -> Result<(), String> {
    if args.len() < 2 {
        return Err("expected candidate and baseline bot names".to_string());
    }

    let mut config = CompareConfig::new(BotName::from_str(&args[0])?, BotName::from_str(&args[1])?);
    let mut json = false;
    let mut index = 2;
    while index < args.len() {
        match args[index].as_str() {
            "--games" | "-n" | "--max-games" => {
                config.max_games = parse_usize_flag(args, &mut index, "--games")?;
            }
            "--batch-size" => {
                config.batch_size = parse_usize_flag(args, &mut index, "--batch-size")?;
            }
            "--min-games" => {
                config.min_games = parse_usize_flag(args, &mut index, "--min-games")?;
            }
            "--max-turns" => {
                config.max_turns = parse_usize_flag(args, &mut index, "--max-turns")?;
            }
            "--seed" => {
                config.seed = parse_u64_flag(args, &mut index, "--seed")?;
            }
            "--confidence-z" | "--z" => {
                config.confidence_z = parse_f64_flag(args, &mut index, "--confidence-z")?;
            }
            "--json" => {
                json = true;
                index += 1;
            }
            other => return Err(format!("unrecognized flag: {other}")),
        }
    }

    let summary = if json {
        run_compare(config)?
    } else {
        run_compare_with_progress(config, print_compare_progress)?
    };
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&summary).map_err(|error| error.to_string())?
        );
    } else {
        print_compare_summary(&summary);
    }
    Ok(())
}

fn parse_usize_flag(args: &[String], index: &mut usize, name: &str) -> Result<usize, String> {
    *index += 1;
    let value = args
        .get(*index)
        .ok_or_else(|| format!("missing value for {name}"))?
        .parse::<usize>()
        .map_err(|error| format!("invalid value for {name}: {error}"))?;
    *index += 1;
    Ok(value)
}

fn parse_u64_flag(args: &[String], index: &mut usize, name: &str) -> Result<u64, String> {
    *index += 1;
    let value = args
        .get(*index)
        .ok_or_else(|| format!("missing value for {name}"))?
        .parse::<u64>()
        .map_err(|error| format!("invalid value for {name}: {error}"))?;
    *index += 1;
    Ok(value)
}

fn parse_f64_flag(args: &[String], index: &mut usize, name: &str) -> Result<f64, String> {
    *index += 1;
    let value = args
        .get(*index)
        .ok_or_else(|| format!("missing value for {name}"))?
        .parse::<f64>()
        .map_err(|error| format!("invalid value for {name}: {error}"))?;
    *index += 1;
    Ok(value)
}

fn print_match_progress(progress: MatchProgress) {
    eprintln!(
        "progress: {}/{} games | {}-{} | unfinished {} | {:.1}s",
        progress.completed_games,
        progress.total_games,
        progress.first_wins,
        progress.second_wins,
        progress.unfinished_games,
        progress.elapsed_ms as f64 / 1_000.0
    );
}

fn print_elo_progress(progress: EloProgress) {
    eprintln!(
        "progress: pair {}/{} complete ({} vs {}) | {:.1}s",
        progress.completed_pairs,
        progress.total_pairs,
        progress.first,
        progress.second,
        progress.elapsed_ms as f64 / 1_000.0
    );
}

fn print_compare_progress(progress: CompareProgress) {
    eprintln!(
        "progress: {}/{} games | {}-{} | unfinished {} | score {:.3} [{:.3}, {:.3}] | {:.1}s",
        progress.completed_games,
        progress.max_games,
        progress.candidate_wins,
        progress.baseline_wins,
        progress.unfinished_games,
        progress.candidate_score,
        progress.score_ci_low,
        progress.score_ci_high,
        progress.elapsed_ms as f64 / 1_000.0
    );
}

fn print_summary(summary: &MatchSummary) {
    println!("match: {} vs {}", summary.first.bot, summary.second.bot);
    println!(
        "games: {} | seed {}",
        summary.total_games, summary.config.seed
    );
    println!("max turns: {}", summary.config.max_turns);
    println!(
        "elapsed: {:.3}s | throughput: {:.1} games/s | avg turns: {:.2}",
        summary.elapsed_ms as f64 / 1_000.0,
        summary.games_per_second,
        summary.average_turns
    );
    println!();
    println!("wins:");
    println!("  {:<10} {}", summary.first.bot, summary.first.wins);
    println!("  {:<10} {}", summary.second.bot, summary.second.wins);
    println!("  {:<10} {}", "unfinished", summary.unfinished_games);
    println!();
    println!("seat split:");
    print_seat_line(summary.first.bot, "player one", summary.first.as_player_one);
    print_seat_line(summary.first.bot, "player two", summary.first.as_player_two);
    print_seat_line(
        summary.second.bot,
        "player one",
        summary.second.as_player_one,
    );
    print_seat_line(
        summary.second.bot,
        "player two",
        summary.second.as_player_two,
    );
}

fn print_elo_summary(summary: &EloSummary) {
    println!(
        "elo: {} bots | {} games/pair | max turns {} | seed {} | k {:.1}",
        summary.standings.len(),
        summary.config.games_per_pair,
        summary.config.max_turns,
        summary.config.seed,
        summary.config.k_factor
    );
    println!();
    println!("standings:");
    for (rank, standing) in summary.standings.iter().enumerate() {
        println!(
            "  {:>2}. {:<10} elo {:>7.1} | wins {:>4} | losses {:>4} | unfinished {:>4}",
            rank + 1,
            standing.bot,
            standing.rating,
            standing.wins,
            standing.losses,
            standing.unfinished
        );
    }
    println!();
    println!("matchups:");
    for matchup in &summary.matchups {
        println!(
            "  {:<10} vs {:<10} {:>4}-{:>4} | unfinished {:>4} | avg turns {:>6.2}",
            matchup.first,
            matchup.second,
            matchup.wins_first,
            matchup.wins_second,
            matchup.unfinished,
            matchup.average_turns
        );
    }
}

fn print_compare_summary(summary: &CompareSummary) {
    println!(
        "compare: {} vs {}",
        summary.candidate.bot, summary.baseline.bot
    );
    println!(
        "games: {} / {} | batch {} | min {} | seed {}",
        summary.total_games,
        summary.config.max_games,
        summary.config.batch_size,
        summary.config.min_games,
        summary.config.seed
    );
    println!(
        "max turns: {} | z: {:.2} | verdict: {:?}{}",
        summary.config.max_turns,
        summary.config.confidence_z,
        summary.verdict,
        if summary.stopped_early {
            " | stopped early"
        } else {
            ""
        }
    );
    println!(
        "elapsed: {:.3}s | throughput: {:.1} games/s | avg turns: {:.2}",
        summary.elapsed_ms as f64 / 1_000.0,
        summary.games_per_second,
        summary.average_turns
    );
    println!();
    println!(
        "candidate score: {:.3} (CI {:.3}..{:.3}) | elo diff {:.1} (CI {:.1}..{:.1})",
        summary.candidate_score,
        summary.score_ci_low,
        summary.score_ci_high,
        summary.estimated_elo_diff,
        summary.elo_ci_low,
        summary.elo_ci_high
    );
    println!();
    println!("results:");
    println!("  {:<10} {}", summary.candidate.bot, summary.candidate.wins);
    println!("  {:<10} {}", summary.baseline.bot, summary.baseline.wins);
    println!("  {:<10} {}", "unfinished", summary.unfinished_games);
}

fn print_seat_line(bot: BotName, seat: &str, record: six_tac_bots::SeatRecord) {
    println!(
        "  {:<10} as {:<10} games {:>4} | wins {:>4} | losses {:>4} | unfinished {:>4}",
        bot, seat, record.games, record.wins, record.losses, record.unfinished
    );
}

fn usage() -> &'static str {
    "Usage:
  cargo run --manifest-path bots/Cargo.toml --bin harness -- list
  cargo run --manifest-path bots/Cargo.toml --bin harness -- match <bot-a> <bot-b> [--games N] [--max-turns N] [--seed N] [--json]
  cargo run --manifest-path bots/Cargo.toml --bin harness -- elo all [--games N] [--max-turns N] [--seed N] [--k-factor N] [--json]
  cargo run --manifest-path bots/Cargo.toml --bin harness -- elo <bot-a> <bot-b> <bot-c>... [--games N] [--max-turns N] [--seed N] [--k-factor N] [--json]
  cargo run --manifest-path bots/Cargo.toml --bin harness -- compare <candidate> <baseline> [--games N] [--batch-size N] [--min-games N] [--max-turns N] [--seed N] [--confidence-z N] [--json]

Examples:
  cargo run --manifest-path bots/Cargo.toml --bin harness -- match ambrosia seal --games 1000
  cargo run --manifest-path bots/Cargo.toml --bin harness -- elo all --games 200
  cargo run --manifest-path bots/Cargo.toml --bin harness -- compare ambrosia seal --games 1000 --batch-size 100 --min-games 200"
}
