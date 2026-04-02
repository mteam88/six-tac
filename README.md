# Six Tac

Minimal infinite hex tic tac toe.

## Stack

- Frontend: plain TypeScript + canvas
- Runtime: Cloudflare Workers
- Multiplayer storage: Durable Objects
- Rules engine: Rust compiled to WebAssembly (`engine/`)

## Features

- Local play mode
- Create a room
- Join with a 6 digit code
- No usernames or accounts
- Two-player turn handling
- Infinite hex canvas with pan
- Polling-based room sync

## Develop

```bash
npm install
npm run dev
```

Then open the Wrangler URL shown in the terminal.

## Deploy

```bash
npm run deploy
```

## Notes

- Static assets are built into `public/`.
- The Rust engine is compiled to `wasm32-unknown-unknown` and bound into the Worker with `wasm-bindgen`.
- Each room is backed by a Durable Object instance keyed by the 6 digit room code.
