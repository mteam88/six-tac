import { play_json, snapshot_json } from "../engine";
import { buildLocalSessionView } from "../domain/session-state";
import type { Cube, EngineSnapshot } from "../domain/types";
import { json, readJson } from "./utils";

function callSnapshot(gameJson: string): EngineSnapshot {
  return JSON.parse(snapshot_json(gameJson)) as EngineSnapshot;
}

function callPlay(gameJson: string, stones: Cube[]): EngineSnapshot {
  if (stones.length !== 2) {
    throw new Error("A turn must contain exactly 2 stones");
  }
  return JSON.parse(play_json(gameJson, JSON.stringify(stones))) as EngineSnapshot;
}

export async function handleLocalStart(): Promise<Response> {
  return json(buildLocalSessionView(callSnapshot('{"turns":[]}')));
}

export async function handleLocalMove(request: Request): Promise<Response> {
  const body = await readJson<{ gameJson?: string; stones?: Cube[] }>(request);
  if (typeof body.gameJson !== "string") {
    return json({ error: "Missing local game state" }, 400);
  }
  if (!Array.isArray(body.stones) || body.stones.length !== 2) {
    return json({ error: "A turn must contain exactly 2 stones" }, 400);
  }

  return json(buildLocalSessionView(callPlay(body.gameJson, body.stones)));
}
