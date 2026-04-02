import initLocalEngine, { play_json as localPlayJson, snapshot_json as localSnapshotJson } from "./local-engine/engine.js";

void (async () => {
await initLocalEngine();

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

type Session = {
  code: string;
  token: string;
};

const canvas = document.getElementById("board") as HTMLCanvasElement;
const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
const lobbyEl = document.getElementById("lobby") as HTMLDivElement;
const lobbyErrorEl = document.getElementById("lobby-error") as HTMLDivElement;
const localModeButton = document.getElementById("local-mode-button") as HTMLButtonElement;
const createRoomButton = document.getElementById("create-room-button") as HTMLButtonElement;
const joinRoomButton = document.getElementById("join-room-button") as HTMLButtonElement;
const joinCodeInput = document.getElementById("join-code-input") as HTMLInputElement;
const bottomBarEl = document.getElementById("bottom-bar") as HTMLDivElement;
const roomCodePill = document.getElementById("room-code-pill") as HTMLSpanElement;
const copyRoomButton = document.getElementById("copy-room-button") as HTMLButtonElement;
const turnPill = document.getElementById("turn-pill") as HTMLSpanElement;
const leaveRoomButton = document.getElementById("leave-room-button") as HTMLButtonElement;
const submitTurnButton = document.getElementById("submit-turn-button") as HTMLButtonElement;
const submitLabel = document.getElementById("submit-label") as HTMLSpanElement;

const SQRT3 = Math.sqrt(3);
const TAP_SLOP = 8;
const SESSION_KEY = "six-tac-session";
const LOCAL_GAME_KEY = "six-tac-local-game";
const POLL_INTERVAL_MS = 1200;
const ROOM_QUERY_PARAM = "room";
const EMPTY_GAME_JSON = '{"turns":[]}';

const state = {
  hexSize: 34,
  camera: {
    x: window.innerWidth / 2,
    y: window.innerHeight / 2,
    scale: 1,
  },
  hovered: null as Cube | null,
  selected: [] as Cube[],
  room: null as RoomState | null,
  session: null as Session | null,
  pointer: null as
    | {
        id: number;
        startX: number;
        startY: number;
        lastX: number;
        lastY: number;
        dragging: boolean;
      }
    | null,
  touchPoints: new Map<number, { x: number; y: number }>(),
  pinchGesture: null as null | {
    distance: number;
    midpointX: number;
    midpointY: number;
  },
  multiTouchGesture: false,
  pollTimer: 0 as number,
  rafPending: false,
  pendingSubmit: false,
  recentHighlights: [] as Cube[],
};

function cubeKey(cube: Cube): string {
  return `${cube.x},${cube.y},${cube.z}`;
}

function hexToPixel(cube: Cube, size = state.hexSize): { x: number; y: number } {
  return {
    x: size * SQRT3 * (cube.x + cube.z / 2),
    y: size * 1.5 * cube.z,
  };
}

function pixelToFractionalCube(x: number, y: number, size = state.hexSize): Cube {
  const q = ((SQRT3 / 3) * x - y / 3) / size;
  const r = ((2 / 3) * y) / size;
  const s = -q - r;
  return { x: q, y: s, z: r };
}

function cubeRound(cube: Cube): Cube {
  let rx = Math.round(cube.x);
  let ry = Math.round(cube.y);
  let rz = Math.round(cube.z);

  const xDiff = Math.abs(rx - cube.x);
  const yDiff = Math.abs(ry - cube.y);
  const zDiff = Math.abs(rz - cube.z);

  if (xDiff > yDiff && xDiff > zDiff) {
    rx = -ry - rz;
  } else if (yDiff > zDiff) {
    ry = -rx - rz;
  } else {
    rz = -rx - ry;
  }

  return { x: rx, y: ry, z: rz };
}

function worldToScreen(x: number, y: number): { x: number; y: number } {
  return {
    x: x * state.camera.scale + state.camera.x,
    y: y * state.camera.scale + state.camera.y,
  };
}

function screenToWorld(x: number, y: number): { x: number; y: number } {
  return {
    x: (x - state.camera.x) / state.camera.scale,
    y: (y - state.camera.y) / state.camera.scale,
  };
}

function screenToCube(x: number, y: number): Cube {
  const world = screenToWorld(x, y);
  return cubeRound(pixelToFractionalCube(world.x, world.y));
}

function resizeCanvas(): void {
  const dpr = window.devicePixelRatio || 1;
  const width = window.innerWidth;
  const height = window.innerHeight;

  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  requestRender();
}

function getVisibleRange(): { minQ: number; maxQ: number; minR: number; maxR: number } {
  const corners = [
    screenToWorld(0, 0),
    screenToWorld(window.innerWidth, 0),
    screenToWorld(0, window.innerHeight),
    screenToWorld(window.innerWidth, window.innerHeight),
  ];

  const cubes = corners.map((point) => pixelToFractionalCube(point.x, point.y));
  const qs = cubes.map((cube) => cube.x);
  const rs = cubes.map((cube) => cube.z);

  return {
    minQ: Math.floor(Math.min(...qs)) - 3,
    maxQ: Math.ceil(Math.max(...qs)) + 3,
    minR: Math.floor(Math.min(...rs)) - 3,
    maxR: Math.ceil(Math.max(...rs)) + 3,
  };
}

function requestRender(): void {
  if (state.rafPending) return;
  state.rafPending = true;
  requestAnimationFrame(render);
}

function traceHex(centerX: number, centerY: number, radius: number): void {
  ctx.beginPath();
  for (let i = 0; i < 6; i += 1) {
    const angle = ((60 * i - 30) * Math.PI) / 180;
    const x = centerX + radius * Math.cos(angle);
    const y = centerY + radius * Math.sin(angle);
    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.closePath();
}

function drawRecentOutline(centerX: number, centerY: number, radius: number): void {
  traceHex(centerX, centerY, radius);
  ctx.lineWidth = Math.max(2.2, 3 * state.camera.scale);
  ctx.strokeStyle = "rgba(15, 23, 42, 0.96)";
  ctx.stroke();

  ctx.save();
  traceHex(centerX, centerY, radius);
  ctx.lineWidth = Math.max(1.6, 2.2 * state.camera.scale);
  ctx.setLineDash([10 * state.camera.scale, 8 * state.camera.scale]);
  ctx.lineDashOffset = 2;
  ctx.strokeStyle = "rgba(250, 204, 21, 0.98)";
  ctx.stroke();
  ctx.restore();
}

function render(): void {
  state.rafPending = false;
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

  const occupied = new Map<string, Stone>();
  for (const stone of state.room?.stones ?? []) {
    occupied.set(cubeKey(stone), stone);
  }

  const selected = new Set(state.selected.map(cubeKey));
  const recentHighlights = new Set(state.recentHighlights.map(cubeKey));
  const range = getVisibleRange();
  const hexRadius = state.hexSize * state.camera.scale;

  for (let q = range.minQ; q <= range.maxQ; q += 1) {
    for (let r = range.minR; r <= range.maxR; r += 1) {
      const cube = { x: q, y: -q - r, z: r };
      const point = hexToPixel(cube);
      const screen = worldToScreen(point.x, point.y);

      if (
        screen.x < -hexRadius * 2 ||
        screen.x > window.innerWidth + hexRadius * 2 ||
        screen.y < -hexRadius * 2 ||
        screen.y > window.innerHeight + hexRadius * 2
      ) {
        continue;
      }

      const stone = occupied.get(cubeKey(cube));
      const isHovered = sameCube(state.hovered, cube);
      const isSelected = selected.has(cubeKey(cube));
      const isRecent = recentHighlights.has(cubeKey(cube));
      const isInRange = stone ? true : isWithinPlacementRange(cube);

      let fill = "rgba(148, 163, 184, 0.06)";
      let stroke = "rgba(148, 163, 184, 0.26)";
      let lineWidth = Math.max(1, 1.4 * state.camera.scale);

      if (stone?.player === "One") {
        fill = "rgba(239, 68, 68, 0.72)";
        stroke = "rgba(254, 202, 202, 0.95)";
        lineWidth = Math.max(1.2, 1.8 * state.camera.scale);
      } else if (stone?.player === "Two") {
        fill = "rgba(59, 130, 246, 0.72)";
        stroke = "rgba(191, 219, 254, 0.95)";
        lineWidth = Math.max(1.2, 1.8 * state.camera.scale);
      } else if (isSelected) {
        const previewColor = seatColor(state.room?.seat ?? "spectator");
        fill = previewColor.fill;
        stroke = previewColor.stroke;
        lineWidth = Math.max(1.2, 1.8 * state.camera.scale);
      } else if (!isInRange) {
        fill = "rgba(148, 163, 184, 0.025)";
        stroke = "rgba(107, 114, 128, 0.24)";
      }

      if (isHovered) {
        if (!stone && !isSelected) {
          fill = "rgba(99, 102, 241, 0.18)";
        }
        stroke = "rgba(255, 255, 255, 0.92)";
        lineWidth = Math.max(lineWidth, Math.max(1.8, 2.4 * state.camera.scale));
      }

      drawHex(screen.x, screen.y, hexRadius, fill, stroke, lineWidth);

      if (isRecent) {
        drawRecentOutline(screen.x, screen.y, hexRadius);
      }
    }
  }
}

function drawHex(
  centerX: number,
  centerY: number,
  radius: number,
  fillStyle: string,
  strokeStyle: string,
  lineWidth: number,
): void {
  traceHex(centerX, centerY, radius);
  ctx.fillStyle = fillStyle;
  ctx.fill();
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = strokeStyle;
  ctx.stroke();
}

function cubeDistance(a: Cube, b: Cube): number {
  return (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z)) / 2;
}

function isWithinPlacementRange(cube: Cube): boolean {
  const stones = state.room?.stones ?? [];
  return stones.some((stone) => cubeDistance(stone, cube) <= 8);
}

function seatColor(seat: Seat): { fill: string; stroke: string } {
  if (seat === "one") {
    return {
      fill: "rgba(239, 68, 68, 0.28)",
      stroke: "rgba(254, 202, 202, 0.95)",
    };
  }
  if (seat === "two") {
    return {
      fill: "rgba(59, 130, 246, 0.28)",
      stroke: "rgba(191, 219, 254, 0.95)",
    };
  }
  return {
    fill: "rgba(148, 163, 184, 0.2)",
    stroke: "rgba(226, 232, 240, 0.8)",
  };
}

function sameCube(a: Cube | null, b: Cube | null): boolean {
  return Boolean(a && b && a.x === b.x && a.y === b.y && a.z === b.z);
}

function updateHovered(clientX: number, clientY: number): void {
  state.hovered = screenToCube(clientX, clientY);
}

function zoomAt(screenX: number, screenY: number, factor: number): void {
  const worldBefore = screenToWorld(screenX, screenY);
  state.camera.scale *= factor;
  state.camera.x = screenX - worldBefore.x * state.camera.scale;
  state.camera.y = screenY - worldBefore.y * state.camera.scale;
}

function getTouchGesture(): { midpointX: number; midpointY: number; distance: number } | null {
  if (state.touchPoints.size < 2) return null;
  const [first, second] = Array.from(state.touchPoints.values());
  const dx = second.x - first.x;
  const dy = second.y - first.y;
  return {
    midpointX: (first.x + second.x) / 2,
    midpointY: (first.y + second.y) / 2,
    distance: Math.hypot(dx, dy),
  };
}

function setLobbyError(message: string): void {
  lobbyErrorEl.textContent = message;
}

function callLocalSnapshot(gameJson: string): EngineSnapshot {
  return JSON.parse(localSnapshotJson(gameJson)) as EngineSnapshot;
}

function callLocalPlay(gameJson: string, stones: Cube[]): EngineSnapshot {
  return JSON.parse(localPlayJson(gameJson, JSON.stringify(stones))) as EngineSnapshot;
}

function buildLocalState(gameJson: string): RoomState {
  const snapshot = callLocalSnapshot(gameJson);
  const parsed = JSON.parse(snapshot.turns_json) as { turns?: Array<{ stones?: Cube[] }> };
  const turns = parsed.turns ?? [];
  const lastTurn = turns.length === 0
    ? { lastTurnPlayer: null as Player | null, lastTurnStones: [] as Cube[] }
    : {
        lastTurnPlayer: (turns.length - 1) % 2 === 0 ? "Two" as Player : "One" as Player,
        lastTurnStones: turns[turns.length - 1].stones ?? [],
      };

  return {
    mode: "local",
    code: null,
    seat: "local",
    currentPlayer: snapshot.current_player,
    winner: snapshot.winner,
    yourTurn: !snapshot.winner,
    turns: snapshot.turn_count,
    stones: snapshot.stones,
    lastTurnPlayer: lastTurn.lastTurnPlayer,
    lastTurnStones: lastTurn.lastTurnStones,
    gameJson: snapshot.turns_json,
  };
}

function saveLocalGame(gameJson: string | null): void {
  if (!gameJson) {
    localStorage.removeItem(LOCAL_GAME_KEY);
    return;
  }
  localStorage.setItem(LOCAL_GAME_KEY, gameJson);
}

function loadLocalGame(): string | null {
  const raw = localStorage.getItem(LOCAL_GAME_KEY);
  return raw && raw.trim() ? raw : null;
}

function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator)) {
    return;
  }
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch(() => {
      // Offline local mode still works for the current tab if the app is already loaded.
    });
  });
}

function updateRoomUrl(code: string | null): void {
  const url = new URL(window.location.href);
  if (code) {
    url.searchParams.set(ROOM_QUERY_PARAM, code);
  } else {
    url.searchParams.delete(ROOM_QUERY_PARAM);
  }
  window.history.replaceState({}, "", url);
}

function saveSession(session: Session | null): void {
  state.session = session;
  if (!session) {
    localStorage.removeItem(SESSION_KEY);
    updateRoomUrl(null);
    return;
  }
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  updateRoomUrl(session.code);
}

function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Session;
    if (!parsed.code || !parsed.token) return null;
    return parsed;
  } catch {
    return null;
  }
}

function loadRoomCodeFromUrl(): string {
  return new URL(window.location.href).searchParams.get(ROOM_QUERY_PARAM)?.replace(/\D+/g, "").slice(0, 6) ?? "";
}

async function requestJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
    },
    ...options,
  });

  const data = (await response.json()) as { error?: string } & T;
  if (!response.ok) {
    throw new Error(data.error || "Request failed");
  }
  return data as T;
}

async function startLocalGame(): Promise<void> {
  setLobbyError("");
  saveSession(null);
  const savedGameJson = loadLocalGame();
  if (!savedGameJson) {
    applyRoom(buildLocalState(EMPTY_GAME_JSON));
    return;
  }

  const savedRoom = buildLocalState(savedGameJson);
  if (savedRoom.winner) {
    saveLocalGame(null);
    applyRoom(buildLocalState(EMPTY_GAME_JSON));
    return;
  }

  applyRoom(savedRoom);
}

async function createRoom(): Promise<void> {
  setLobbyError("");
  const result = await requestJson<{ code: string; token: string; room: RoomState }>("/api/rooms/create", {
    method: "POST",
    body: JSON.stringify({}),
  });
  saveSession({ code: result.code, token: result.token });
  applyRoom(result.room);
}

async function joinRoom(code: string): Promise<void> {
  setLobbyError("");
  const result = await requestJson<{ code: string; token: string; room: RoomState }>("/api/rooms/join", {
    method: "POST",
    body: JSON.stringify({ code, token: state.session?.token ?? null }),
  });
  saveSession({ code: result.code, token: result.token });
  applyRoom(result.room);
}

async function loadRoomState(): Promise<void> {
  if (!state.session) return;
  const room = await requestJson<RoomState>(
    `/api/rooms/${state.session.code}/state?token=${encodeURIComponent(state.session.token)}`,
  );
  applyRoom(room);
}

async function submitTurn(): Promise<void> {
  if (!state.room || state.selected.length !== 2 || state.pendingSubmit) {
    return;
  }

  state.pendingSubmit = true;
  updateControls();

  try {
    const room = state.room.mode === "local"
      ? buildLocalState(callLocalPlay(state.room.gameJson, state.selected).turns_json)
      : await requestJson<RoomState>(`/api/rooms/${state.session?.code}/move`, {
          method: "POST",
          body: JSON.stringify({
            token: state.session?.token,
            stones: state.selected,
          }),
        });
    state.selected = [];
    applyRoom(room);
  } catch (error) {
    turnPill.textContent = error instanceof Error ? error.message : "Could not play turn";
  } finally {
    state.pendingSubmit = false;
    updateControls();
    requestRender();
  }
}

function formatRoomCode(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3, 6)}`;
}

function seatPlayer(seat: Seat): Player | null {
  return seat === "one" ? "One" : seat === "two" ? "Two" : null;
}

function currentControllingPlayer(room: RoomState): Player | null {
  if (room.mode === "local") return room.currentPlayer;
  return seatPlayer(room.seat);
}

function centerOnCubes(cubes: Cube[]): void {
  if (cubes.length === 0) return;
  let sumX = 0;
  let sumY = 0;
  for (const cube of cubes) {
    const point = hexToPixel(cube);
    sumX += point.x;
    sumY += point.y;
  }
  const avgX = sumX / cubes.length;
  const avgY = sumY / cubes.length;
  state.camera.x = window.innerWidth / 2 - avgX * state.camera.scale;
  state.camera.y = window.innerHeight / 2 - avgY * state.camera.scale;
}

function cubesAreVisible(cubes: Cube[]): boolean {
  const margin = 100;
  return cubes.every((cube) => {
    const point = hexToPixel(cube);
    const screen = worldToScreen(point.x, point.y);
    return (
      screen.x >= margin &&
      screen.x <= window.innerWidth - margin &&
      screen.y >= margin &&
      screen.y <= window.innerHeight - margin
    );
  });
}

function applyRoom(room: RoomState): void {
  const previousRoom = state.room;
  const previousTurns = previousRoom?.turns ?? 0;
  const controllingPlayer = currentControllingPlayer(room);
  const shouldHighlightRecent = room.mode === "local"
    ? room.lastTurnStones.length > 0
    : Boolean(room.lastTurnPlayer && room.lastTurnPlayer !== controllingPlayer && room.lastTurnStones.length > 0);

  state.room = room;
  if (room.mode === "local") {
    saveLocalGame(room.gameJson);
  }
  lobbyEl.classList.add("hidden");
  bottomBarEl.classList.remove("hidden");

  if (!room.yourTurn || room.winner) {
    state.selected = [];
  } else {
    state.selected = state.selected.filter((selectedCube) => {
      return !room.stones.some((stone) => sameCube(stone, selectedCube));
    });
  }

  state.recentHighlights = shouldHighlightRecent ? room.lastTurnStones.slice() : [];
  roomCodePill.textContent = room.mode === "local" ? "local" : formatRoomCode(room.code ?? "");
  copyRoomButton.dataset.player = room.currentPlayer;
  copyRoomButton.classList.toggle("hidden", room.mode === "local");

  if (room.turns > previousTurns && shouldHighlightRecent && !cubesAreVisible(room.lastTurnStones)) {
    centerOnCubes(room.lastTurnStones);
  }

  updateControls();
  requestRender();
}

function updateControls(): void {
  const room = state.room;
  if (!room) {
    bottomBarEl.classList.add("hidden");
    return;
  }

  bottomBarEl.classList.remove("hidden");
  const canPlay = room.mode === "local"
    ? !room.winner
    : room.yourTurn && !room.winner && (room.seat === "one" || room.seat === "two");

  if (room.winner) {
    turnPill.textContent = room.winner === "One" ? "red won" : "blue won";
  } else {
    turnPill.textContent = room.currentPlayer === "One" ? "red to move" : "blue to move";
  }

  submitLabel.textContent = state.pendingSubmit ? "Playing" : "Play";
  submitTurnButton.disabled = !canPlay || state.selected.length !== 2 || state.pendingSubmit;
}

function startPolling(): void {
  stopPolling();
  state.pollTimer = window.setInterval(() => {
    loadRoomState().catch((error) => {
      turnPill.textContent = error instanceof Error ? error.message : "Connection lost";
    });
  }, POLL_INTERVAL_MS);
}

function stopPolling(): void {
  if (state.pollTimer) {
    window.clearInterval(state.pollTimer);
    state.pollTimer = 0;
  }
}

function showLobby(message: string, roomCode = ""): void {
  state.room = null;
  state.selected = [];
  state.recentHighlights = [];
  copyRoomButton.dataset.player = "";
  lobbyEl.classList.remove("hidden");
  bottomBarEl.classList.add("hidden");
  setLobbyError(message);
  joinCodeInput.value = roomCode;
  requestRender();
}

function leaveRoom(): void {
  if (!state.room) return;
  const confirmed = window.confirm(
    state.room.mode === "local"
      ? "Leave this local game? It will stay saved on this device so you can resume offline later."
      : "Leave this room? You can rejoin later from this browser.",
  );
  if (!confirmed) {
    return;
  }

  stopPolling();
  if (state.room.mode === "online") {
    saveSession(null);
  }
  showLobby("");
}

function toggleSelected(cube: Cube): void {
  const existingIndex = state.selected.findIndex((selectedCube) => sameCube(selectedCube, cube));
  if (existingIndex >= 0) {
    state.selected.splice(existingIndex, 1);
  } else if (state.selected.length < 2) {
    state.selected.push(cube);
  }
  updateControls();
  requestRender();
}

function isPlayableCell(cube: Cube): boolean {
  if (!state.room || state.room.winner) return false;
  if (state.room.mode !== "local" && !state.room.yourTurn) return false;
  if (state.room.seat === "spectator") return false;
  if (state.room.stones.some((stone) => sameCube(stone, cube))) return false;
  return isWithinPlacementRange(cube);
}

canvas.addEventListener("pointerdown", (event) => {
  canvas.setPointerCapture(event.pointerId);
  updateHovered(event.clientX, event.clientY);

  if (event.pointerType === "touch") {
    state.touchPoints.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (state.touchPoints.size >= 2) {
      state.multiTouchGesture = true;
      state.pointer = null;
      state.pinchGesture = getTouchGesture();
      canvas.classList.add("dragging");
      requestRender();
      return;
    }
  }

  state.pointer = {
    id: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    lastX: event.clientX,
    lastY: event.clientY,
    dragging: false,
  };
  canvas.classList.add("dragging");
  requestRender();
});

canvas.addEventListener("pointermove", (event) => {
  updateHovered(event.clientX, event.clientY);

  if (event.pointerType === "touch" && state.touchPoints.has(event.pointerId)) {
    state.touchPoints.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (state.touchPoints.size >= 2) {
      const gesture = getTouchGesture();
      if (gesture && state.pinchGesture) {
        state.camera.x += gesture.midpointX - state.pinchGesture.midpointX;
        state.camera.y += gesture.midpointY - state.pinchGesture.midpointY;
        if (state.pinchGesture.distance > 0 && gesture.distance > 0) {
          zoomAt(gesture.midpointX, gesture.midpointY, gesture.distance / state.pinchGesture.distance);
        }
      }
      state.multiTouchGesture = true;
      state.pinchGesture = gesture;
      requestRender();
      return;
    }
  }

  if (!state.pointer || state.pointer.id !== event.pointerId) {
    requestRender();
    return;
  }

  const totalDx = event.clientX - state.pointer.startX;
  const totalDy = event.clientY - state.pointer.startY;
  if (!state.pointer.dragging && Math.hypot(totalDx, totalDy) > TAP_SLOP) {
    state.pointer.dragging = true;
  }

  if (state.pointer.dragging) {
    state.camera.x += event.clientX - state.pointer.lastX;
    state.camera.y += event.clientY - state.pointer.lastY;
  }

  state.pointer.lastX = event.clientX;
  state.pointer.lastY = event.clientY;
  requestRender();
});

function finishPointer(event: PointerEvent): void {
  if (event.pointerType === "touch") {
    state.touchPoints.delete(event.pointerId);
    if (state.touchPoints.size < 2) {
      state.pinchGesture = null;
      state.multiTouchGesture = false;
    }
  }

  if (!state.pointer || state.pointer.id !== event.pointerId) {
    if (state.touchPoints.size === 0) {
      canvas.classList.remove("dragging");
    }
    requestRender();
    return;
  }

  updateHovered(event.clientX, event.clientY);

  if (!state.multiTouchGesture && !state.pointer.dragging && state.hovered && isPlayableCell(state.hovered)) {
    toggleSelected(state.hovered);
  }

  if (state.touchPoints.size === 0) {
    canvas.classList.remove("dragging");
  }
  state.pointer = null;
  requestRender();
}

canvas.addEventListener("pointerup", finishPointer);
canvas.addEventListener("pointercancel", finishPointer);
canvas.addEventListener("pointerleave", () => {
  if (!state.pointer) {
    state.hovered = null;
    requestRender();
  }
});

canvas.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    let scale = 1;
    if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) scale = 16;
    if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) scale = window.innerHeight;

    if (event.ctrlKey || event.metaKey) {
      const factor = Math.exp((-event.deltaY * scale) / 1200);
      zoomAt(event.clientX, event.clientY, factor);
    } else {
      state.camera.x -= event.deltaX * scale;
      state.camera.y -= event.deltaY * scale;
    }

    updateHovered(event.clientX, event.clientY);
    requestRender();
  },
  { passive: false },
);

localModeButton.addEventListener("click", () => {
  startLocalGame().catch((error) => {
    setLobbyError(error instanceof Error ? error.message : "Could not start local game.");
  });
});

createRoomButton.addEventListener("click", () => {
  createRoom().then(startPolling).catch((error) => {
    setLobbyError(error instanceof Error ? error.message : "Could not create room.");
  });
});

joinRoomButton.addEventListener("click", () => {
  const code = joinCodeInput.value.trim();
  joinRoom(code).then(startPolling).catch((error) => {
    setLobbyError(error instanceof Error ? error.message : "Could not join room.");
  });
});

joinCodeInput.addEventListener("input", () => {
  joinCodeInput.value = joinCodeInput.value.replace(/\D+/g, "").slice(0, 6);
});

joinCodeInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    joinRoomButton.click();
  }
});

leaveRoomButton.addEventListener("click", leaveRoom);
submitTurnButton.addEventListener("click", () => {
  submitTurn().catch((error) => {
    turnPill.textContent = error instanceof Error ? error.message : "Could not play turn";
  });
});

copyRoomButton.addEventListener("click", async () => {
  if (!state.room || !state.room.code) return;
  try {
    await navigator.clipboard.writeText(state.room.code);
    turnPill.textContent = "code copied";
  } catch {
    turnPill.textContent = state.room.code;
  }
});

window.addEventListener("resize", resizeCanvas);
window.addEventListener("online", () => {
  if (!state.session) return;
  loadRoomState().catch(() => {
    // keep the saved session so the player can retry automatically or manually
  });
});
window.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.session) {
    loadRoomState().catch(() => {
      // keep the saved session so the player can retry automatically or manually
    });
  }
});
window.addEventListener("keydown", (event) => {
  if (event.key === "+" || event.key === "=") {
    zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1.12);
    requestRender();
  } else if (event.key === "-") {
    zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1 / 1.12);
    requestRender();
  }
});

async function restoreSession(): Promise<void> {
  const session = loadSession();
  const roomCodeFromUrl = loadRoomCodeFromUrl();
  if (session) {
    saveSession(session);
    joinCodeInput.value = session.code;
    try {
      await loadRoomState();
      startPolling();
      return;
    } catch (error) {
      stopPolling();
      showLobby(
        error instanceof Error
          ? `Could not reconnect yet. Your room is saved — tap Join to retry. (${error.message})`
          : "Could not reconnect yet. Your room is saved — tap Join to retry.",
        session.code,
      );
      return;
    }
  }

  const localGameJson = loadLocalGame();
  if (localGameJson) {
    try {
      applyRoom(buildLocalState(localGameJson));
      return;
    } catch {
      saveLocalGame(null);
    }
  }

  if (roomCodeFromUrl) {
    joinCodeInput.value = roomCodeFromUrl;
    setLobbyError("Room code restored. Join to reconnect.");
  }

  resizeCanvas();
  requestRender();
}

registerServiceWorker();
resizeCanvas();
updateHovered(window.innerWidth / 2, window.innerHeight / 2);
updateControls();
requestRender();
restoreSession().catch((error) => {
  const saved = loadSession();
  const localGameJson = loadLocalGame();
  if (localGameJson) {
    try {
      applyRoom(buildLocalState(localGameJson));
      return;
    } catch {
      saveLocalGame(null);
    }
  }
  showLobby(
    error instanceof Error
      ? `Could not reconnect yet. Your room is saved — tap Join to retry. (${error.message})`
      : "Could not reconnect yet. Your room is saved — tap Join to retry.",
    saved?.code ?? loadRoomCodeFromUrl(),
  );
});

})().catch((error) => {
  console.error(error);
  const errorEl = document.getElementById("lobby-error");
  if (errorEl) {
    errorEl.textContent = error instanceof Error ? error.message : "Could not load Six Tac.";
  }
});
