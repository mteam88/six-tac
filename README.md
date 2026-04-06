# Six Tac

Minimal infinite hex tic tac toe.

Credit to [@webgoatguy](https://www.youtube.com/@webgoatguy) on Youtube: [https://www.youtube.com/watch?v=Ob6QINTMIOA](https://www.youtube.com/watch?v=Ob6QINTMIOA)

## Stack

- Frontend: plain TypeScript + canvas
- Runtime: Cloudflare Workers
- Multiplayer storage: Durable Objects
- Rules engine: Rust compiled to WebAssembly (`engine/`)

## Features

- Local play mode with the same configurable chess clock system used by online games
- Fully offline local games after the app has been loaded once
- Create a room
- Join with a 6 digit code
- Play against integrated bots (`sprout`, `seal`, `ambrosia`, `hydra`, `orca`, `kraken`), with a choice of whether you or the bot moves first
- Anonymous matchmaking
- Fully configurable chess clocks for online games
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

## Bot registry

`GET /api/v1/bots` now returns a small bot catalog instead of only names. Each entry includes:

- `name`
- `label`
- `description`
- `execution` (`worker` or `remote`)
- `version`
- `available`
- `offlineCapable`

The Worker uses that registry to decide whether a bot runs in Worker wasm or in the hosted Kraken runtime.

## Kraken bot service

Kraken runs through the native Rust bot service rather than the embedded Worker/browser wasm path.
The existing wasm build still works for the lighter bots.

Kraken now runs through the original vendored **Ramora0 KrakenBot Python/PyTorch implementation** behind a thin native Rust bridge.

### Local native dev service

### Modal deployment

Kraken now runs behind a dedicated Modal service and all bot turns flow through Cloudflare Queues.

1. Create a Modal secret for the service token:

```bash
TOKEN=$(openssl rand -hex 32)
uvx modal secret create six-tac-kraken-auth MODAL_BOT_TOKEN="$TOKEN"
```

2. Deploy the Modal service:

```bash
npm run deploy:modal
```

3. Set the Worker secrets:

```bash
wrangler secret put BOT_SERVICE_URL
wrangler secret put MODAL_BOT_TOKEN
```

Use the deployed Modal web URL as `BOT_SERVICE_URL` and the same token from step 1 as `MODAL_BOT_TOKEN`.

4. Deploy the Worker:

```bash
npm run deploy
```

The Worker public API stays the same. Human moves mutate session state in Durable Objects, enqueue a versioned bot-turn job, and the queue consumer calls Modal for Kraken inference.

## Deploy

```bash
npm run deploy
```

## Notes

- Static assets are built into `public/`.
- The Rust engine is compiled to `wasm32-unknown-unknown` and bound both into the Worker and the browser with `wasm-bindgen`.
- The light bots stay embedded in the Worker/browser wasm bundle; Kraken is exposed through a Modal-hosted FastAPI service that runs the vendored KrakenBot Python worker.
- A service worker caches the app shell and browser wasm so local games can resume offline after the first successful load.
- Each online room is backed by a Durable Object instance keyed by the 6 digit room code.
