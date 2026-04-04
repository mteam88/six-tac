use hex_tic_tac_engine::{Cube, Game};
use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::collections::HashMap;
use std::env;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

const DEFAULT_N_SIMS: usize = 200;
const DEFAULT_MODEL_PATHS: [&str; 2] = ["/Users/mte/Downloads/kraken_v1.pt", "models/kraken_v1.pt"];

thread_local! {
    static WORKERS: RefCell<HashMap<KrakenConfig, Result<KrakenWorker, String>>> = RefCell::new(HashMap::new());
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct KrakenConfig {
    model_path: PathBuf,
    device: Option<String>,
    n_sims: usize,
}

#[derive(Serialize)]
struct WorkerRequest<'a> {
    turns: Vec<[[i32; 2]; 2]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cache_key: Option<&'a str>,
}

#[derive(Deserialize)]
struct WorkerReady {
    ready: bool,
    device: Option<String>,
    model_path: Option<String>,
    n_sims: Option<usize>,
    error: Option<String>,
}

#[derive(Deserialize)]
struct WorkerResponse {
    stones: Option<[[i32; 2]; 2]>,
    error: Option<String>,
}

struct KrakenWorker {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl KrakenWorker {
    fn spawn(config: &KrakenConfig) -> Result<Self, String> {
        let worker_script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("scripts")
            .join("krakenbot_worker.py");

        let mut command = if let Ok(python) = env::var("KRAKEN_PYTHON_EXECUTABLE") {
            let mut cmd = Command::new(python);
            cmd.arg(&worker_script);
            cmd
        } else {
            let mut cmd = Command::new("uv");
            cmd.arg("run")
                .arg("--no-project")
                .arg("--with")
                .arg("torch")
                .arg("--with")
                .arg("numpy")
                .arg("--with")
                .arg("cython")
                .arg("python")
                .arg(&worker_script);
            cmd
        };

        command
            .current_dir(
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("vendor")
                    .join("KrakenBot"),
            )
            .env("KRAKEN_MODEL_PATH", &config.model_path)
            .env("KRAKEN_N_SIMS", config.n_sims.to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());

        if let Some(device) = &config.device {
            command.env("KRAKEN_DEVICE", device);
        }

        let mut child = command.spawn().map_err(|error| error.to_string())?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "failed to capture KrakenBot worker stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "failed to capture KrakenBot worker stdout".to_string())?;
        let mut worker = Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
        };

        let ready = worker.read_line::<WorkerReady>()?;
        if !ready.ready {
            return Err(ready
                .error
                .unwrap_or_else(|| "KrakenBot worker failed to initialize".to_string()));
        }
        eprintln!(
            "krakenbot worker ready: device={} model={} sims={}",
            ready
                .device
                .or_else(|| config.device.clone())
                .unwrap_or_else(|| "unknown".to_string()),
            ready
                .model_path
                .unwrap_or_else(|| config.model_path.display().to_string()),
            ready.n_sims.unwrap_or(config.n_sims),
        );

        Ok(worker)
    }

    fn choose_move(&mut self, game: &Game, cache_key: Option<&str>) -> Result<[Cube; 2], String> {
        let request = serde_json::to_string(&WorkerRequest {
            turns: game
                .turns()
                .map(|turn| {
                    turn.stones.map(|stone| {
                        let (q, r) = stone.axial();
                        [q, r]
                    })
                })
                .collect(),
            cache_key,
        })
        .map_err(|error| error.to_string())?;
        self.stdin
            .write_all(request.as_bytes())
            .and_then(|_| self.stdin.write_all(b"\n"))
            .and_then(|_| self.stdin.flush())
            .map_err(|error| error.to_string())?;

        let response = self.read_line::<WorkerResponse>()?;
        if let Some(error) = response.error {
            return Err(error);
        }
        let stones = response
            .stones
            .ok_or_else(|| "KrakenBot worker returned no stones".to_string())?
            .map(|[q, r]| Cube::from_axial(q, r));
        if !game.is_legal(stones) {
            return Err(format!(
                "KrakenBot returned an illegal move: {:?}",
                stones.map(|stone| stone.axial())
            ));
        }
        Ok(stones)
    }

    fn read_line<T: for<'de> Deserialize<'de>>(&mut self) -> Result<T, String> {
        let mut line = String::new();
        let bytes = self
            .stdout
            .read_line(&mut line)
            .map_err(|error| error.to_string())?;
        if bytes == 0 {
            if let Some(status) = self.child.try_wait().map_err(|error| error.to_string())? {
                return Err(format!("KrakenBot worker exited unexpectedly: {status}"));
            }
            return Err("KrakenBot worker closed stdout".to_string());
        }
        serde_json::from_str(line.trim())
            .map_err(|error| format!("invalid KrakenBot worker response: {error}: {line}"))
    }
}

impl Drop for KrakenWorker {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn resolve_model_path() -> Result<PathBuf, String> {
    if let Ok(path) = env::var("KRAKEN_MODEL_PATH") {
        let path = PathBuf::from(path);
        if path.exists() {
            return Ok(path);
        }
        return Err(format!(
            "KRAKEN_MODEL_PATH points to a missing file: {}",
            path.display()
        ));
    }

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    for candidate in DEFAULT_MODEL_PATHS {
        let path = Path::new(candidate);
        let path = if path.is_absolute() {
            path.to_path_buf()
        } else {
            manifest_dir.join(path)
        };
        if path.exists() {
            return Ok(path);
        }
    }

    Err(format!(
        "could not find a Kraken checkpoint. Set KRAKEN_MODEL_PATH or place kraken_v1.pt in one of: {}",
        DEFAULT_MODEL_PATHS.join(", ")
    ))
}

fn resolve_n_sims(override_n_sims: Option<usize>) -> Result<usize, String> {
    let n_sims = match override_n_sims {
        Some(value) => value,
        None => env::var("KRAKEN_N_SIMS")
            .ok()
            .map(|value| value.parse::<usize>())
            .transpose()
            .map_err(|error| format!("invalid KRAKEN_N_SIMS: {error}"))?
            .unwrap_or(DEFAULT_N_SIMS),
    };

    if n_sims == 0 {
        return Err("kraken sims must be at least 1".to_string());
    }
    Ok(n_sims)
}

fn resolve_worker_config(override_n_sims: Option<usize>) -> Result<KrakenConfig, String> {
    Ok(KrakenConfig {
        model_path: resolve_model_path()?,
        device: env::var("KRAKEN_DEVICE").ok(),
        n_sims: resolve_n_sims(override_n_sims)?,
    })
}

#[allow(dead_code)]
pub(crate) fn is_kraken_available() -> bool {
    resolve_model_path().is_ok()
}

pub(crate) fn choose_kraken_move(game: &Game) -> Result<[Cube; 2], String> {
    choose_kraken_move_cached(game, None)
}

pub(crate) fn choose_kraken_move_with_sims(game: &Game, sims: usize) -> Result<[Cube; 2], String> {
    choose_kraken_move_cached_with_sims(game, None, Some(sims))
}

pub(crate) fn choose_kraken_move_uncached(game: &Game) -> Result<[Cube; 2], String> {
    choose_kraken_move_uncached_with_sims(game, None)
}

pub(crate) fn choose_kraken_move_cached(
    game: &Game,
    cache_key: Option<&str>,
) -> Result<[Cube; 2], String> {
    choose_kraken_move_cached_with_sims(game, cache_key, None)
}

pub(crate) fn choose_kraken_move_uncached_with_sims(
    game: &Game,
    sims: Option<usize>,
) -> Result<[Cube; 2], String> {
    let _ = sims;
    let config = resolve_worker_config(sims)?;
    let mut worker = KrakenWorker::spawn(&config)?;
    worker.choose_move(game, None)
}

pub(crate) fn choose_kraken_move_cached_with_sims(
    game: &Game,
    cache_key: Option<&str>,
    sims: Option<usize>,
) -> Result<[Cube; 2], String> {
    let config = resolve_worker_config(sims)?;
    WORKERS.with(|slot| {
        let mut slot = slot.borrow_mut();
        for attempt in 0..2 {
            if !slot.contains_key(&config) {
                slot.insert(config.clone(), KrakenWorker::spawn(&config));
            }
            match slot.get_mut(&config).expect("kraken worker initialized") {
                Ok(worker) => match worker.choose_move(game, cache_key) {
                    Ok(stones) => return Ok(stones),
                    Err(_error) if attempt == 0 => {
                        slot.remove(&config);
                        continue;
                    }
                    Err(error) => return Err(error),
                },
                Err(error) => return Err(error.clone()),
            }
        }
        Err("failed to communicate with KrakenBot worker".to_string())
    })
}
