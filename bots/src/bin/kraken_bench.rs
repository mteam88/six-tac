#[cfg(target_arch = "wasm32")]
fn main() {
    eprintln!("kraken bench is only available on native targets");
    std::process::exit(1);
}

#[cfg(not(target_arch = "wasm32"))]
mod native {
    use hex_tic_tac_engine::Game;
    use serde::Serialize;
    use six_tac_bots::{choose_move_cached, choose_move_uncached, BotName};
    use std::env;
    use std::str::FromStr;
    use std::time::Instant;

    const DEFAULT_MAX_TURNS: usize = 512;
    const DEFAULT_CACHE_KEY: &str = "kraken-bench-session";

    #[derive(Serialize)]
    struct SampleResult {
        iteration: usize,
        turns: usize,
        ms: f64,
        ms_per_turn: f64,
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
        turn_limit: usize,
        samples: Vec<SampleResult>,
        total_ms: Stats,
        ms_per_turn: Stats,
        average_turns: f64,
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
        let mut turn_limit = DEFAULT_MAX_TURNS;
        let mut json = false;

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
                "--max-turns" => {
                    index += 1;
                    turn_limit = args
                        .get(index)
                        .ok_or_else(|| "missing value for --max-turns".to_string())?
                        .parse::<usize>()
                        .map_err(|error| format!("invalid --max-turns: {error}"))?;
                    index += 1;
                }
                "--json" => {
                    json = true;
                    index += 1;
                }
                other => {
                    return Err(format!("unrecognized flag: {other}"));
                }
            }
        }

        if iterations == 0 {
            return Err("--iterations must be at least 1".to_string());
        }
        if turn_limit == 0 {
            return Err("--max-turns must be at least 1".to_string());
        }

        for _ in 0..warmup_iterations {
            let _ = play_self_game(bot, cached, turn_limit)?;
        }

        let mut samples = Vec::with_capacity(iterations);
        for iteration in 0..iterations {
            let (turns, ms) = play_self_game(bot, cached, turn_limit)?;
            samples.push(SampleResult {
                iteration,
                turns,
                ms,
                ms_per_turn: ms / turns.max(1) as f64,
            });
        }

        let total_ms = stats(samples.iter().map(|sample| sample.ms));
        let ms_per_turn = stats(samples.iter().map(|sample| sample.ms_per_turn));
        let average_turns = samples
            .iter()
            .map(|sample| sample.turns as f64)
            .sum::<f64>()
            / samples.len() as f64;

        let result = BenchResult {
            bot,
            mode: "self-play",
            cached,
            warmup_iterations,
            iterations,
            turn_limit,
            samples,
            total_ms,
            ms_per_turn,
            average_turns,
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
            println!("turn limit: {}", result.turn_limit);
            println!("avg turns: {:.2}", result.average_turns);
            println!(
                "total ms: min {:.3} | median {:.3} | mean {:.3} | max {:.3}",
                result.total_ms.min,
                result.total_ms.median,
                result.total_ms.mean,
                result.total_ms.max
            );
            println!(
                "ms/turn: min {:.3} | median {:.3} | mean {:.3} | max {:.3}",
                result.ms_per_turn.min,
                result.ms_per_turn.median,
                result.ms_per_turn.mean,
                result.ms_per_turn.max
            );
            println!("METRIC median_ms={:.6}", result.total_ms.median);
            println!("METRIC mean_ms_per_turn={:.6}", result.ms_per_turn.mean);
            for sample in result.samples {
                println!(
                    "  [{}] turns={} total={:.3} ms per_turn={:.3} ms",
                    sample.iteration, sample.turns, sample.ms, sample.ms_per_turn
                );
            }
        }

        Ok(())
    }

    fn play_self_game(
        bot: BotName,
        cached: bool,
        turn_limit: usize,
    ) -> Result<(usize, f64), String> {
        let mut game = Game::new();
        let start = Instant::now();

        while !game.is_over() && game.turn_count() < turn_limit as u32 {
            let stones = if cached {
                choose_move_cached(bot, &game, Some(DEFAULT_CACHE_KEY))?
            } else {
                choose_move_uncached(bot, &game)?
            };
            game.play(stones)
                .map_err(|error| format!("{bot} move failed to apply: {error}"))?;
        }

        Ok((
            game.turn_count() as usize,
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
