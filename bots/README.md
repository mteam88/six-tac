# six-tac-bots

Separate Rust/WASM bot crate for Six Tac.

`seal` is built from the vendored `bots/vendor/SealBot` submodule:
- native builds compile a small C ABI bridge directly against the upstream C++ engine
- wasm builds require Emscripten (`em++`) and emit `bots/generated/sealbot.js` during `cargo build`

`kraken` is vendored from `bots/vendor/KrakenBot` and now runs through the original Python/PyTorch implementation behind a thin Rust translator. `hexgo` is vendored as the `bots/vendor/hexgo` git submodule from `sub-surface/hexgo` and likewise runs through the original Python/PyTorch implementation behind a thin Rust translator. Because both neural stacks are far heavier than the other bots, they are exposed through the native harness and the optional Rust HTTP bot service / Cloudflare Container runtime rather than the embedded wasm bundle.

## Bots

- `sprout`: random legal-move bot
- `seal`: vendored SealBot backend from Ramora0/SealBot with a thin state translator from Six Tac's implied-opening turn model
- `ambrosia`: feature-weighted heuristic bot inspired by trueharuu's Ambrosia project, translated into new logic for this engine's full-turn API
- `hydra`: deeper tactical search bot with stronger pair ordering, forced-block defense, immediate-threat forking, and richer window/cluster evaluation
- `orca`: balanced generic minimax bot with threat-cover scoring
  - candidate generation from ranked frontier cells
  - immediate-win and forced-block awareness
  - depth-2 alpha-beta search over two-stone turns
  - positional evaluation combining windows, line strength, connectivity, and center pressure
- `kraken`: Ramora0/KrakenBot running directly via Python + PyTorch
  - thin Rust bridge that translates Six Tac turn-list JSON into KrakenBot's native `HexGame`
  - persistent Python worker per calling thread, so the model stays loaded across requests
  - uses the original KrakenBot search/inference code instead of a Rust reimplementation
  - compatibility wrapper for Six Tac's implied opening and max-distance move rule
- `hexgo`: sub-surface/hexgo running directly via Python + PyTorch
  - vendored as a git submodule for fidelity and easy upstream syncs
  - thin Rust bridge that translates Six Tac turn-list JSON into HexGo's native `HexGame`
  - reuses upstream `net.py` + `mcts.py` with the supplied `net_gen0222.pt` checkpoint
  - served through the same native bot service registry as Kraken

The bot crate is intentionally separate from `engine/`, while reusing the core engine as a library.

## Native harness

Use the native Rust harness to develop and evaluate new bots without going through wasm:

```bash
cargo run --release --manifest-path bots/Cargo.toml --bin harness -- match orca seal --games 1000
```

Highlights:

- runs directly against the native Rust engine and bot implementations
- parallelizes independent games across CPU cores
- randomly assigns which bot gets the first move in each game
- reports per-seat win/loss splits, average game length, and throughput
- includes ELO mode for quick round-robin benchmarking across bots
- includes compare mode with confidence intervals and early stopping for head-to-head checks
- human-readable runs print incremental progress while matches are running

List available bots:

```bash
cargo run --release --manifest-path bots/Cargo.toml --bin harness -- list
```

Run the native HTTP bot service used by the Worker-backed frontend for heavy bots like Kraken and HexGo:

```bash
export KRAKEN_MODEL_PATH=/Users/mte/Downloads/kraken_v1.pt
export HEXGO_MODEL_PATH=/Users/mte/Downloads/net_gen0222.pt
cargo run --release --manifest-path bots/Cargo.toml --bin bot_service
```

Notes:
- Kraken launches the vendored Python worker through `uv run --with torch --with numpy ...`
- HexGo launches the vendored Python worker through `uv run --with torch --with numpy python ...`
- override the launchers with `KRAKEN_PYTHON_EXECUTABLE=/path/to/python` and/or `HEXGO_PYTHON_EXECUTABLE=/path/to/python` if you already have a Python env with PyTorch installed
- set `KRAKEN_DEVICE` / `HEXGO_DEVICE` to `mps`, `cuda`, or `cpu` to force a PyTorch device; otherwise each worker auto-detects
- set `KRAKEN_N_SIMS` (default 200) and `HEXGO_N_SIMS` (default 100) to tune search depth
- on MPS, the workers default to `*_TORCH_THREADS=1` to reduce CPU-side overhead; override if you want to sweep thread counts
- Kraken will try to build its optional Cython MCTS extensions on first launch (`KRAKEN_BUILD_EXTENSIONS=0` disables that)

## Cloudflare Container deployment

The Worker can now host Kraken and HexGo through the Cloudflare Container-backed Durable Object (`KrakenContainer`).

Files involved:
- `bots/Dockerfile.kraken`
- `bots/scripts/start_kraken_service.sh`
- `src/kraken-container.ts`
- `wrangler.toml`

Deployment notes:
- bundle checkpoints at `bots/models/kraken_v1.pt` and/or `bots/models/net_gen0222.pt`, or set `KRAKEN_MODEL_URL` / `HEXGO_MODEL_URL` so the container downloads them on first boot
- `KRAKEN_MODEL_VERSION` and `HEXGO_MODEL_VERSION` control the bot registry versions exposed by `/api/v1/bots`
- `KRAKEN_CONTAINER_POOL_SIZE` controls how many deterministic native-bot shards the Worker routes across
- `npm run deploy` will deploy the Worker and the configured container image together
- Wrangler needs a working local Docker CLI/daemon when building and uploading the container image

## TODO

- Add a truly stateful hosted native runtime so each game can reuse search/tree state instead of rebuilding from full `game_json` every turn.

Benchmark neural bot latency directly:

```bash
export KRAKEN_MODEL_PATH=/Users/mte/Downloads/kraken_v1.pt
cargo run --release --manifest-path bots/Cargo.toml --bin kraken_bench -- --iterations 5 --json
cargo run --release --manifest-path bots/Cargo.toml --bin kraken_bench -- --iterations 5 --uncached --json

export HEXGO_MODEL_PATH=/Users/mte/Downloads/net_gen0222.pt
cargo run --release --manifest-path bots/Cargo.toml --bin hexgo_bench -- --iterations 5 --json
cargo run --release --manifest-path bots/Cargo.toml --bin hexgo_bench -- --iterations 5 --uncached --json
```

Run ELO for all bots:

```bash
cargo run --release --manifest-path bots/Cargo.toml --bin harness -- elo all --games 200
```

The harness also accepts configured bot specs, so you can rate parameter variants separately:

```bash
cargo run --release --manifest-path bots/Cargo.toml --bin harness -- elo hydra kraken@sims=200 kraken@sims=800 hexgo@sims=100 --games 200
cargo run --release --manifest-path bots/Cargo.toml --bin harness -- elo hexgo@sims=50 hexgo@sims=150 --games 200
```

Run a head-to-head comparison with confidence bounds:

```bash
cargo run --release --manifest-path bots/Cargo.toml --bin harness -- compare orca seal --games 1000 --batch-size 100 --min-games 200
cargo run --release --manifest-path bots/Cargo.toml --bin harness -- compare kraken@sims=400 kraken@sims=800 --games 1000 --batch-size 100 --min-games 200
cargo run --release --manifest-path bots/Cargo.toml --bin harness -- compare hexgo@sims=50 hexgo@sims=150 --games 1000 --batch-size 100 --min-games 200
```

Export finished games in the frontend import format:

```bash
cargo run --release --manifest-path bots/Cargo.toml --bin harness -- match hydra seal --games 20 --export-dir out/games
```

The exported JSON files can be opened from the frontend lobby via **Explore game file** and stepped through turn by turn.

Sample a few midgame boards from Hydra-vs-Hydra self-play, then time each bot's move generation on those exact positions:

```bash
cargo run --release --manifest-path bots/Cargo.toml --bin move_bench --
```

Useful flags:

- `--games 3 --samples-per-game 2` to change how many source games/boards are sampled
- `--max-turns 40 --min-turn 8` to bias toward later positions
- `--target-ms 500` to spend more timing budget per bot per board
- `--bots hydra,orca,seal` to benchmark a subset of bots
- `--show-json` to print the sampled turn-list JSON for each board in text mode
- `--json` to emit the full benchmark report as machine-readable JSON
