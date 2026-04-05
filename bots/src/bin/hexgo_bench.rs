#[cfg(target_arch = "wasm32")]
fn main() {
    eprintln!("hexgo bench is only available on native targets");
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

    #[derive(Serialize)]
    struct SampleResult {
        iteration: usize,
        ms: f64,
    }

    #[derive(Serialize)]
    struct BenchResult {
        bot: BotName,
        cached: bool,
        iterations: usize,
        samples: Vec<SampleResult>,
        min_ms: f64,
        median_ms: f64,
        mean_ms: f64,
        max_ms: f64,
    }

    pub fn main() {
        if let Err(error) = run() {
            eprintln!("error: {error}");
            std::process::exit(1);
        }
    }

    fn run() -> Result<(), String> {
        let args = env::args().skip(1).collect::<Vec<_>>();
        let mut bot = BotName::Hexgo;
        let mut iterations = 5usize;
        let mut cached = true;
        let mut game_json = "{\"turns\":[]}".to_string();
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
                "--uncached" => {
                    cached = false;
                    index += 1;
                }
                "--game-json" => {
                    index += 1;
                    game_json = args
                        .get(index)
                        .ok_or_else(|| "missing value for --game-json".to_string())?
                        .to_string();
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

        let game = if game_json.trim().is_empty() {
            Game::new()
        } else {
            Game::from_json_str(&game_json).map_err(|error| error.to_string())?
        };

        let mut samples = Vec::with_capacity(iterations);
        for iteration in 0..iterations {
            let start = Instant::now();
            if cached {
                let _ = choose_move_cached(bot, &game, Some("hexgo-bench-session"))?;
            } else {
                let _ = choose_move_uncached(bot, &game)?;
            }
            samples.push(SampleResult {
                iteration,
                ms: start.elapsed().as_secs_f64() * 1000.0,
            });
        }

        let mut sorted = samples.iter().map(|sample| sample.ms).collect::<Vec<_>>();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let min_ms = *sorted.first().unwrap_or(&0.0);
        let max_ms = *sorted.last().unwrap_or(&0.0);
        let mean_ms = if sorted.is_empty() {
            0.0
        } else {
            sorted.iter().sum::<f64>() / sorted.len() as f64
        };
        let median_ms = if sorted.is_empty() {
            0.0
        } else {
            sorted[sorted.len() / 2]
        };

        let result = BenchResult {
            bot,
            cached,
            iterations,
            samples,
            min_ms,
            median_ms,
            mean_ms,
            max_ms,
        };

        if json {
            println!(
                "{}",
                serde_json::to_string_pretty(&result).map_err(|error| error.to_string())?
            );
        } else {
            println!("bot: {}", result.bot);
            println!("cached: {}", result.cached);
            println!("iterations: {}", result.iterations);
            println!("min ms: {:.3}", result.min_ms);
            println!("median ms: {:.3}", result.median_ms);
            println!("mean ms: {:.3}", result.mean_ms);
            println!("max ms: {:.3}", result.max_ms);
            for sample in result.samples {
                println!("  [{}] {:.3} ms", sample.iteration, sample.ms);
            }
        }

        Ok(())
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    native::main();
}
