import type { AppState } from "./app-types.js";
import type { AppElements } from "./dom.js";
import { formatClock, formatRoomCode } from "./helpers.js";
import { finishLocalClockIfExpired } from "./local-game.js";

export function currentSessionLabel(session: AppState["session"]): string {
  if (!session) return "—";
  if (session.mode === "local") return "local";
  if (session.code) return formatRoomCode(session.code);
  return session.mode === "bot" ? "bot" : session.mode === "matchmade" ? "match" : "game";
}

export function currentClockTimes(state: AppState): { one: number; two: number } {
  const session = state.session;
  const clock = session?.clock;
  if (!session || !clock?.enabled) return { one: 0, two: 0 };

  const now = session.mode === "local" ? Date.now() : Date.now() + state.serverClockOffsetMs;
  return {
    one: clock.activeSeat === "one" && clock.turnStartedAt !== null
      ? Math.max(0, clock.remainingMs.one - (now - clock.turnStartedAt))
      : clock.remainingMs.one,
    two: clock.activeSeat === "two" && clock.turnStartedAt !== null
      ? Math.max(0, clock.remainingMs.two - (now - clock.turnStartedAt))
      : clock.remainingMs.two,
  };
}

export function updateControls(state: AppState, elements: AppElements): boolean {
  const session = state.session;
  if (!session) {
    elements.bottomBar.classList.add("hidden");
    return false;
  }

  const timerExpired = finishLocalClockIfExpired(session);
  elements.bottomBar.classList.remove("hidden");
  elements.roomCodePill.textContent = currentSessionLabel(session);
  elements.copyRoomButton.classList.toggle("hidden", !session.code);
  elements.copyRoomButton.dataset.player = session.currentPlayer;

  if (session.winner) {
    elements.turnPill.textContent = session.resultReason === "timeout"
      ? session.winner === "One" ? "red won on time" : "blue won on time"
      : session.winner === "One" ? "red won" : "blue won";
  } else if (session.status === "waiting") {
    elements.turnPill.textContent = "waiting for opponent";
  } else {
    elements.turnPill.textContent = session.currentPlayer === "One" ? "red to move" : "blue to move";
  }

  if (session.clock?.enabled) {
    const times = currentClockTimes(state);
    elements.clockOneTime.textContent = formatClock(times.one);
    elements.clockTwoTime.textContent = formatClock(times.two);
    elements.clockPanel.classList.remove("hidden");
    elements.clockOneCard.classList.toggle("clock-card-active", session.clock.activeSeat === "one");
    elements.clockTwoCard.classList.toggle("clock-card-active", session.clock.activeSeat === "two");
    elements.clockOneCard.classList.toggle("clock-card-critical", times.one <= 15_000);
    elements.clockTwoCard.classList.toggle("clock-card-critical", times.two <= 15_000);
  } else {
    elements.clockPanel.classList.add("hidden");
    elements.clockOneCard.classList.remove("clock-card-active", "clock-card-critical");
    elements.clockTwoCard.classList.remove("clock-card-active", "clock-card-critical");
  }

  const canPlay = session.mode === "local"
    ? !session.winner
    : session.yourTurn && !session.winner && (session.seat === "one" || session.seat === "two");
  elements.submitLabel.textContent = state.pendingSubmit ? "Playing" : "Play";
  elements.submitTurnButton.disabled = !canPlay || state.selected.length !== 2 || state.pendingSubmit;
  return timerExpired;
}
