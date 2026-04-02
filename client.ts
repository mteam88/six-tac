(() => {

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

type RoomState = {
  code: string;
  seat: Seat;
  currentPlayer: Player;
  winner: Player | null;
  yourTurn: boolean;
  turns: number;
  stones: Stone[];
};

type Session = {
  code: string;
  token: string;
};

const canvas = document.getElementById("board") as HTMLCanvasElement;
const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
const lobbyEl = document.getElementById("lobby") as HTMLDivElement;
const lobbyErrorEl = document.getElementById("lobby-error") as HTMLDivElement;
const createRoomButton = document.getElementById("create-room-button") as HTMLButtonElement;
const joinRoomButton = document.getElementById("join-room-button") as HTMLButtonElement;
const joinCodeInput = document.getElementById("join-code-input") as HTMLInputElement;
const topBarEl = document.getElementById("top-bar") as HTMLDivElement;
const roomCodePill = document.getElementById("room-code-pill") as HTMLSpanElement;
const seatPill = document.getElementById("seat-pill") as HTMLSpanElement;
const turnPill = document.getElementById("turn-pill") as HTMLSpanElement;
const leaveRoomButton = document.getElementById("leave-room-button") as HTMLButtonElement;
const turnPanelEl = document.getElementById("turn-panel") as HTMLDivElement;
const turnMessageEl = document.getElementById("turn-message") as HTMLDivElement;
const submitTurnButton = document.getElementById("submit-turn-button") as HTMLButtonElement;
const coordsEl = document.getElementById("coords") as HTMLDivElement;

const SQRT3 = Math.sqrt(3);
const TAP_SLOP = 8;
const SESSION_KEY = "six-tac-session";
const POLL_INTERVAL_MS = 1200;

const state = {
  hexSize: 34,
  camera: {
    x: window.innerWidth / 2,
    y: window.innerHeight / 2,
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
  pollTimer: 0 as number,
  rafPending: false,
  pendingSubmit: false,
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
    x: x + state.camera.x,
    y: y + state.camera.y,
  };
}

function screenToWorld(x: number, y: number): { x: number; y: number } {
  return {
    x: x - state.camera.x,
    y: y - state.camera.y,
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

function render(): void {
  state.rafPending = false;
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

  const occupied = new Map<string, Stone>();
  for (const stone of state.room?.stones ?? []) {
    occupied.set(cubeKey(stone), stone);
  }

  const selected = new Set(state.selected.map(cubeKey));
  const range = getVisibleRange();

  for (let q = range.minQ; q <= range.maxQ; q += 1) {
    for (let r = range.minR; r <= range.maxR; r += 1) {
      const cube = { x: q, y: -q - r, z: r };
      const point = hexToPixel(cube);
      const screen = worldToScreen(point.x, point.y);

      if (
        screen.x < -state.hexSize * 2 ||
        screen.x > window.innerWidth + state.hexSize * 2 ||
        screen.y < -state.hexSize * 2 ||
        screen.y > window.innerHeight + state.hexSize * 2
      ) {
        continue;
      }

      const stone = occupied.get(cubeKey(cube));
      const isHovered = sameCube(state.hovered, cube);
      const isSelected = selected.has(cubeKey(cube));

      let fill = "rgba(148, 163, 184, 0.06)";
      let stroke = "rgba(148, 163, 184, 0.26)";
      let lineWidth = 1.5;

      if (stone?.player === "One") {
        fill = "rgba(239, 68, 68, 0.72)";
        stroke = "rgba(254, 202, 202, 0.95)";
        lineWidth = 2;
      } else if (stone?.player === "Two") {
        fill = "rgba(59, 130, 246, 0.72)";
        stroke = "rgba(191, 219, 254, 0.95)";
        lineWidth = 2;
      } else if (isSelected) {
        const previewColor = seatColor(state.room?.seat ?? "spectator");
        fill = previewColor.fill;
        stroke = previewColor.stroke;
        lineWidth = 2;
      }

      if (isHovered) {
        if (!stone && !isSelected) {
          fill = "rgba(99, 102, 241, 0.18)";
        }
        stroke = "rgba(255, 255, 255, 0.92)";
        lineWidth = Math.max(lineWidth, 2.25);
      }

      drawHex(screen.x, screen.y, fill, stroke, lineWidth);
    }
  }
}

function drawHex(centerX: number, centerY: number, fillStyle: string, strokeStyle: string, lineWidth: number): void {
  ctx.beginPath();
  for (let i = 0; i < 6; i += 1) {
    const angle = ((60 * i - 30) * Math.PI) / 180;
    const x = centerX + state.hexSize * Math.cos(angle);
    const y = centerY + state.hexSize * Math.sin(angle);
    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.closePath();
  ctx.fillStyle = fillStyle;
  ctx.fill();
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = strokeStyle;
  ctx.stroke();
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
  if (state.hovered) {
    coordsEl.textContent = `hover: ${state.hovered.x}, ${state.hovered.y}, ${state.hovered.z}`;
  } else {
    coordsEl.textContent = "hover: —";
  }
}

function setLobbyError(message: string): void {
  lobbyErrorEl.textContent = message;
}

function saveSession(session: Session | null): void {
  state.session = session;
  if (!session) {
    localStorage.removeItem(SESSION_KEY);
    return;
  }
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
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
  if (!state.session || !state.room || state.selected.length !== 2 || state.pendingSubmit) {
    return;
  }

  state.pendingSubmit = true;
  setTurnMessage("Playing turn...");
  updateControls();

  try {
    const room = await requestJson<RoomState>(`/api/rooms/${state.session.code}/move`, {
      method: "POST",
      body: JSON.stringify({
        token: state.session.token,
        stones: state.selected,
      }),
    });
    state.selected = [];
    applyRoom(room);
  } catch (error) {
    setTurnMessage(error instanceof Error ? error.message : "Could not play turn.");
  } finally {
    state.pendingSubmit = false;
    updateControls();
    requestRender();
  }
}

function applyRoom(room: RoomState): void {
  state.room = room;
  lobbyEl.classList.add("hidden");
  topBarEl.classList.remove("hidden");

  if (!room.yourTurn || room.winner) {
    state.selected = [];
  } else {
    state.selected = state.selected.filter((selectedCube) => {
      return !room.stones.some((stone) => sameCube(stone, selectedCube));
    });
  }

  roomCodePill.textContent = `room ${room.code}`;
  seatPill.textContent = room.seat === "one" ? "you are red" : room.seat === "two" ? "you are blue" : "spectator";

  if (room.winner) {
    turnPill.textContent = `${room.winner === "One" ? "red" : "blue"} won`;
  } else if (room.yourTurn) {
    turnPill.textContent = "your turn";
  } else {
    turnPill.textContent = `${room.currentPlayer === "One" ? "red" : "blue"} to move`;
  }

  updateControls();
  requestRender();
}

function setTurnMessage(message: string): void {
  turnMessageEl.textContent = message;
}

function updateControls(): void {
  const room = state.room;
  if (!room) {
    topBarEl.classList.add("hidden");
    turnPanelEl.classList.add("hidden");
    return;
  }

  const canPlay = room.yourTurn && !room.winner && (room.seat === "one" || room.seat === "two");
  if (!canPlay) {
    turnPanelEl.classList.remove("hidden");
    submitTurnButton.disabled = true;
    if (room.winner) {
      setTurnMessage(room.winner === "One" ? "Red wins." : "Blue wins.");
    } else if (room.seat === "spectator") {
      setTurnMessage("Watching room.");
    } else {
      setTurnMessage("Waiting for the other player.");
    }
    return;
  }

  turnPanelEl.classList.remove("hidden");
  if (state.selected.length === 0) {
    setTurnMessage("Select 2 empty hexes.");
  } else if (state.selected.length === 1) {
    setTurnMessage("Select 1 more hex.");
  } else {
    setTurnMessage("Ready to play.");
  }
  submitTurnButton.disabled = state.selected.length !== 2 || state.pendingSubmit;
}

function startPolling(): void {
  stopPolling();
  state.pollTimer = window.setInterval(() => {
    loadRoomState().catch((error) => {
      setTurnMessage(error instanceof Error ? error.message : "Connection lost.");
    });
  }, POLL_INTERVAL_MS);
}

function stopPolling(): void {
  if (state.pollTimer) {
    window.clearInterval(state.pollTimer);
    state.pollTimer = 0;
  }
}

function leaveRoom(): void {
  stopPolling();
  saveSession(null);
  state.room = null;
  state.selected = [];
  lobbyEl.classList.remove("hidden");
  topBarEl.classList.add("hidden");
  turnPanelEl.classList.add("hidden");
  setLobbyError("");
  joinCodeInput.value = "";
  requestRender();
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
  if (!state.room || !state.room.yourTurn || state.room.winner) return false;
  if (state.room.seat === "spectator") return false;
  return !state.room.stones.some((stone) => sameCube(stone, cube));
}

canvas.addEventListener("pointerdown", (event) => {
  canvas.setPointerCapture(event.pointerId);
  state.pointer = {
    id: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    lastX: event.clientX,
    lastY: event.clientY,
    dragging: false,
  };
  updateHovered(event.clientX, event.clientY);
  canvas.classList.add("dragging");
  requestRender();
});

canvas.addEventListener("pointermove", (event) => {
  updateHovered(event.clientX, event.clientY);

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
  if (!state.pointer || state.pointer.id !== event.pointerId) {
    return;
  }

  updateHovered(event.clientX, event.clientY);

  if (!state.pointer.dragging && state.hovered && isPlayableCell(state.hovered)) {
    toggleSelected(state.hovered);
  }

  canvas.classList.remove("dragging");
  state.pointer = null;
  requestRender();
}

canvas.addEventListener("pointerup", finishPointer);
canvas.addEventListener("pointercancel", finishPointer);
canvas.addEventListener("pointerleave", () => {
  if (!state.pointer) {
    state.hovered = null;
    coordsEl.textContent = "hover: —";
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
    state.camera.x -= event.deltaX * scale;
    state.camera.y -= event.deltaY * scale;
    updateHovered(event.clientX, event.clientY);
    requestRender();
  },
  { passive: false },
);

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
    setTurnMessage(error instanceof Error ? error.message : "Could not play turn.");
  });
});

window.addEventListener("resize", resizeCanvas);

async function restoreSession(): Promise<void> {
  const session = loadSession();
  if (!session) {
    resizeCanvas();
    requestRender();
    return;
  }

  saveSession(session);
  try {
    await loadRoomState();
    startPolling();
  } catch {
    saveSession(null);
    lobbyEl.classList.remove("hidden");
  }
}

resizeCanvas();
updateHovered(window.innerWidth / 2, window.innerHeight / 2);
updateControls();
requestRender();
restoreSession().catch(() => {
  saveSession(null);
});

})();
