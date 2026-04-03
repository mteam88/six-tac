# six-tac-bots

Separate Rust/WASM bot crate for Six Tac.

## Bots

- `sprout`: random legal-move bot
- `seal`: threat-aware minimax bot translated and adapted from ideas in Ramora0's HexTicTacToe project:
  - candidate generation near the frontier
  - instant-win detection
  - threat-window filtering
  - alpha-beta search over two-stone turns
- `ambrosia`: feature-weighted heuristic bot inspired by trueharuu's Ambrosia project, translated into new logic for this engine's full-turn API
- `hydra`: deeper tactical search bot with stronger pair ordering, forced-block defense, immediate-threat forking, and richer window/cluster evaluation

The bot crate is intentionally separate from `engine/`, while reusing the core engine as a library.

## Native harness

Use the native Rust harness to develop and evaluate new bots without going through wasm:

```bash
cargo run --release --manifest-path bots/Cargo.toml --bin harness -- match hydra seal --games 1000
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
cargo run --release --manifest-path bots/Cargo.toml --bin harness -- compare hydra seal --games 1000 --batch-size 100 --min-games 200
```
