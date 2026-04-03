import { EMPTY_GAME_JSON } from "../domain/types.js";
import type { ClockState, Cube, EngineSnapshot, SessionView } from "../domain/types.js";
import type { LocalBindings, Player } from "./app-types.js";
import { cloneClock, playerSeat } from "./helpers.js";

function buildLastTurn(snapshot: EngineSnapshot): { lastTurnPlayer: Player | null; lastTurnStones: Cube[] } {
  const parsed = JSON.parse(snapshot.turns_json) as { turns?: Array<{ stones?: Cube[] }> };
  const turns = parsed.turns ?? [];
  if (turns.length === 0) {
    return { lastTurnPlayer: null, lastTurnStones: [] };
  }
  return {
    lastTurnPlayer: (turns.length - 1) % 2 === 0 ? "Two" : "One",
    lastTurnStones: turns[turns.length - 1].stones ?? [],
  };
}

export function createLocalMoveClock(initialMs: number, now: number): ClockState {
  return {
    enabled: true,
    type: "move",
    initialMs,
    incrementMs: 0,
    activeSeat: "two",
    turnStartedAt: now,
    remainingMs: { one: initialMs, two: initialMs },
    flaggedSeat: null,
  };
}

export function normalizeLocalClock(snapshot: EngineSnapshot, savedClock: ClockState | null, now: number): ClockState | null {
  if (!savedClock?.enabled) return null;
  const clock = cloneClock(savedClock);
  if (!clock) return null;

  clock.type = "move";
  clock.incrementMs = 0;
  clock.remainingMs.one = clock.initialMs;
  clock.remainingMs.two = clock.initialMs;

  if (snapshot.winner) {
    clock.activeSeat = null;
    clock.turnStartedAt = null;
    clock.flaggedSeat = null;
    return clock;
  }

  const expectedSeat = playerSeat(snapshot.current_player);
  if (clock.activeSeat !== expectedSeat || clock.turnStartedAt === null) {
    clock.activeSeat = expectedSeat;
    clock.turnStartedAt = now;
  }
  return clock;
}

export function buildLocalSession(snapshot: EngineSnapshot, clock: ClockState | null, now = Date.now()): SessionView {
  const lastTurn = buildLastTurn(snapshot);
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
    clock,
    serverNow: now,
  };
}

export function callLocalSnapshot(localBindings: LocalBindings, gameJson: string): EngineSnapshot {
  return JSON.parse(localBindings.snapshotJson(gameJson)) as EngineSnapshot;
}

export function callLocalPlay(localBindings: LocalBindings, gameJson: string, stones: Cube[]): EngineSnapshot {
  return JSON.parse(localBindings.playJson(gameJson, JSON.stringify(stones))) as EngineSnapshot;
}

export function buildLocalState(localBindings: LocalBindings, gameJson: string, savedClock: ClockState | null): SessionView {
  const now = Date.now();
  const snapshot = callLocalSnapshot(localBindings, gameJson);
  return buildLocalSession(snapshot, normalizeLocalClock(snapshot, savedClock, now), now);
}

export function createFreshLocalSession(localBindings: LocalBindings, timerMs: number | null): SessionView {
  const now = Date.now();
  const snapshot = callLocalSnapshot(localBindings, EMPTY_GAME_JSON);
  const clock = timerMs ? createLocalMoveClock(timerMs, now) : null;
  return buildLocalSession(snapshot, clock, now);
}

export function finishLocalTimerIfExpired(session: SessionView | null): boolean {
  if (!session || session.mode !== "local") return false;
  const clock = session.clock;
  if (!clock?.enabled || clock.type !== "move" || session.winner || !clock.activeSeat || clock.turnStartedAt === null) {
    return false;
  }

  const remaining = clock.initialMs - (Date.now() - clock.turnStartedAt);
  if (remaining > 0) return false;

  clock.remainingMs[clock.activeSeat] = 0;
  clock.flaggedSeat = clock.activeSeat;
  clock.activeSeat = null;
  clock.turnStartedAt = null;
  session.status = "finished";
  session.resultReason = "timeout";
  session.winner = clock.flaggedSeat === "one" ? "Two" : "One";
  session.yourTurn = false;
  return true;
}

export function advanceLocalClock(clock: ClockState | null, nextPlayer: Player, gameWon: boolean, now: number): ClockState | null {
  if (!clock?.enabled || clock.type !== "move") return null;
  const nextClock = cloneClock(clock);
  if (!nextClock) return null;
  if (gameWon) {
    nextClock.activeSeat = null;
    nextClock.turnStartedAt = null;
    nextClock.flaggedSeat = null;
    return nextClock;
  }

  nextClock.activeSeat = playerSeat(nextPlayer);
  nextClock.turnStartedAt = now;
  nextClock.flaggedSeat = null;
  nextClock.remainingMs.one = nextClock.initialMs;
  nextClock.remainingMs.two = nextClock.initialMs;
  return nextClock;
}
