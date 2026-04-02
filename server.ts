declare const require: any;
declare const __dirname: string;
declare const process: any;

(() => {

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const nodeCrypto = require("node:crypto");
const childProcess = require("node:child_process");

type Seat = "one" | "two" | "spectator";
type Player = "One" | "Two";

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

type Room = {
  code: string;
  turnsJson: string;
  seats: {
    one: string | null;
    two: string | null;
  };
};

type RoomState = {
  code: string;
  seat: Seat;
  currentPlayer: Player;
  winner: Player | null;
  yourTurn: boolean;
  turns: number;
  stones: Stone[];
};

const rooms = new Map<string, Room>();
const PORT = Number(process.env.PORT || 3000);
const ENGINE_BIN = path.join(
  __dirname,
  "engine",
  "target",
  "debug",
  process.platform === "win32" ? "hex-tic-tac-engine.exe" : "hex-tic-tac-engine",
);

function json(response: any, statusCode: number, data: unknown): void {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(data));
}

function sendFile(response: any, filePath: string): void {
  const extension = path.extname(filePath);
  const contentType =
    extension === ".html"
      ? "text/html; charset=utf-8"
      : extension === ".css"
        ? "text/css; charset=utf-8"
        : extension === ".js"
          ? "text/javascript; charset=utf-8"
          : "text/plain; charset=utf-8";

  fs.readFile(filePath, (error: Error | null, data: any) => {
    if (error) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    response.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
    });
    response.end(data);
  });
}

function readBody(request: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: any[] = [];
    request.on("data", (chunk: any) => chunks.push(chunk));
    request.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse((globalThis as any).Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    request.on("error", reject);
  });
}

function ensureEngineBuilt(): void {
  const result = childProcess.spawnSync(
    "cargo",
    ["build", "--manifest-path", path.join(__dirname, "engine", "Cargo.toml"), "--bin", "hex-tic-tac-engine"],
    { stdio: "inherit" },
  );
  if (result.status !== 0) {
    throw new Error("Could not build Rust engine bridge");
  }
}

function callEngine(payload: unknown): EngineSnapshot {
  const result = childProcess.spawnSync(ENGINE_BIN, [], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });

  if (result.status !== 0) {
    const stderr = String(result.stderr || "Engine request failed").trim();
    throw new Error(stderr || "Engine request failed");
  }

  return JSON.parse(String(result.stdout)) as EngineSnapshot;
}

function generateCode(): string {
  let code = "000000";
  do {
    code = String(nodeCrypto.randomInt(0, 1_000_000)).padStart(6, "0");
  } while (rooms.has(code));
  return code;
}

function createToken(): string {
  return nodeCrypto.randomBytes(16).toString("hex");
}

function getSeatForToken(room: Room, token: string | null): Seat {
  if (!token) return "spectator";
  if (room.seats.one === token) return "one";
  if (room.seats.two === token) return "two";
  return "spectator";
}

function playerForSeat(seat: Seat): Player | null {
  if (seat === "one") return "One";
  if (seat === "two") return "Two";
  return null;
}

function buildRoomState(room: Room, seat: Seat): RoomState {
  const snapshot = callEngine({ command: "snapshot", game_json: room.turnsJson });
  return {
    code: room.code,
    seat,
    currentPlayer: snapshot.current_player,
    winner: snapshot.winner,
    yourTurn: Boolean(playerForSeat(seat) && playerForSeat(seat) === snapshot.current_player && !snapshot.winner),
    turns: snapshot.turn_count,
    stones: snapshot.stones,
  };
}

function requireRoom(code: string): Room {
  const room = rooms.get(code);
  if (!room) {
    throw new Error("Room not found");
  }
  return room;
}

function assignJoinSeat(room: Room, token: string | null): { seat: Seat; token: string } {
  const existingSeat = getSeatForToken(room, token);
  if (existingSeat !== "spectator" && token) {
    return { seat: existingSeat, token };
  }

  const newToken = createToken();
  if (!room.seats.one) {
    room.seats.one = newToken;
    return { seat: "one", token: newToken };
  }
  if (!room.seats.two) {
    room.seats.two = newToken;
    return { seat: "two", token: newToken };
  }
  return { seat: "spectator", token: newToken };
}

const server = http.createServer(async (request: any, response: any) => {
  try {
    const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    const pathname = requestUrl.pathname;

    if (request.method === "GET" && pathname === "/") {
      sendFile(response, path.join(__dirname, "index.html"));
      return;
    }

    if (request.method === "GET" && pathname === "/styles.css") {
      sendFile(response, path.join(__dirname, "styles.css"));
      return;
    }

    if (request.method === "GET" && pathname === "/client.js") {
      sendFile(response, path.join(__dirname, "client.js"));
      return;
    }

    if (request.method === "POST" && pathname === "/api/rooms/create") {
      const code = generateCode();
      const token = createToken();
      const room: Room = {
        code,
        turnsJson: '{"turns":[]}',
        seats: {
          one: null,
          two: token,
        },
      };
      rooms.set(code, room);
      json(response, 200, {
        code,
        token,
        room: buildRoomState(room, "two"),
      });
      return;
    }

    if (request.method === "POST" && pathname === "/api/rooms/join") {
      const body = (await readBody(request)) as { code?: string; token?: string | null };
      const code = String(body.code || "").trim();
      if (!/^\d{6}$/.test(code)) {
        json(response, 400, { error: "Room code must be 6 digits" });
        return;
      }
      const room = requireRoom(code);
      const { seat, token } = assignJoinSeat(room, body.token ?? null);
      json(response, 200, {
        code,
        token,
        room: buildRoomState(room, seat),
      });
      return;
    }

    const stateMatch = pathname.match(/^\/api\/rooms\/(\d{6})\/state$/);
    if (request.method === "GET" && stateMatch) {
      const room = requireRoom(stateMatch[1]);
      const token = requestUrl.searchParams.get("token");
      const seat = getSeatForToken(room, token);
      json(response, 200, buildRoomState(room, seat));
      return;
    }

    const moveMatch = pathname.match(/^\/api\/rooms\/(\d{6})\/move$/);
    if (request.method === "POST" && moveMatch) {
      const room = requireRoom(moveMatch[1]);
      const body = (await readBody(request)) as { token?: string; stones?: Cube[] };
      const seat = getSeatForToken(room, body.token ?? null);
      const player = playerForSeat(seat);
      if (!player) {
        json(response, 403, { error: "You are not seated in this room" });
        return;
      }

      const snapshot = callEngine({ command: "snapshot", game_json: room.turnsJson });
      if (snapshot.winner) {
        json(response, 400, { error: "Game is already over" });
        return;
      }
      if (snapshot.current_player !== player) {
        json(response, 400, { error: "It is not your turn" });
        return;
      }
      if (!Array.isArray(body.stones) || body.stones.length !== 2) {
        json(response, 400, { error: "A turn must contain exactly 2 stones" });
        return;
      }

      const nextSnapshot = callEngine({
        command: "play",
        game_json: room.turnsJson,
        stones: body.stones,
      });
      room.turnsJson = nextSnapshot.turns_json;
      json(response, 200, {
        code: room.code,
        seat,
        currentPlayer: nextSnapshot.current_player,
        winner: nextSnapshot.winner,
        yourTurn: Boolean(playerForSeat(seat) && playerForSeat(seat) === nextSnapshot.current_player && !nextSnapshot.winner),
        turns: nextSnapshot.turn_count,
        stones: nextSnapshot.stones,
      });
      return;
    }

    json(response, 404, { error: "Not found" });
  } catch (error) {
    json(response, 400, { error: error instanceof Error ? error.message : "Unknown error" });
  }
});

ensureEngineBuilt();
server.listen(PORT, () => {
  console.log(`Six Tac listening on http://localhost:${PORT}`);
});

})();
