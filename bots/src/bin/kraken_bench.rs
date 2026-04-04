#[cfg(target_arch = "wasm32")]
fn main() {
    eprintln!("kraken bench is only available on native targets");
    std::process::exit(1);
}

#[cfg(not(target_arch = "wasm32"))]
mod native {
    use hex_tic_tac_engine::{Game, TurnList};
    use serde::Serialize;
    use six_tac_bots::{choose_move_cached_peek, choose_move_uncached, BotName};
    use std::env;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::str::FromStr;
    use std::time::Instant;

    const DEFAULT_CACHE_KEY: &str = "kraken-bench-game";
    const DEFAULT_GAME_JSON_PATH: &str =
        concat!(env!("CARGO_MANIFEST_DIR"), "/data/kraken/bench-game.json");

    #[derive(Serialize)]
    struct SampleResult {
        iteration: usize,
        positions: usize,
        ms: f64,
        ms_per_position: f64,
    }

    #[derive(Serialize)]
    struct Stats {
        min: f64,
        median: f64,
        mean: f64,
        max: f64,
    }

    #[derive(Serialize)]
    struct BenchResult {
        bot: BotName,
        mode: &'static str,
        cached: bool,
        warmup_iterations: usize,
        iterations: usize,
        game_json_path: String,
        explicit_turns: usize,
        total_stones: usize,
        samples: Vec<SampleResult>,
        total_ms: Stats,
        ms_per_position: Stats,
    }

    pub fn main() {
        if let Err(error) = run() {
            eprintln!("error: {error}");
            std::process::exit(1);
        }
    }

    fn run() -> Result<(), String> {
        let args = env::args().skip(1).collect::<Vec<_>>();
        let mut bot = BotName::Kraken;
        let mut iterations = 5usize;
        let mut warmup_iterations = 1usize;
        let mut cached = true;
        let mut json = false;
        let mut game_json_path = PathBuf::from(DEFAULT_GAME_JSON_PATH);
        let mut inline_game_json: Option<String> = None;

        let mut index = 0;
        while index < args.len() {
            match args[index].as_str() {
                "--bot" => {
                    index += 1;
                    bot = BotName::from_str(
                        args.get(index)
                            .ok_or_else(|| "missing value for --bot".to_string())?,
                    )?;
                    index += 1;
                }
                "--iterations" | "-n" => {
                    index += 1;
                    iterations = args
                        .get(index)
                        .ok_or_else(|| "missing value for --iterations".to_string())?
                        .parse::<usize>()
                        .map_err(|error| format!("invalid --iterations: {error}"))?;
                    index += 1;
                }
                "--warmup" => {
                    index += 1;
                    warmup_iterations = args
                        .get(index)
                        .ok_or_else(|| "missing value for --warmup".to_string())?
                        .parse::<usize>()
                        .map_err(|error| format!("invalid --warmup: {error}"))?;
                    index += 1;
                }
                "--uncached" => {
                    cached = false;
                    index += 1;
                }
                "--game-json-file" => {
                    index += 1;
                    game_json_path = PathBuf::from(
                        args.get(index)
                            .ok_or_else(|| "missing value for --game-json-file".to_string())?,
                    );
                    index += 1;
                }
                "--game-json" => {
                    index += 1;
                    inline_game_json = Some(
                        args.get(index)
                            .ok_or_else(|| "missing value for --game-json".to_string())?
                            .to_string(),
                    );
                    index += 1;
                }
                "--json" => {
                    json = true;
                    index += 1;
                }
                other => return Err(format!("unrecognized flag: {other}")),
            }
        }

        if iterations == 0 {
            return Err("--iterations must be at least 1".to_string());
        }

        let (turn_list, game_source) = load_turn_list(inline_game_json, &game_json_path)?;
        if turn_list.turns.is_empty() {
            return Err("benchmark game must include at least one explicit turn".to_string());
        }

        for _ in 0..warmup_iterations {
            let _ = play_reference_game(bot, &turn_list, cached)?;
        }

        let mut samples = Vec::with_capacity(iterations);
        for iteration in 0..iterations {
            let (positions, ms) = play_reference_game(bot, &turn_list, cached)?;
            samples.push(SampleResult {
                iteration,
                positions,
                ms,
                ms_per_position: ms / positions.max(1) as f64,
            });
        }

        let total_ms = stats(samples.iter().map(|sample| sample.ms));
        let ms_per_position = stats(samples.iter().map(|sample| sample.ms_per_position));
        let result = BenchResult {
            bot,
            mode: "reference-game-prefixes",
            cached,
            warmup_iterations,
            iterations,
            game_json_path: game_source,
            explicit_turns: turn_list.turns.len(),
            total_stones: 1 + turn_list.turns.len() * 2,
            samples,
            total_ms,
            ms_per_position,
        };

        if json {
            println!(
                "{}",
                serde_json::to_string_pretty(&result).map_err(|error| error.to_string())?
            );
        } else {
            println!("bot: {}", result.bot);
            println!("mode: {}", result.mode);
            println!("cached: {}", result.cached);
            println!("warmup iterations: {}", result.warmup_iterations);
            println!("iterations: {}", result.iterations);
            println!("game json: {}", result.game_json_path);
            println!("explicit turns: {}", result.explicit_turns);
            println!("total stones: {}", result.total_stones);
            println!(
                "total ms: min {:.3} | median {:.3} | mean {:.3} | max {:.3}",
                result.total_ms.min,
                result.total_ms.median,
                result.total_ms.mean,
                result.total_ms.max
            );
            println!(
                "ms/position: min {:.3} | median {:.3} | mean {:.3} | max {:.3}",
                result.ms_per_position.min,
                result.ms_per_position.median,
                result.ms_per_position.mean,
                result.ms_per_position.max
            );
            println!("METRIC median_ms={:.6}", result.total_ms.median);
            println!(
                "METRIC mean_ms_per_position={:.6}",
                result.ms_per_position.mean
            );
            for sample in result.samples {
                println!(
                    "  [{}] positions={} total={:.3} ms per_position={:.3} ms",
                    sample.iteration, sample.positions, sample.ms, sample.ms_per_position
                );
            }
        }

        Ok(())
    }

    fn load_turn_list(
        inline_game_json: Option<String>,
        game_json_path: &Path,
    ) -> Result<(TurnList, String), String> {
        let (json, source) = match inline_game_json {
            Some(json) => (json, "inline --game-json".to_string()),
            None => (
                fs::read_to_string(game_json_path).map_err(|error| {
                    format!("could not read {}: {error}", game_json_path.display())
                })?,
                game_json_path.display().to_string(),
            ),
        };
        let turn_list = TurnList::from_json_str(&json).map_err(|error| error.to_string())?;
        Ok((turn_list, source))
    }

    fn play_reference_game(
        bot: BotName,
        turn_list: &TurnList,
        cached: bool,
    ) -> Result<(usize, f64), String> {
        let mut game = Game::new();
        let start = Instant::now();

        for turn in turn_list.turns.iter().copied() {
            let _ = if cached {
                choose_move_cached_peek(bot, &game, Some(DEFAULT_CACHE_KEY))?
            } else {
                choose_move_uncached(bot, &game)?
            };
            game.play(turn.stones)
                .map_err(|error| format!("failed to apply reference turn: {error}"))?;
        }

        Ok((
            turn_list.turns.len(),
            start.elapsed().as_secs_f64() * 1000.0,
        ))
    }

    fn stats(values: impl Iterator<Item = f64>) -> Stats {
        let mut sorted = values.collect::<Vec<_>>();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

        let min = *sorted.first().unwrap_or(&0.0);
        let max = *sorted.last().unwrap_or(&0.0);
        let mean = if sorted.is_empty() {
            0.0
        } else {
            sorted.iter().sum::<f64>() / sorted.len() as f64
        };
        let median = if sorted.is_empty() {
            0.0
        } else {
            sorted[sorted.len() / 2]
        };

        Stats {
            min,
            median,
            mean,
            max,
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    native::main();
}
