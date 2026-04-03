# six-tac-bots

Separate Rust/WASM bot crate for Six Tac.

`seal` is built from the vendored `bots/vendor/SealBot` submodule:
- native builds compile a small C ABI bridge directly against the upstream C++ engine
- wasm builds require Emscripten (`em++`) and emit `bots/generated/sealbot.js` during `cargo build`

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

Run ELO for all bots:

```bash
cargo run --release --manifest-path bots/Cargo.toml --bin harness -- elo all --games 200
```

Run a head-to-head comparison with confidence bounds:

```bash
cargo run --release --manifest-path bots/Cargo.toml --bin harness -- compare orca seal --games 1000 --batch-size 100 --min-games 200
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
