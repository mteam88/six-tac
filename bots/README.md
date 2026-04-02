# six-tac-bots

Separate Rust/WASM bot crate for Six Tac.

## Bots

- `sprout`: random legal-move bot
- `seal`: threat-aware minimax bot translated and adapted from ideas in Ramora0's HexTicTacToe project:
  - candidate generation near the frontier
  - instant-win detection
  - threat-window filtering
  - alpha-beta search over two-stone turns

The bot crate is intentionally separate from `engine/`, while reusing the core engine as a library.
