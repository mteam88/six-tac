# Six Tac

Minimal infinite hex tic tac toe.

Credit to [@webgoatguy](https://www.youtube.com/@webgoatguy) on Youtube: [https://www.youtube.com/watch?v=Ob6QINTMIOA](https://www.youtube.com/watch?v=Ob6QINTMIOA)

## Stack

- Frontend: plain TypeScript + canvas
- Runtime: Cloudflare Workers
- State: Durable Objects
- Async compute: Cloudflare Queues
- Remote inference: Modal
- Rules engine: Rust compiled to WebAssembly (`engine/`)

## Features

- Local play mode with chess clocks
- Create a room
- Join with a 6 digit code
- Play against browser bots (`sprout`, `seal`, `ambrosia`, `hydra`, `orca`)
- Play against remote Kraken on Modal
- Anonymous sessions with token-based reconnect
- Infinite hex canvas with pan
- Polling-based room sync

## Develop

```bash
npm install
npm run dev
```

Then open the Wrangler URL shown in the terminal.

## Bot registry

`GET /api/v1/bots` returns a bot catalog. Each entry includes:

- `name`
- `label`
- `description`
- `execution` (`browser` or `remote`)
- `version`
- `available`
- `offlineCapable`

## Compute API

The Worker exposes session-agnostic compute primitives:

- `POST /api/v1/compute/best-move`
- `POST /api/v1/compute/best-move/jobs`
- `POST /api/v1/compute/eval`
- `POST /api/v1/compute/eval/jobs`
- `GET /api/v1/compute/jobs/:id`

Server-side compute is Kraken-only. Browser bots run in the client.

## Session API

- `POST /api/v1/sessions/private`
- `POST /api/v1/sessions/bot`
- `POST /api/v1/sessions/join`
- `GET /api/v1/sessions/:id/state`
- `POST /api/v1/sessions/:id/moves`

Move writes use compare-and-set semantics with `basePositionId`.

## Kraken Modal deployment

1. Create the Modal secret:

```bash
TOKEN=$(openssl rand -hex 32)
uvx modal secret create six-tac-kraken-auth MODAL_BOT_TOKEN="$TOKEN"
```

2. Deploy Modal:

```bash
npm run deploy:modal
```

3. Set Worker secrets:

```bash
wrangler secret put BOT_SERVICE_URL
wrangler secret put MODAL_BOT_TOKEN
```

4. Deploy the Worker:

```bash
npm run deploy
```

## Notes

- Browser bots are computed locally and submit through the same session move API as human players.
- Remote bot turns and async evals are modeled as compute jobs backed by Durable Objects and Cloudflare Queues.
- Session staleness is based on `positionId`, not a turn counter.
- Static assets are built into `public/`.
