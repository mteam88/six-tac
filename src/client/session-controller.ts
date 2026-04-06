import {
  cancelMatchmaking,
  createBotSession,
  createPrivateSession,
  joinPrivateSession,
  loadMatchmakingStatus,
  loadSessionState,
  queueMatchmaking,
  submitSessionTurn,
} from "./api.js";
import type { AppState, LocalBindings, SettingsMode } from "./app-types.js";
import type { AppElements } from "./dom.js";
import { sameCube, cubeDistance, currentControllingPlayer, loadRoomCodeFromUrl } from "./helpers.js";
import {
  advanceLocalClock,
  buildLocalState,
  buildLocalSession,
  callLocalPlay,
  createFreshLocalSession,
} from "./local-game.js";
import { loadLocalGame, loadSession, POLL_INTERVAL_MS, saveLocalGame, saveSession } from "./persistence.js";
import type { BoardRenderer } from "./render.js";
import { updateControls } from "./session-ui.js";
import { ROOM_QUERY_PARAM } from "../domain/types.js";
import type { Cube, SessionRef, SessionView } from "../domain/types.js";

export function createSessionController(options: {
  state: AppState;
  elements: AppElements;
  renderer: BoardRenderer;
  localBindings: LocalBindings;
}) {
  const { state, elements, renderer, localBindings } = options;

  const setLobbyError = (message: string): void => {
    elements.lobbyError.textContent = message;
  };
  const updateRoomUrl = (code: string | null): void => {
    const url = new URL(window.location.href);
    if (code) url.searchParams.set(ROOM_QUERY_PARAM, code);
    else url.searchParams.delete(ROOM_QUERY_PARAM);
    window.history.replaceState({}, "", url);
  };
  const persistSession = (ref: SessionRef | null): void => {
    state.sessionRef = ref;
    saveSession(ref);
    updateRoomUrl(ref?.code ?? null);
  };
  const persistLocalSession = (session = state.session): void => {
    if (session?.mode !== "local") return;
    saveLocalGame({ gameJson: session.gameJson, clock: session.clock ? JSON.parse(JSON.stringify(session.clock)) : null });
  };
  const refreshControls = (): void => {
    if (updateControls(state, elements)) {
      persistLocalSession();
      renderer.requestRender();
    }
  };
  const updateLobbyButtons = (): void => {
    elements.findMatchButton.textContent = state.matchmakingQueued ? "Cancel search" : "Find match";
    for (const button of [
      elements.localModeButton,
      elements.createRoomButton,
      elements.playBotButton,
      elements.joinRoomButton,
    ]) {
      button.disabled = state.matchmakingQueued;
    }
    elements.joinCodeInput.disabled = state.matchmakingQueued;
  };
  const stopClockTicker = (): void => {
    if (state.clockTimer) window.clearInterval(state.clockTimer);
    state.clockTimer = 0;
  };
  const startClockTicker = (): void => {
    stopClockTicker();
    if (!state.session?.clock?.enabled) {
      elements.clockPanel.classList.add("hidden");
      return;
    }
    state.clockTimer = window.setInterval(refreshControls, 250);
  };
  const stopPolling = (): void => {
    if (state.pollTimer) window.clearInterval(state.pollTimer);
    state.pollTimer = 0;
  };
  const stopMatchmakingPolling = (): void => {
    if (state.matchmakingTimer) window.clearInterval(state.matchmakingTimer);
    state.matchmakingTimer = 0;
  };
  const shouldPauseNetworkSync = (): boolean => document.visibilityState !== "visible" || !navigator.onLine;

  const showLobby = (message: string, roomCode = ""): void => {
    state.session = null;
    state.selected = [];
    state.recentHighlights = [];
    elements.copyRoomButton.dataset.player = "";
    elements.lobby.classList.remove("hidden");
    elements.bottomBar.classList.add("hidden");
    elements.siteFooter.classList.remove("hidden");
    elements.joinCodeInput.value = roomCode;
    setLobbyError(message);
    stopClockTicker();
    updateLobbyButtons();
    renderer.requestRender();
  };

  const applySession = (session: SessionView): void => {
    const previousTurns = state.session?.turns ?? 0;
    const controllingPlayer = currentControllingPlayer(session);
    const highlight = session.mode === "local"
      ? session.lastTurnStones.length > 0
      : Boolean(session.lastTurnPlayer && session.lastTurnPlayer !== controllingPlayer && session.lastTurnStones.length > 0);

    state.session = session;
    state.serverClockOffsetMs = session.mode === "local" ? 0 : session.serverNow - Date.now();
    if (session.mode === "local") persistLocalSession(session);

    elements.lobby.classList.add("hidden");
    elements.bottomBar.classList.remove("hidden");
    elements.siteFooter.classList.add("hidden");
    state.selected = (!session.yourTurn || session.winner)
      ? []
      : state.selected.filter((cube) => !session.stones.some((stone) => sameCube(stone, cube)));
    state.recentHighlights = highlight ? session.lastTurnStones.slice() : [];

    if (session.turns > previousTurns && highlight && !renderer.cubesAreVisible(session.lastTurnStones)) {
      renderer.centerOnCubes(session.lastTurnStones);
    }

    startClockTicker();
    refreshControls();
    renderer.requestRender();
  };

  const isWithinPlacementRange = (cube: Cube): boolean => (state.session?.stones ?? []).some((stone) => cubeDistance(stone, cube) <= 8);
  const isPlayableCell = (cube: Cube): boolean => Boolean(
    state.session &&
    !state.session.winner &&
    (state.session.mode === "local" || state.session.yourTurn) &&
    state.session.seat !== "spectator" &&
    !state.session.stones.some((stone) => sameCube(stone, cube)) &&
    isWithinPlacementRange(cube),
  );
  const toggleSelected = (cube: Cube): void => {
    const existing = state.selected.findIndex((selectedCube) => sameCube(selectedCube, cube));
    if (existing >= 0) state.selected.splice(existing, 1);
    else if (state.selected.length < 2) state.selected.push(cube);
    refreshControls();
    renderer.requestRender();
  };
  const updateHovered = (x: number, y: number): void => {
    state.hovered = renderer.screenToCube(x, y);
  };

  const startPolling = (): void => {
    stopPolling();
    if (!state.sessionRef) return;
    state.pollTimer = window.setInterval(() => {
      if (!state.sessionRef || shouldPauseNetworkSync()) return;
      loadSessionState(state.sessionRef, state.session?.mode === "local" ? null : state.session).then(applySession).catch((error) => {
        if (!shouldPauseNetworkSync()) elements.turnPill.textContent = error instanceof Error ? error.message : "Connection lost";
      });
    }, POLL_INTERVAL_MS);
  };

  const setMatchmakingState = (queued: boolean, message = queued ? "Searching for an opponent…" : ""): void => {
    state.matchmakingQueued = queued;
    setLobbyError(message);
    updateLobbyButtons();
  };

  const openRemoteSession = (ref: SessionRef, session: SessionView): void => {
    persistSession(ref);
    setMatchmakingState(false, "");
    stopMatchmakingPolling();
    applySession(session);
    startPolling();
  };

  const syncMatchmakingStatus = async (): Promise<boolean> => {
    const status = await loadMatchmakingStatus(state.playerId);
    if (status.status === "matched") {
      openRemoteSession(status.ref, status.session);
      return true;
    }
    setMatchmakingState(status.status === "queued");
    return false;
  };

  const queueMatchmakingFlow = async (): Promise<void> => {
    const status = await queueMatchmaking(state.playerId, state.settings.matchmakingClock);
    if (status.status === "matched") {
      openRemoteSession(status.ref, status.session);
      return;
    }

    setMatchmakingState(status.status === "queued");
    stopMatchmakingPolling();
    if (!state.matchmakingQueued) return;

    state.matchmakingTimer = window.setInterval(() => {
      if (shouldPauseNetworkSync()) return;
      syncMatchmakingStatus().catch((error) => {
        if (shouldPauseNetworkSync()) return;
        setLobbyError(error instanceof Error ? error.message : "Matchmaking failed");
        setMatchmakingState(false, "");
        stopMatchmakingPolling();
      });
    }, POLL_INTERVAL_MS);
  };

  const resumeNetworkFlows = async (): Promise<void> => {
    if (state.sessionRef) {
      try {
        applySession(await loadSessionState(state.sessionRef, state.session?.mode === "local" ? null : state.session));
      } catch {
        // keep saved session for retry
      }
    }
    if (state.matchmakingQueued) {
      try {
        await syncMatchmakingStatus();
      } catch {
        // keep queued state for retry
      }
    }
    refreshControls();
  };

  const startLocalGameFlow = async (): Promise<void> => {
    setLobbyError("");
    persistSession(null);
    const saved = loadLocalGame();
    if (saved) {
      const savedSession = buildLocalState(localBindings, saved.gameJson, saved.clock);
      if (!savedSession.winner && savedSession.turns > 0) {
        if (window.confirm("Resume your saved local game? Press Cancel to start a new one.")) {
          applySession(savedSession);
          return;
        }
        saveLocalGame(null);
      } else if (!savedSession.winner) {
        applySession(savedSession);
        return;
      } else {
        saveLocalGame(null);
      }
    }
    applySession(createFreshLocalSession(localBindings, state.settings.localClock));
  };

  const createPrivateRoomFlow = async (): Promise<void> => {
    setLobbyError("");
    const result = await createPrivateSession(state.playerId, state.settings.privateClock);
    openRemoteSession({ id: result.session.id, code: result.session.code, token: result.token }, result.session);
  };

  const createBotGameFlow = async (): Promise<void> => {
    setLobbyError("");
    const result = await createBotSession(
      state.playerId,
      state.settings.botName,
      state.settings.botHumanSeat,
      state.settings.botClock,
    );
    openRemoteSession({ id: result.session.id, code: result.session.code, token: result.token }, result.session);
  };

  const joinRoomFlow = async (code: string): Promise<void> => {
    setLobbyError("");
    const result = await joinPrivateSession(code, state.sessionRef?.token ?? null, state.playerId);
    openRemoteSession({ id: result.session.id, code: result.session.code, token: result.token }, result.session);
  };

  const cancelMatchmakingFlow = async (): Promise<void> => {
    await cancelMatchmaking(state.playerId);
    stopMatchmakingPolling();
    setMatchmakingState(false, "");
  };

  const runModeFlow = async (mode: SettingsMode): Promise<void> => {
    if (mode === "local") return startLocalGameFlow();
    if (mode === "private") return createPrivateRoomFlow();
    if (mode === "bot") return createBotGameFlow();
    return queueMatchmakingFlow();
  };

  const submitTurnFlow = async (): Promise<void> => {
    if (!state.session || state.selected.length !== 2 || state.pendingSubmit) return;
    state.pendingSubmit = true;
    refreshControls();
    try {
      const nextSession = state.session.mode === "local"
        ? (() => {
            const now = Date.now();
            const snapshot = callLocalPlay(localBindings, state.session.gameJson, state.selected);
            return buildLocalSession(snapshot, advanceLocalClock(state.session.clock, snapshot.current_player, Boolean(snapshot.winner), now), now);
          })()
        : await submitSessionTurn(state.sessionRef!, state.selected);
      state.selected = [];
      applySession(nextSession);
    } catch (error) {
      elements.turnPill.textContent = error instanceof Error ? error.message : "Could not play turn";
    } finally {
      state.pendingSubmit = false;
      refreshControls();
      renderer.requestRender();
    }
  };

  const leaveRoom = (): void => {
    const session = state.session;
    if (!session) return;
    const confirmed = window.confirm(session.mode === "local"
      ? "Leave this local game? It will stay saved on this device so you can resume later."
      : "Leave this session? You can reconnect later from this browser.");
    if (!confirmed) return;
    stopPolling();
    if (session.mode === "local") persistLocalSession();
    else persistSession(null);
    showLobby("");
  };

  const restoreSession = async (): Promise<void> => {
    const savedSessionRef = loadSession();
    const roomCodeFromUrl = loadRoomCodeFromUrl(ROOM_QUERY_PARAM);
    if (savedSessionRef) {
      persistSession(savedSessionRef);
      elements.joinCodeInput.value = savedSessionRef.code ?? "";
      try {
        applySession(await loadSessionState(savedSessionRef));
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

    const localGame = loadLocalGame();
    if (localGame) {
      try {
        applySession(buildLocalState(localBindings, localGame.gameJson, localGame.clock));
        return;
      } catch {
        saveLocalGame(null);
      }
    }

    if (roomCodeFromUrl) {
      elements.joinCodeInput.value = roomCodeFromUrl;
      setLobbyError("Room code restored. Join to reconnect.");
    }
    renderer.resizeCanvas();
    renderer.requestRender();
  };

  return {
    cancelMatchmakingFlow,
    isPlayableCell,
    joinRoomFlow,
    leaveRoom,
    persistLocalSession,
    refreshControls,
    restoreSession,
    resumeNetworkFlows,
    runModeFlow,
    setLobbyError,
    showLobby,
    submitTurnFlow,
    toggleSelected,
    updateHovered,
    updateLobbyButtons,
  };
}
