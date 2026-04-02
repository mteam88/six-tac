import { DurableObject } from "cloudflare:workers";
import { play_json, snapshot_json } from "./engine";

type Seat = "one" | "two" | "spectator" | "local";
type Player = "One" | "Two";
type RoomMode = "online" | "local";

type Cube = {
  x: number;
  y: number;
  z: number;
};

type Stone = Cube & {
  player: Player;
};

type EngineSnapshot = {
  current_player: Player;
  winner: Player | null;
  turn_count: number;
  stone_count: number;
  turns_json: string;
  stones: Stone[];
};

type RoomData = {
  code: string;
  turnsJson: string;
  seats: {
    one: string | null;
    two: string | null;
  };
};

type RoomState = {
  mode: RoomMode;
  code: string | null;
  seat: Seat;
  currentPlayer: Player;
  winner: Player | null;
  yourTurn: boolean;
  turns: number;
  stones: Stone[];
  lastTurnPlayer: Player | null;
  lastTurnStones: Cube[];
  gameJson: string;
};

type Env = {
  ASSETS: Fetcher;
  ROOMS: DurableObjectNamespace;
};

const EMPTY_GAME_JSON = '{"turns":[]}';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function readJson<T>(request: Request): Promise<T> {
  const text = await request.text();
  if (!text.trim()) {
    return {} as T;
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("Invalid JSON body");
  }
}

function createToken(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

function randomInt(maxExclusive: number): number {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return values[0] % maxExclusive;
}

function generateCode(): string {
  return String(randomInt(1_000_000)).padStart(6, "0");
}

function playerForSeat(seat: Seat): Player | null {
  if (seat === "one") return "One";
  if (seat === "two") return "Two";
  return null;
}

function getLastTurnInfo(turnsJson: string): { lastTurnPlayer: Player | null; lastTurnStones: Cube[] } {
  const parsed = JSON.parse(turnsJson) as { turns?: Array<{ stones?: Cube[] }> };
  const turns = parsed.turns ?? [];
  if (turns.length === 0) {
    return {
      lastTurnPlayer: null,
      lastTurnStones: [],
    };
  }

  const index = turns.length - 1;
  return {
    lastTurnPlayer: index % 2 === 0 ? "Two" : "One",
    lastTurnStones: turns[index].stones ?? [],
  };
}

function buildStateFromSnapshot(
  snapshot: EngineSnapshot,
  options: { mode: RoomMode; code: string | null; seat: Seat; yourTurn: boolean },
): RoomState {
  const lastTurn = getLastTurnInfo(snapshot.turns_json);
  return {
    mode: options.mode,
    code: options.code,
    seat: options.seat,
    currentPlayer: snapshot.current_player,
    winner: snapshot.winner,
    yourTurn: options.yourTurn,
    turns: snapshot.turn_count,
    stones: snapshot.stones,
    lastTurnPlayer: lastTurn.lastTurnPlayer,
    lastTurnStones: lastTurn.lastTurnStones,
    gameJson: snapshot.turns_json,
  };
}

function callSnapshot(gameJson: string): EngineSnapshot {
  return JSON.parse(snapshot_json(gameJson)) as EngineSnapshot;
}

function callPlay(gameJson: string, stones: Cube[]): EngineSnapshot {
  if (stones.length !== 2) {
    throw new Error("A turn must contain exactly 2 stones");
  }
  return JSON.parse(play_json(gameJson, JSON.stringify(stones))) as EngineSnapshot;
}

function buildRoomState(room: RoomData, seat: Seat): RoomState {
  const snapshot = callSnapshot(room.turnsJson);
  return buildStateFromSnapshot(snapshot, {
    mode: "online",
    code: room.code,
    seat,
    yourTurn: Boolean(playerForSeat(seat) && playerForSeat(seat) === snapshot.current_player && !snapshot.winner),
  });
}

function buildLocalState(gameJson: string): RoomState {
  const snapshot = callSnapshot(gameJson);
  return buildStateFromSnapshot(snapshot, {
    mode: "local",
    code: null,
    seat: "local",
    yourTurn: !snapshot.winner,
  });
}

function getSeatForToken(room: RoomData, token: string | null): Seat {
  if (!token) return "spectator";
  if (room.seats.one === token) return "one";
  if (room.seats.two === token) return "two";
  return "spectator";
}

function roomStub(env: Env, code: string): DurableObjectStub {
  return env.ROOMS.get(env.ROOMS.idFromName(code));
}

async function createRoom(env: Env): Promise<Response> {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const code = generateCode();
    const response = await roomStub(env, code).fetch("https://room/internal/init", {
      method: "POST",
    });
    if (response.status === 409) {
      continue;
    }
    return response;
  }

  throw new Error("Could not allocate a room code");
}

async function joinRoom(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ code?: string; token?: string | null }>(request);
  const code = String(body.code || "").trim();
  if (!/^\d{6}$/.test(code)) {
    return json({ error: "Room code must be 6 digits" }, 400);
  }

  return roomStub(env, code).fetch("https://room/join", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ token: body.token ?? null }),
  });
}

async function proxyRoomRequest(request: Request, env: Env, code: string, path: string): Promise<Response> {
  return roomStub(env, code).fetch(new Request(`https://room${path}`, request));
}

async function handleLocalStart(): Promise<Response> {
  return json(buildLocalState(EMPTY_GAME_JSON));
}

async function handleLocalMove(request: Request): Promise<Response> {
  const body = await readJson<{ gameJson?: string; stones?: Cube[] }>(request);
  if (typeof body.gameJson !== "string") {
    return json({ error: "Missing local game state" }, 400);
  }
  if (!Array.isArray(body.stones) || body.stones.length !== 2) {
    return json({ error: "A turn must contain exactly 2 stones" }, 400);
  }

  const snapshot = callPlay(body.gameJson, body.stones);
  return json(buildStateFromSnapshot(snapshot, {
    mode: "local",
    code: null,
    seat: "local",
    yourTurn: !snapshot.winner,
  }));
}

export class RoomObject extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const room = await this.ctx.storage.get<RoomData>("room");

      if (request.method === "POST" && url.pathname === "/internal/init") {
        if (room) {
          return json({ error: "Room already exists" }, 409);
        }

        const code = String(this.ctx.id.name || "").trim();
        const token = createToken();
        const nextRoom: RoomData = {
          code,
          turnsJson: EMPTY_GAME_JSON,
          seats: {
            one: null,
            two: token,
          },
        };
        await this.ctx.storage.put("room", nextRoom);
        return json({
          code,
          token,
          room: buildRoomState(nextRoom, "two"),
        });
      }

      if (!room) {
        return json({ error: "Room not found" }, 404);
      }

      if (request.method === "POST" && url.pathname === "/join") {
        const body = await readJson<{ token?: string | null }>(request);
        const incomingToken = body.token ?? null;
        const existingSeat = getSeatForToken(room, incomingToken);
        if (existingSeat !== "spectator" && incomingToken) {
          return json({
            code: room.code,
            token: incomingToken,
            room: buildRoomState(room, existingSeat),
          });
        }

        const token = createToken();
        let seat: Seat = "spectator";
        if (!room.seats.one) {
          room.seats.one = token;
          seat = "one";
          await this.ctx.storage.put("room", room);
        } else if (!room.seats.two) {
          room.seats.two = token;
          seat = "two";
          await this.ctx.storage.put("room", room);
        }

        return json({
          code: room.code,
          token,
          room: buildRoomState(room, seat),
        });
      }

      if (request.method === "GET" && url.pathname === "/state") {
        const seat = getSeatForToken(room, url.searchParams.get("token"));
        return json(buildRoomState(room, seat));
      }

      if (request.method === "POST" && url.pathname === "/move") {
        const body = await readJson<{ token?: string | null; stones?: Cube[] }>(request);
        const seat = getSeatForToken(room, body.token ?? null);
        const player = playerForSeat(seat);
        if (!player) {
          return json({ error: "You are not seated in this room" }, 403);
        }

        const snapshot = callSnapshot(room.turnsJson);
        if (snapshot.winner) {
          return json({ error: "Game is already over" }, 400);
        }
        if (snapshot.current_player !== player) {
          return json({ error: "It is not your turn" }, 400);
        }
        if (!Array.isArray(body.stones) || body.stones.length !== 2) {
          return json({ error: "A turn must contain exactly 2 stones" }, 400);
        }

        const nextSnapshot = callPlay(room.turnsJson, body.stones);
        room.turnsJson = nextSnapshot.turns_json;
        await this.ctx.storage.put("room", room);
        return json(buildRoomState(room, seat));
      }

      return json({ error: "Not found" }, 404);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Unknown error" }, 400);
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      const pathname = url.pathname;

      if (request.method === "POST" && pathname === "/api/local/start") {
        return handleLocalStart();
      }

      if (request.method === "POST" && pathname === "/api/local/move") {
        return handleLocalMove(request);
      }

      if (request.method === "POST" && pathname === "/api/rooms/create") {
        return createRoom(env);
      }

      if (request.method === "POST" && pathname === "/api/rooms/join") {
        return joinRoom(request, env);
      }

      const stateMatch = pathname.match(/^\/api\/rooms\/(\d{6})\/state$/);
      if (request.method === "GET" && stateMatch) {
        const proxyUrl = new URL("https://room/state");
        proxyUrl.search = url.search;
        return roomStub(env, stateMatch[1]).fetch(proxyUrl.toString());
      }

      const moveMatch = pathname.match(/^\/api\/rooms\/(\d{6})\/move$/);
      if (request.method === "POST" && moveMatch) {
        return proxyRoomRequest(request, env, moveMatch[1], "/move");
      }

      return env.ASSETS.fetch(request);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Unknown error" }, 400);
    }
  },
} satisfies ExportedHandler<Env>;
