import {
  cancelMatchmaking,
  createBotSession,
  createPrivateSession,
  joinPrivateSession,
  loadMatchmakingStatus,
  loadSessionState,
  queueMatchmaking,
  startLocalSession,
  submitLocalTurn,
  submitSessionTurn,
} from "./api.js";
import {
  ensurePlayerId,
  loadLocalGame,
  loadSession,
  loadSettings,
  POLL_INTERVAL_MS,
  saveLocalGame,
  saveSession,
  saveSettings,
} from "./persistence.js";
import { BoardRenderer } from "./render.js";
import type { BotName, ClockSettings, Cube, EngineSnapshot, SessionRef, SessionView } from "../domain/types.js";
import { ROOM_QUERY_PARAM } from "../domain/types.js";

type Player = "One" | "Two";
type LocalBindings = {
  snapshotJson: (gameJson: string) => string;
  playJson: (gameJson: string, stonesJson: string) => string;
};

type SettingsMode = "private" | "bot" | "matchmade";

type PointerState = {
  id: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  dragging: boolean;
};

const TAP_SLOP = 8;
const BOT_OPTIONS: Array<{ value: BotName; label: string; description: string }> = [
  { value: "sprout", label: "Sprout", description: "Makes random valid moves." },
  { value: "seal", label: "Seal", description: "Translated from Ramora0's minimax bot." },
];
const CLOCK_OPTIONS: Array<{ label: string; value: string }> = [
  { label: "No clock", value: "off" },
  { label: "1 + 0", value: "60000:0" },
  { label: "3 + 0", value: "180000:0" },
  { label: "3 + 2", value: "180000:2000" },
  { label: "5 + 3", value: "300000:3000" },
  { label: "10 + 5", value: "600000:5000" },
];

function sameCube(a: Cube | null, b: Cube | null): boolean {
  return Boolean(a && b && a.x === b.x && a.y === b.y && a.z === b.z);
}

function cubeDistance(a: Cube, b: Cube): number {
  return (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z)) / 2;
}

function seatPlayer(seat: SessionView["seat"]): Player | null {
  return seat === "one" ? "One" : seat === "two" ? "Two" : null;
}

function currentControllingPlayer(session: SessionView): Player | null {
  if (session.mode === "local") return session.currentPlayer;
  return seatPlayer(session.seat);
}

function parseClockValue(value: string): ClockSettings | null {
  if (value === "off") return null;
  const [initial, increment] = value.split(":").map(Number);
  if (!Number.isFinite(initial) || initial <= 0) return null;
  if (!Number.isFinite(increment) || increment < 0) return null;
  return {
    initialMs: initial,
    incrementMs: increment,
  };
}

function toClockValue(clock: ClockSettings | null): string {
  if (!clock) return "off";
  return `${clock.initialMs}:${clock.incrementMs}`;
}

function formatRoomCode(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3, 6)}`;
}

function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function loadRoomCodeFromUrl(): string {
  return new URL(window.location.href).searchParams.get(ROOM_QUERY_PARAM)?.replace(/\D+/g, "").slice(0, 6) ?? "";
}

function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch(() => {
      // best effort
    });
  });
}

export function initApp(localBindings: LocalBindings): void {
  const canvas = document.getElementById("board") as HTMLCanvasElement;
  const lobbyEl = document.getElementById("lobby") as HTMLDivElement;
  const lobbyErrorEl = document.getElementById("lobby-error") as HTMLDivElement;
  const localModeButton = document.getElementById("local-mode-button") as HTMLButtonElement;
  const createRoomButton = document.getElementById("create-room-button") as HTMLButtonElement;
  const createRoomSettingsButton = document.getElementById("create-room-settings-button") as HTMLButtonElement;
  const playBotButton = document.getElementById("play-bot-button") as HTMLButtonElement;
  const playBotSettingsButton = document.getElementById("play-bot-settings-button") as HTMLButtonElement;
  const findMatchButton = document.getElementById("find-match-button") as HTMLButtonElement;
  const findMatchSettingsButton = document.getElementById("find-match-settings-button") as HTMLButtonElement;
  const joinRoomButton = document.getElementById("join-room-button") as HTMLButtonElement;
  const joinCodeInput = document.getElementById("join-code-input") as HTMLInputElement;
  const bottomBarEl = document.getElementById("bottom-bar") as HTMLDivElement;
  const roomCodePill = document.getElementById("room-code-pill") as HTMLSpanElement;
  const copyRoomButton = document.getElementById("copy-room-button") as HTMLButtonElement;
  const turnPill = document.getElementById("turn-pill") as HTMLSpanElement;
  const clockPanel = document.getElementById("clock-panel") as HTMLDivElement;
  const clockOneCard = document.getElementById("clock-one") as HTMLDivElement;
  const clockTwoCard = document.getElementById("clock-two") as HTMLDivElement;
  const clockOneTime = document.getElementById("clock-one-time") as HTMLSpanElement;
  const clockTwoTime = document.getElementById("clock-two-time") as HTMLSpanElement;
  const leaveRoomButton = document.getElementById("leave-room-button") as HTMLButtonElement;
  const submitTurnButton = document.getElementById("submit-turn-button") as HTMLButtonElement;
  const submitLabel = document.getElementById("submit-label") as HTMLSpanElement;
  const settingsModal = document.getElementById("settings-modal") as HTMLDivElement;
  const settingsTitle = document.getElementById("settings-title") as HTMLHeadingElement;
  const settingsClockSelect = document.getElementById("settings-clock-select") as HTMLSelectElement;
  const settingsBotRow = document.getElementById("settings-bot-row") as HTMLDivElement;
  const settingsBotSelect = document.getElementById("settings-bot-select") as HTMLSelectElement;
  const settingsHint = document.getElementById("settings-hint") as HTMLParagraphElement;
  const settingsCancelButton = document.getElementById("settings-cancel-button") as HTMLButtonElement;
  const settingsSaveButton = document.getElementById("settings-save-button") as HTMLButtonElement;

  settingsClockSelect.innerHTML = CLOCK_OPTIONS.map((option) => `<option value="${option.value}">${option.label}</option>`).join("");
  settingsBotSelect.innerHTML = BOT_OPTIONS.map((option) => `<option value="${option.value}">${option.label}</option>`).join("");

  const state = {
    hexSize: 34,
    camera: {
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
      scale: 1,
    },
    hovered: null as Cube | null,
    selected: [] as Cube[],
    session: null as SessionView | null,
    sessionRef: null as SessionRef | null,
    pointer: null as PointerState | null,
    touchPoints: new Map<number, { x: number; y: number }>(),
    pinchGesture: null as null | {
      distance: number;
      midpointX: number;
      midpointY: number;
    },
    multiTouchGesture: false,
    pollTimer: 0 as number,
    matchmakingTimer: 0 as number,
    clockTimer: 0 as number,
    pendingSubmit: false,
    recentHighlights: [] as Cube[],
    playerId: ensurePlayerId(),
    settings: loadSettings(),
    activeSettingsMode: null as SettingsMode | null,
    matchmakingQueued: false,
    serverClockOffsetMs: 0,
  };

  const renderer = new BoardRenderer(canvas, () => ({
    hexSize: state.hexSize,
    camera: state.camera,
    hovered: state.hovered,
    selected: state.selected,
    session: state.session,
    recentHighlights: state.recentHighlights,
  }));

  function setLobbyError(message: string): void {
    lobbyErrorEl.textContent = message;
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

  function persistSession(ref: SessionRef | null): void {
    state.sessionRef = ref;
    saveSession(ref);
    updateRoomUrl(ref?.code ?? null);
  }

  function buildLocalSession(snapshot: EngineSnapshot): SessionView {
    const parsed = JSON.parse(snapshot.turns_json) as { turns?: Array<{ stones?: Cube[] }> };
    const turns = parsed.turns ?? [];
    const lastTurn = turns.length === 0
      ? { lastTurnPlayer: null as Player | null, lastTurnStones: [] as Cube[] }
      : {
          lastTurnPlayer: (turns.length - 1) % 2 === 0 ? "Two" as Player : "One" as Player,
          lastTurnStones: turns[turns.length - 1].stones ?? [],
        };

    return {
      id: "local",
      code: null,
      mode: "local",
      seat: "local",
      status: snapshot.winner ? "finished" : "active",
      currentPlayer: snapshot.current_player,
      winner: snapshot.winner,
      resultReason: snapshot.winner ? "win" : null,
      yourTurn: !snapshot.winner,
      turns: snapshot.turn_count,
      stones: snapshot.stones,
      lastTurnPlayer: lastTurn.lastTurnPlayer,
      lastTurnStones: lastTurn.lastTurnStones,
      gameJson: snapshot.turns_json,
      clock: null,
      serverNow: Date.now(),
    };
  }

  function callLocalSnapshot(gameJson: string): SessionView {
    return buildLocalSession(JSON.parse(localBindings.snapshotJson(gameJson)) as EngineSnapshot);
  }

  function buildLocalState(gameJson: string): SessionView {
    return callLocalSnapshot(gameJson);
  }

  function callLocalPlay(gameJson: string, stones: Cube[]): SessionView {
    return buildLocalSession(JSON.parse(localBindings.playJson(gameJson, JSON.stringify(stones))) as EngineSnapshot);
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

  function saveCurrentSettings(): void {
    saveSettings(state.settings);
  }

  function openSettings(mode: SettingsMode): void {
    state.activeSettingsMode = mode;
    settingsModal.classList.remove("hidden");
    settingsBotRow.classList.toggle("hidden", mode !== "bot");

    if (mode === "private") {
      settingsTitle.textContent = "Room settings";
      settingsClockSelect.value = toClockValue(state.settings.privateClock);
      settingsHint.textContent = "Saved settings apply to new private rooms created from this device.";
    } else if (mode === "bot") {
      settingsTitle.textContent = "Bot settings";
      settingsClockSelect.value = toClockValue(state.settings.botClock);
      settingsBotSelect.value = state.settings.botName;
      settingsHint.textContent = "Sprout plays randomly. Seal is a Rust translation of Ramora0's stronger bot ideas.";
    } else {
      settingsTitle.textContent = "Matchmaking settings";
      settingsClockSelect.value = toClockValue(state.settings.matchmakingClock);
      settingsHint.textContent = "Queue settings affect the next search for a random opponent.";
    }
  }

  function closeSettings(): void {
    state.activeSettingsMode = null;
    settingsModal.classList.add("hidden");
  }

  function updateLobbyButtons(): void {
    findMatchButton.textContent = state.matchmakingQueued ? "Cancel search" : "Find match";
    localModeButton.disabled = state.matchmakingQueued;
    createRoomButton.disabled = state.matchmakingQueued;
    playBotButton.disabled = state.matchmakingQueued;
    joinRoomButton.disabled = state.matchmakingQueued;
    joinCodeInput.disabled = state.matchmakingQueued;
  }

  function startClockTicker(): void {
    stopClockTicker();
    if (!state.session?.clock?.enabled) {
      clockPanel.classList.add("hidden");
      return;
    }
    clockPanel.classList.remove("hidden");
    state.clockTimer = window.setInterval(() => {
      updateControls();
    }, 250);
  }

  function stopClockTicker(): void {
    if (state.clockTimer) {
      window.clearInterval(state.clockTimer);
      state.clockTimer = 0;
    }
  }

  function currentServerTime(): number {
    return Date.now() + state.serverClockOffsetMs;
  }

  function currentClockTimes(): { one: number; two: number } {
    const session = state.session;
    const clock = session?.clock;
    if (!session || !clock?.enabled) {
      return { one: 0, two: 0 };
    }

    const now = currentServerTime();
    const one = clock.activeSeat === "one" && clock.turnStartedAt !== null
      ? Math.max(0, clock.remainingMs.one - (now - clock.turnStartedAt))
      : clock.remainingMs.one;
    const two = clock.activeSeat === "two" && clock.turnStartedAt !== null
      ? Math.max(0, clock.remainingMs.two - (now - clock.turnStartedAt))
      : clock.remainingMs.two;
    return { one, two };
  }

  function currentSessionLabel(): string {
    const session = state.session;
    if (!session) return "—";
    if (session.mode === "local") return "local";
    if (session.code) return formatRoomCode(session.code);
    if (session.mode === "bot") return "bot";
    if (session.mode === "matchmade") return "match";
    return "game";
  }

  function updateControls(): void {
    const session = state.session;
    if (!session) {
      bottomBarEl.classList.add("hidden");
      return;
    }

    bottomBarEl.classList.remove("hidden");
    roomCodePill.textContent = currentSessionLabel();
    copyRoomButton.classList.toggle("hidden", !session.code);

    if (session.winner) {
      if (session.resultReason === "timeout") {
        turnPill.textContent = session.winner === "One" ? "red won on time" : "blue won on time";
      } else {
        turnPill.textContent = session.winner === "One" ? "red won" : "blue won";
      }
    } else if (session.status === "waiting") {
      turnPill.textContent = "waiting for opponent";
    } else {
      turnPill.textContent = session.currentPlayer === "One" ? "red to move" : "blue to move";
    }

    if (session.clock?.enabled) {
      const times = currentClockTimes();
      clockOneTime.textContent = formatClock(times.one);
      clockTwoTime.textContent = formatClock(times.two);
      clockPanel.classList.remove("hidden");
      clockOneCard.classList.toggle("clock-card-active", session.clock.activeSeat === "one");
      clockTwoCard.classList.toggle("clock-card-active", session.clock.activeSeat === "two");
      clockOneCard.classList.toggle("clock-card-critical", times.one <= 15_000);
      clockTwoCard.classList.toggle("clock-card-critical", times.two <= 15_000);
    } else {
      clockPanel.classList.add("hidden");
      clockOneCard.classList.remove("clock-card-active", "clock-card-critical");
      clockTwoCard.classList.remove("clock-card-active", "clock-card-critical");
    }

    const canPlay = session.mode === "local"
      ? !session.winner
      : session.yourTurn && !session.winner && (session.seat === "one" || session.seat === "two");
    submitLabel.textContent = state.pendingSubmit ? "Playing" : "Play";
    submitTurnButton.disabled = !canPlay || state.selected.length !== 2 || state.pendingSubmit;
  }

  function stopPolling(): void {
    if (state.pollTimer) {
      window.clearInterval(state.pollTimer);
      state.pollTimer = 0;
    }
  }

  function startPolling(): void {
    stopPolling();
    if (!state.sessionRef) return;
    state.pollTimer = window.setInterval(() => {
      loadSessionState(state.sessionRef!).then(applySession).catch((error) => {
        turnPill.textContent = error instanceof Error ? error.message : "Connection lost";
      });
    }, POLL_INTERVAL_MS);
  }

  function stopMatchmakingPolling(): void {
    if (state.matchmakingTimer) {
      window.clearInterval(state.matchmakingTimer);
      state.matchmakingTimer = 0;
    }
  }

  function showLobby(message: string, roomCode = ""): void {
    state.session = null;
    state.selected = [];
    state.recentHighlights = [];
    lobbyEl.classList.remove("hidden");
    bottomBarEl.classList.add("hidden");
    setLobbyError(message);
    joinCodeInput.value = roomCode;
    stopClockTicker();
    renderer.requestRender();
    updateLobbyButtons();
  }

  function applySession(session: SessionView): void {
    const previousSession = state.session;
    const previousTurns = previousSession?.turns ?? 0;
    const controllingPlayer = currentControllingPlayer(session);
    const shouldHighlightRecent = session.mode === "local"
      ? session.lastTurnStones.length > 0
      : Boolean(session.lastTurnPlayer && session.lastTurnPlayer !== controllingPlayer && session.lastTurnStones.length > 0);

    state.session = session;
    state.serverClockOffsetMs = session.serverNow - Date.now();
    if (session.mode === "local") {
      saveLocalGame(session.gameJson);
    }

    lobbyEl.classList.add("hidden");
    bottomBarEl.classList.remove("hidden");

    if (!session.yourTurn || session.winner) {
      state.selected = [];
    } else {
      state.selected = state.selected.filter((selectedCube) => {
        return !session.stones.some((stone) => sameCube(stone, selectedCube));
      });
    }

    state.recentHighlights = shouldHighlightRecent ? session.lastTurnStones.slice() : [];

    if (session.turns > previousTurns && shouldHighlightRecent && !renderer.cubesAreVisible(session.lastTurnStones)) {
      renderer.centerOnCubes(session.lastTurnStones);
    }

    startClockTicker();
    updateControls();
    renderer.requestRender();
  }

  function isWithinPlacementRange(cube: Cube): boolean {
    const stones = state.session?.stones ?? [];
    return stones.some((stone) => cubeDistance(stone, cube) <= 8);
  }

  function isPlayableCell(cube: Cube): boolean {
    if (!state.session || state.session.winner) return false;
    if (state.session.mode !== "local" && !state.session.yourTurn) return false;
    if (state.session.seat === "spectator") return false;
    if (state.session.stones.some((stone) => sameCube(stone, cube))) return false;
    return isWithinPlacementRange(cube);
  }

  function toggleSelected(cube: Cube): void {
    const existingIndex = state.selected.findIndex((selectedCube) => sameCube(selectedCube, cube));
    if (existingIndex >= 0) {
      state.selected.splice(existingIndex, 1);
    } else if (state.selected.length < 2) {
      state.selected.push(cube);
    }
    updateControls();
    renderer.requestRender();
  }

  function updateHovered(clientX: number, clientY: number): void {
    state.hovered = renderer.screenToCube(clientX, clientY);
  }

  async function startLocalGameFlow(): Promise<void> {
    setLobbyError("");
    persistSession(null);
    const savedGameJson = loadLocalGame();
    if (!savedGameJson) {
      applySession(await startLocalSession());
      return;
    }

    const savedSession = buildLocalState(savedGameJson);
    if (savedSession.winner) {
      saveLocalGame(null);
      applySession(await startLocalSession());
      return;
    }

    applySession(savedSession);
  }

  async function createPrivateRoomFlow(): Promise<void> {
    setLobbyError("");
    const result = await createPrivateSession(state.playerId, state.settings.privateClock);
    persistSession({ id: result.session.id, code: result.session.code, token: result.token });
    applySession(result.session);
    startPolling();
  }

  async function createBotGameFlow(): Promise<void> {
    setLobbyError("");
    const result = await createBotSession(state.playerId, state.settings.botName, state.settings.botClock);
    persistSession({ id: result.session.id, code: result.session.code, token: result.token });
    applySession(result.session);
    startPolling();
  }

  async function joinRoomFlow(code: string): Promise<void> {
    setLobbyError("");
    const result = await joinPrivateSession(code, state.sessionRef?.token ?? null, state.playerId);
    persistSession({ id: result.session.id, code: result.session.code, token: result.token });
    applySession(result.session);
    startPolling();
  }

  async function loadSessionStateFlow(): Promise<void> {
    if (!state.sessionRef) return;
    applySession(await loadSessionState(state.sessionRef));
  }

  async function queueMatchmakingFlow(): Promise<void> {
    const status = await queueMatchmaking(state.playerId, state.settings.matchmakingClock);
    if (status.status === "matched") {
      persistSession(status.ref);
      state.matchmakingQueued = false;
      stopMatchmakingPolling();
      applySession(status.session);
      startPolling();
      updateLobbyButtons();
      return;
    }

    state.matchmakingQueued = status.status === "queued";
    setLobbyError(state.matchmakingQueued ? "Searching for an opponent…" : "");
    updateLobbyButtons();
    stopMatchmakingPolling();
    if (state.matchmakingQueued) {
      state.matchmakingTimer = window.setInterval(() => {
        loadMatchmakingStatus(state.playerId).then((nextStatus) => {
          if (nextStatus.status === "matched") {
            persistSession(nextStatus.ref);
            state.matchmakingQueued = false;
            stopMatchmakingPolling();
            updateLobbyButtons();
            applySession(nextStatus.session);
            startPolling();
            return;
          }
          state.matchmakingQueued = nextStatus.status === "queued";
          setLobbyError(state.matchmakingQueued ? "Searching for an opponent…" : "");
          updateLobbyButtons();
        }).catch((error) => {
          setLobbyError(error instanceof Error ? error.message : "Matchmaking failed");
          state.matchmakingQueued = false;
          stopMatchmakingPolling();
          updateLobbyButtons();
        });
      }, POLL_INTERVAL_MS);
    }
  }

  async function cancelMatchmakingFlow(): Promise<void> {
    await cancelMatchmaking(state.playerId);
    state.matchmakingQueued = false;
    stopMatchmakingPolling();
    setLobbyError("");
    updateLobbyButtons();
  }

  async function submitTurnFlow(): Promise<void> {
    if (!state.session || state.selected.length !== 2 || state.pendingSubmit) {
      return;
    }

    state.pendingSubmit = true;
    updateControls();

    try {
      const nextSession = state.session.mode === "local"
        ? await submitLocalTurn(state.session.gameJson, state.selected)
        : await submitSessionTurn(state.sessionRef!, state.selected);
      state.selected = [];
      applySession(nextSession);
    } catch (error) {
      turnPill.textContent = error instanceof Error ? error.message : "Could not play turn";
    } finally {
      state.pendingSubmit = false;
      updateControls();
      renderer.requestRender();
    }
  }

  function leaveRoom(): void {
    if (!state.session) return;
    const confirmed = window.confirm(
      state.session.mode === "local"
        ? "Leave this local game? It will stay saved on this device so you can resume offline later."
        : "Leave this session? You can reconnect later from this browser.",
    );
    if (!confirmed) return;

    stopPolling();
    if (state.session.mode !== "local") {
      persistSession(null);
    }
    showLobby("");
  }

  async function restoreSession(): Promise<void> {
    const savedSessionRef = loadSession();
    const roomCodeFromUrl = loadRoomCodeFromUrl();
    if (savedSessionRef) {
      persistSession(savedSessionRef);
      joinCodeInput.value = savedSessionRef.code ?? "";
      try {
        await loadSessionStateFlow();
        startPolling();
        return;
      } catch (error) {
        stopPolling();
        showLobby(
          error instanceof Error
            ? `Could not reconnect yet. Your session is saved — try joining again. (${error.message})`
            : "Could not reconnect yet. Your session is saved — try joining again.",
          savedSessionRef.code ?? roomCodeFromUrl,
        );
        return;
      }
    }

    const localGameJson = loadLocalGame();
    if (localGameJson) {
      try {
        applySession(buildLocalState(localGameJson));
        return;
      } catch {
        saveLocalGame(null);
      }
    }

    if (roomCodeFromUrl) {
      joinCodeInput.value = roomCodeFromUrl;
      setLobbyError("Room code restored. Join to reconnect.");
    }

    renderer.resizeCanvas();
    renderer.requestRender();
  }

  settingsSaveButton.addEventListener("click", () => {
    const mode = state.activeSettingsMode;
    if (!mode) return;
    const clockValue = parseClockValue(settingsClockSelect.value);
    if (mode === "private") {
      state.settings.privateClock = clockValue;
    } else if (mode === "bot") {
      state.settings.botClock = clockValue;
      state.settings.botName = settingsBotSelect.value as BotName;
    } else {
      state.settings.matchmakingClock = clockValue;
    }
    saveCurrentSettings();
    closeSettings();
  });
  settingsCancelButton.addEventListener("click", closeSettings);
  settingsModal.addEventListener("click", (event) => {
    if (event.target === settingsModal) {
      closeSettings();
    }
  });

  localModeButton.addEventListener("click", () => {
    startLocalGameFlow().catch((error) => {
      setLobbyError(error instanceof Error ? error.message : "Could not start local game.");
    });
  });
  createRoomButton.addEventListener("click", () => {
    createPrivateRoomFlow().catch((error) => {
      setLobbyError(error instanceof Error ? error.message : "Could not create room.");
    });
  });
  createRoomSettingsButton.addEventListener("click", () => openSettings("private"));
  playBotButton.addEventListener("click", () => {
    createBotGameFlow().catch((error) => {
      setLobbyError(error instanceof Error ? error.message : "Could not start bot game.");
    });
  });
  playBotSettingsButton.addEventListener("click", () => openSettings("bot"));
  findMatchButton.addEventListener("click", () => {
    const action = state.matchmakingQueued ? cancelMatchmakingFlow() : queueMatchmakingFlow();
    action.catch((error) => {
      setLobbyError(error instanceof Error ? error.message : "Could not update matchmaking.");
    });
  });
  findMatchSettingsButton.addEventListener("click", () => openSettings("matchmade"));
  joinRoomButton.addEventListener("click", () => {
    joinRoomFlow(joinCodeInput.value.trim()).catch((error) => {
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
    submitTurnFlow().catch((error) => {
      turnPill.textContent = error instanceof Error ? error.message : "Could not play turn";
    });
  });
  copyRoomButton.addEventListener("click", async () => {
    const code = state.session?.code;
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      turnPill.textContent = "code copied";
    } catch {
      turnPill.textContent = code;
    }
  });

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
        renderer.requestRender();
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
    renderer.requestRender();
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
            renderer.zoomAt(gesture.midpointX, gesture.midpointY, gesture.distance / state.pinchGesture.distance);
          }
        }
        state.multiTouchGesture = true;
        state.pinchGesture = gesture;
        renderer.requestRender();
        return;
      }
    }

    if (!state.pointer || state.pointer.id !== event.pointerId) {
      renderer.requestRender();
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
    renderer.requestRender();
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
      renderer.requestRender();
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
    renderer.requestRender();
  }

  canvas.addEventListener("pointerup", finishPointer);
  canvas.addEventListener("pointercancel", finishPointer);
  canvas.addEventListener("pointerleave", () => {
    if (!state.pointer) {
      state.hovered = null;
      renderer.requestRender();
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
        renderer.zoomAt(event.clientX, event.clientY, factor);
      } else {
        state.camera.x -= event.deltaX * scale;
        state.camera.y -= event.deltaY * scale;
      }

      updateHovered(event.clientX, event.clientY);
      renderer.requestRender();
    },
    { passive: false },
  );

  window.addEventListener("resize", () => renderer.resizeCanvas());
  window.addEventListener("online", () => {
    if (!state.sessionRef) return;
    loadSessionStateFlow().catch(() => {
      // keep saved session for retry
    });
  });
  window.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.sessionRef) {
      loadSessionStateFlow().catch(() => {
        // keep saved session for retry
      });
    }
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !settingsModal.classList.contains("hidden")) {
      closeSettings();
      return;
    }
    if (event.key === "+" || event.key === "=") {
      renderer.zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1.12);
      renderer.requestRender();
    } else if (event.key === "-") {
      renderer.zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1 / 1.12);
      renderer.requestRender();
    }
  });

  registerServiceWorker();
  renderer.resizeCanvas();
  updateHovered(window.innerWidth / 2, window.innerHeight / 2);
  updateControls();
  updateLobbyButtons();
  renderer.requestRender();
  restoreSession().catch((error) => {
    showLobby(
      error instanceof Error ? error.message : "Could not restore the previous session.",
      loadRoomCodeFromUrl(),
    );
  });
}
