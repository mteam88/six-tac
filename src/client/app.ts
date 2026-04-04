import type { BotName } from "../domain/types.js";
import { loadAvailableBots } from "./api.js";
import type { AppState } from "./app-types.js";
import type { CameraState } from "./render.js";
import { ROOM_QUERY_PARAM } from "../domain/types.js";
import type { LocalBindings, SettingsMode } from "./app-types.js";
import { bindCanvasInput } from "./canvas-input.js";
import { getAppElements } from "./dom.js";
import { registerServiceWorker, loadRoomCodeFromUrl } from "./helpers.js";
import { ensurePlayerId, loadSettings, saveSettings } from "./persistence.js";
import { BoardRenderer } from "./render.js";
import { createSessionController } from "./session-controller.js";
import { SettingsModal } from "./settings-modal.js";
import type { SettingsResult } from "./settings-modal.js";

function createCamera(): CameraState {
  return { x: window.innerWidth / 2, y: window.innerHeight / 2, scale: 1 };
}

function createState(): AppState {
  return {
    hexSize: 34,
    camera: createCamera(),
    hovered: null,
    selected: [],
    session: null,
    sessionRef: null,
    pointer: null,
    touchPoints: new Map(),
    pinchGesture: null,
    multiTouchGesture: false,
    pollTimer: 0,
    matchmakingTimer: 0,
    clockTimer: 0,
    pendingSubmit: false,
    recentHighlights: [],
    playerId: ensurePlayerId(),
    settings: loadSettings(),
    activeSettingsMode: null,
    matchmakingQueued: false,
    serverClockOffsetMs: 0,
  };
}

function saveModeSettings(state: AppState, mode: SettingsMode, result: SettingsResult): void {
  if (mode === "local") state.settings.localClock = result.clock ?? null;
  else if (mode === "private") state.settings.privateClock = result.clock ?? null;
  else if (mode === "bot") {
    state.settings.botClock = result.clock ?? null;
    state.settings.botName = result.botName as BotName;
    state.settings.botHumanSeat = result.botHumanSeat ?? state.settings.botHumanSeat;
  } else state.settings.matchmakingClock = result.clock ?? null;
  saveSettings(state.settings);
}

export function initApp(localBindings: LocalBindings): void {
  const elements = getAppElements();
  const state = createState();
  const renderer = new BoardRenderer(elements.canvas, () => ({
    hexSize: state.hexSize,
    camera: state.camera,
    hovered: state.hovered,
    selected: state.selected,
    session: state.session,
    recentHighlights: state.recentHighlights,
  }));
  const settingsModal = new SettingsModal(elements);
  const session = createSessionController({ state, elements, renderer, localBindings });

  bindCanvasInput({
    canvas: elements.canvas,
    state,
    renderer,
    isPlayableCell: session.isPlayableCell,
    updateHovered: session.updateHovered,
    toggleSelected: session.toggleSelected,
    closeSettings: () => {
      state.activeSettingsMode = null;
      settingsModal.close();
    },
    isSettingsOpen: () => settingsModal.isOpen(),
  });

  const openModeSettings = (mode: SettingsMode): void => {
    state.activeSettingsMode = mode;
    settingsModal.open(mode, state.settings);
  };

  elements.settingsSaveButton.addEventListener("click", () => {
    const mode = state.activeSettingsMode;
    if (!mode) return;
    try {
      saveModeSettings(state, mode, settingsModal.read(mode));
      state.activeSettingsMode = null;
      settingsModal.close();
      session.runModeFlow(mode).catch((error) => {
        session.setLobbyError(error instanceof Error ? error.message : "Could not start game.");
      });
    } catch (error) {
      session.setLobbyError(error instanceof Error ? error.message : "Invalid settings.");
    }
  });
  elements.settingsCancelButton.addEventListener("click", () => {
    state.activeSettingsMode = null;
    settingsModal.close();
  });
  elements.settingsModal.addEventListener("click", (event) => {
    if (event.target === elements.settingsModal) {
      state.activeSettingsMode = null;
      settingsModal.close();
    }
  });

  elements.localModeButton.addEventListener("click", () => openModeSettings("local"));
  elements.createRoomButton.addEventListener("click", () => openModeSettings("private"));
  elements.playBotButton.addEventListener("click", () => openModeSettings("bot"));
  elements.findMatchButton.addEventListener("click", () => {
    const action = state.matchmakingQueued
      ? session.cancelMatchmakingFlow()
      : Promise.resolve().then(() => openModeSettings("matchmade"));
    action.catch((error) => {
      session.setLobbyError(error instanceof Error ? error.message : "Could not update matchmaking.");
    });
  });
  elements.joinRoomButton.addEventListener("click", () => {
    session.joinRoomFlow(elements.joinCodeInput.value.trim()).catch((error) => {
      session.setLobbyError(error instanceof Error ? error.message : "Could not join room.");
    });
  });

  elements.joinCodeInput.addEventListener("input", () => {
    elements.joinCodeInput.value = elements.joinCodeInput.value.replace(/\D+/g, "").slice(0, 6);
  });
  elements.joinCodeInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") elements.joinRoomButton.click();
  });
  elements.leaveRoomButton.addEventListener("click", session.leaveRoom);
  elements.submitTurnButton.addEventListener("click", () => {
    session.submitTurnFlow().catch((error) => {
      elements.turnPill.textContent = error instanceof Error ? error.message : "Could not play turn";
    });
  });
  elements.copyRoomButton.addEventListener("click", async () => {
    const code = state.session?.code;
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      elements.turnPill.textContent = "code copied";
    } catch {
      elements.turnPill.textContent = state.session ? state.session.code ?? "game" : "game";
    }
  });

  window.addEventListener("online", () => void session.resumeNetworkFlows());
  window.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      void session.resumeNetworkFlows();
      return;
    }
    state.pointer = null;
    state.touchPoints.clear();
    state.pinchGesture = null;
    state.multiTouchGesture = false;
    elements.canvas.classList.remove("dragging");
    session.persistLocalSession();
  });
  window.addEventListener("pagehide", () => session.persistLocalSession());

  void loadAvailableBots()
    .then(({ bots }) => {
      settingsModal.setAvailableBots(bots);
      const botNames = bots.map((bot) => bot.name);
      if (!botNames.includes(state.settings.botName)) {
        state.settings.botName = botNames[0] ?? "sprout";
        saveSettings(state.settings);
      }
    })
    .catch(() => {
      // keep embedded defaults if the catalog request fails
    });

  registerServiceWorker();
  renderer.resizeCanvas();
  session.updateHovered(window.innerWidth / 2, window.innerHeight / 2);
  session.refreshControls();
  session.updateLobbyButtons();
  renderer.requestRender();
  session.restoreSession().catch((error) => {
    session.showLobby(
      error instanceof Error ? error.message : "Could not restore the previous session.",
      loadRoomCodeFromUrl(ROOM_QUERY_PARAM),
    );
  });
}
