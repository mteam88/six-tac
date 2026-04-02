# Six Tac v1

Minimal MVP for infinite hex tic tac toe.

## Stack

- Frontend: plain TypeScript + canvas
- Backend: plain TypeScript using Node's built-in `http` module
- Rules engine: Rust (`engine/`), invoked by the backend through a tiny CLI bridge
- Storage: in-memory rooms only

## Features

- Create a room
- Join with a 6 digit code
- No usernames or accounts
- Two-player turn handling
- Infinite hex canvas with pan
- Polling-based room sync

## Run

```bash
npm start
```

Then open:

```text
http://localhost:3000
```
