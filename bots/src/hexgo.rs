use hex_tic_tac_engine::{Cube, Game};
use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::collections::HashMap;
use std::env;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

const DEFAULT_N_SIMS: usize = 100;
const DEFAULT_MODEL_PATHS: [&str; 2] = [
    "/Users/mte/Downloads/net_gen0222.pt",
    "models/net_gen0222.pt",
];

thread_local! {
    static WORKERS: RefCell<HashMap<HexgoConfig, Result<HexgoWorker, String>>> = RefCell::new(HashMap::new());
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct HexgoConfig {
    model_path: PathBuf,
    device: Option<String>,
    n_sims: usize,
}

#[derive(Serialize)]
struct WorkerRequest<'a> {
    game_json: &'a str,
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

struct HexgoWorker {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl HexgoWorker {
    fn spawn(config: &HexgoConfig) -> Result<Self, String> {
        let worker_script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("scripts")
            .join("hexgo_worker.py");

        let mut command = if let Ok(python) = env::var("HEXGO_PYTHON_EXECUTABLE") {
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
                .arg("python")
                .arg(&worker_script);
            cmd
        };

        command
            .current_dir(
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("vendor")
                    .join("hexgo"),
            )
            .env("HEXGO_MODEL_PATH", &config.model_path)
            .env("HEXGO_N_SIMS", config.n_sims.to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());

        if let Some(device) = &config.device {
            command.env("HEXGO_DEVICE", device);
        }
        if let Ok(threads) = env::var("HEXGO_TORCH_THREADS") {
            command.env("HEXGO_TORCH_THREADS", threads);
        }
        if let Ok(timeout_ms) = env::var("HEXGO_MOVE_TIMEOUT_MS") {
            command.env("HEXGO_MOVE_TIMEOUT_MS", timeout_ms);
        }

        let mut child = command.spawn().map_err(|error| error.to_string())?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "failed to capture HexGo worker stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "failed to capture HexGo worker stdout".to_string())?;
        let mut worker = Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
        };

        let ready = worker.read_line::<WorkerReady>()?;
        if !ready.ready {
            return Err(ready
                .error
                .unwrap_or_else(|| "HexGo worker failed to initialize".to_string()));
        }
        eprintln!(
            "hexgo worker ready: device={} model={} sims={}",
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

    fn choose_move(&mut self, game: &Game) -> Result<[Cube; 2], String> {
        let game_json = game.to_json().map_err(|error| error.to_string())?;
        let request = serde_json::to_string(&WorkerRequest {
            game_json: &game_json,
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
            .ok_or_else(|| "HexGo worker returned no stones".to_string())?
            .map(|[q, r]| Cube::from_axial(q, r));
        if !game.is_legal(stones) {
            return Err(format!(
                "HexGo returned an illegal move: {:?}",
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
                return Err(format!("HexGo worker exited unexpectedly: {status}"));
            }
            return Err("HexGo worker closed stdout".to_string());
        }
        serde_json::from_str(line.trim())
            .map_err(|error| format!("invalid HexGo worker response: {error}: {line}"))
    }
}

impl Drop for HexgoWorker {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn resolve_model_path() -> Result<PathBuf, String> {
    if let Ok(path) = env::var("HEXGO_MODEL_PATH") {
        let path = PathBuf::from(path);
        if path.exists() {
            return Ok(path);
        }
        return Err(format!(
            "HEXGO_MODEL_PATH points to a missing file: {}",
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
        "could not find a HexGo checkpoint. Set HEXGO_MODEL_PATH or place net_gen0222.pt in one of: {}",
        DEFAULT_MODEL_PATHS.join(", ")
    ))
}

fn resolve_n_sims(override_n_sims: Option<usize>) -> Result<usize, String> {
    let n_sims = match override_n_sims {
        Some(value) => value,
        None => env::var("HEXGO_N_SIMS")
            .ok()
            .map(|value| value.parse::<usize>())
            .transpose()
            .map_err(|error| format!("invalid HEXGO_N_SIMS: {error}"))?
            .unwrap_or(DEFAULT_N_SIMS),
    };

    if n_sims == 0 {
        return Err("hexgo sims must be at least 1".to_string());
    }
    Ok(n_sims)
}

fn resolve_worker_config(override_n_sims: Option<usize>) -> Result<HexgoConfig, String> {
    Ok(HexgoConfig {
        model_path: resolve_model_path()?,
        device: env::var("HEXGO_DEVICE").ok(),
        n_sims: resolve_n_sims(override_n_sims)?,
    })
}

#[allow(dead_code)]
pub(crate) fn is_hexgo_available() -> bool {
    resolve_model_path().is_ok()
}

pub(crate) fn choose_hexgo_move(game: &Game) -> Result<[Cube; 2], String> {
    choose_hexgo_move_cached(game, None)
}

pub(crate) fn choose_hexgo_move_with_sims(game: &Game, sims: usize) -> Result<[Cube; 2], String> {
    choose_hexgo_move_cached_with_sims(game, None, Some(sims))
}

pub(crate) fn choose_hexgo_move_uncached(game: &Game) -> Result<[Cube; 2], String> {
    choose_hexgo_move_uncached_with_sims(game, None)
}

pub(crate) fn choose_hexgo_move_cached(
    game: &Game,
    _cache_key: Option<&str>,
) -> Result<[Cube; 2], String> {
    choose_hexgo_move_cached_with_sims(game, None, None)
}

pub(crate) fn choose_hexgo_move_uncached_with_sims(
    game: &Game,
    sims: Option<usize>,
) -> Result<[Cube; 2], String> {
    let config = resolve_worker_config(sims)?;
    let mut worker = HexgoWorker::spawn(&config)?;
    worker.choose_move(game)
}

pub(crate) fn choose_hexgo_move_cached_with_sims(
    game: &Game,
    _cache_key: Option<&str>,
    sims: Option<usize>,
) -> Result<[Cube; 2], String> {
    let config = resolve_worker_config(sims)?;
    WORKERS.with(|slot| {
        let mut slot = slot.borrow_mut();
        for attempt in 0..2 {
            if !slot.contains_key(&config) {
                slot.insert(config.clone(), HexgoWorker::spawn(&config));
            }
            match slot.get_mut(&config).expect("hexgo worker initialized") {
                Ok(worker) => match worker.choose_move(game) {
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
        Err("failed to communicate with HexGo worker".to_string())
    })
}
