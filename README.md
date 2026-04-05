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
- Play against integrated bots (`sprout`, `seal`, `ambrosia`, `hydra`, `orca`, `kraken`, `hexgo`), with a choice of whether you or the bot moves first
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

The Worker uses that registry to decide whether a bot runs in Worker wasm or in a hosted native runtime.

## Native bot service

Kraken and HexGo run through the native Rust bot service rather than the embedded Worker/browser wasm path.
The existing wasm build still works for the lighter bots.

- Kraken runs through the original vendored **Ramora0 KrakenBot Python/PyTorch implementation** behind a thin native Rust bridge.
- HexGo runs through the vendored **sub-surface/hexgo net.py checkpoint stack** behind a matching native Rust bridge.

### Local native dev service

Start the native service with the creator checkpoints:

```bash
export KRAKEN_MODEL_PATH=/Users/mte/Downloads/kraken_v1.pt
export HEXGO_MODEL_PATH=/Users/mte/Downloads/net_gen0222.pt
npm run bot-service
```

Useful overrides:

```bash
export KRAKEN_DEVICE=mps
export KRAKEN_N_SIMS=200
export KRAKEN_TORCH_THREADS=1
export HEXGO_DEVICE=mps
export HEXGO_N_SIMS=100
export HEXGO_TORCH_THREADS=1

export KRAKEN_PYTHON_EXECUTABLE=/path/to/python
export HEXGO_PYTHON_EXECUTABLE=/path/to/python
```

The native harness/service also understands configured bot specs like `kraken@sims=400` and `hexgo@sims=150` on the native side.

Then point the Worker at it with a Wrangler binding:

```bash
printf 'BOT_SERVICE_URL="http://127.0.0.1:8788"\n' > .dev.vars
npm run dev
```

### Cloudflare Containers deployment

Production hosting for the heavy native bots now uses the Cloudflare Container-backed Durable Object (`KrakenContainer`). Despite the legacy name, the same container runtime now serves both Kraken and HexGo through the native Rust bot service.

1. Make the model(s) available to the container:
   - easiest: copy them into `bots/models/` before deploying, or
   - set Worker secrets so the container downloads them on first start:

```bash
wrangler secret put KRAKEN_MODEL_URL
wrangler secret put HEXGO_MODEL_URL
```

2. Optionally tune runtime vars in `wrangler.toml` or secrets/vars:

```toml
[vars]
KRAKEN_MODEL_VERSION = "kraken_v1"
KRAKEN_CONTAINER_POOL_SIZE = "2"
KRAKEN_DEVICE = "cpu"
KRAKEN_BUILD_EXTENSIONS = "0"
KRAKEN_MOVE_TIMEOUT_MS = "30000"
HEXGO_MODEL_VERSION = "net_gen0222"
HEXGO_DEVICE = "cpu"
HEXGO_MOVE_TIMEOUT_MS = "30000"
```

3. Deploy everything together:

```bash
npm run deploy
```

Wrangler needs a working local Docker CLI/daemon to build and upload the Kraken container image.

That deploys the Worker, assets, Durable Object migrations, and the native bot container image defined in `bots/Dockerfile.kraken`.

The Worker keeps the public API the same and forwards Kraken and HexGo turns internally to the container runtime.

Remote bot turns now run with a 30s timeout, automatically restart/retry once on transient container failures, and continue in the background so the player move request does not stay blocked waiting for the native bot runtime.

## Deploy

```bash
npm run deploy
```

## Notes

- Static assets are built into `public/`.
- The Rust engine is compiled to `wasm32-unknown-unknown` and bound both into the Worker and the browser with `wasm-bindgen`.
- The light bots stay embedded in the Worker/browser wasm bundle; Kraken and HexGo are exposed through a native Rust HTTP bot service that forwards to their original vendored Python workers loaded from the creator checkpoints.
- A service worker caches the app shell and browser wasm so local games can resume offline after the first successful load.
- Each online room is backed by a Durable Object instance keyed by the 6 digit room code.
