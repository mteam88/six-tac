# Six Tac

Minimal infinite hex tic tac toe.

Credit to [@webgoatguy](https://www.youtube.com/@webgoatguy) on Youtube: [https://www.youtube.com/watch?v=Ob6QINTMIOA](https://www.youtube.com/watch?v=Ob6QINTMIOA)

## Stack

- Frontend: plain TypeScript + canvas
- Runtime: Cloudflare Workers
- Multiplayer storage: Durable Objects
- Rules engine: Rust compiled to WebAssembly (`engine/`)

## Features

- Local play mode
- Fully offline local games after the app has been loaded once
- Create a room
- Join with a 6 digit code
- Play against Rust/WASM bots (`sprout`, `seal`)
- Anonymous matchmaking
- Configurable chess clocks for online games
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
- The Rust engine is compiled to `wasm32-unknown-unknown` and bound both into the Worker and the browser with `wasm-bindgen`.
- A service worker caches the app shell and browser wasm so local games can resume offline after the first successful load.
- Each online room is backed by a Durable Object instance keyed by the 6 digit room code.
