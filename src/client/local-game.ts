import { EMPTY_GAME_JSON } from "../domain/types.js";
import type { ClockSettings, ClockState, Cube, EngineSnapshot, SessionView } from "../domain/types.js";
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

function createLocalClock(clock: ClockSettings, now: number): ClockState {
  return {
    enabled: true,
    type: "chess",
    initialMs: clock.initialMs,
    incrementMs: clock.incrementMs,
    activeSeat: "two",
    turnStartedAt: now,
    remainingMs: {
      one: clock.initialMs,
      two: clock.initialMs,
    },
    flaggedSeat: null,
  };
}

function normalizeLocalClock(snapshot: EngineSnapshot, savedClock: ClockState | null): ClockState | null {
  if (!savedClock?.enabled) {
    return null;
  }

  const clock = cloneClock(savedClock);
  if (!clock) {
    return null;
  }

  clock.type = "chess";
  if (snapshot.winner) {
    clock.activeSeat = null;
    clock.turnStartedAt = null;
    clock.flaggedSeat = null;
    return clock;
  }

  const expectedSeat = playerSeat(snapshot.current_player);
  if (!clock.activeSeat || clock.activeSeat !== expectedSeat) {
    clock.activeSeat = expectedSeat;
    clock.turnStartedAt ??= Date.now();
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
    positionId: String(now),
    currentActor: null,
    latestEval: null,
    pendingRemoteMove: false,
    lastRemoteError: null,
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
  return buildLocalSession(snapshot, normalizeLocalClock(snapshot, savedClock), now);
}

export function createFreshLocalSession(localBindings: LocalBindings, clock: ClockSettings | null): SessionView {
  const now = Date.now();
  const snapshot = callLocalSnapshot(localBindings, EMPTY_GAME_JSON);
  return buildLocalSession(snapshot, clock ? createLocalClock(clock, now) : null, now);
}

function currentRemainingMs(clock: ClockState, seat: "one" | "two", now: number): number {
  if (clock.activeSeat !== seat || clock.turnStartedAt === null) {
    return clock.remainingMs[seat];
  }
  return Math.max(0, clock.remainingMs[seat] - (now - clock.turnStartedAt));
}

export function finishLocalClockIfExpired(session: SessionView | null, now = Date.now()): boolean {
  if (!session || session.mode !== "local") {
    return false;
  }

  const clock = session.clock;
  if (!clock?.enabled || !clock.activeSeat || clock.turnStartedAt === null || session.winner) {
    return false;
  }

  const remaining = currentRemainingMs(clock, clock.activeSeat, now);
  if (remaining > 0) {
    return false;
  }

  clock.remainingMs[clock.activeSeat] = 0;
  clock.flaggedSeat = clock.activeSeat;
  clock.activeSeat = null;
  clock.turnStartedAt = null;
  session.status = "finished";
  session.resultReason = "timeout";
  session.winner = clock.flaggedSeat === "one" ? "Two" : "One";
  session.yourTurn = false;
  session.serverNow = now;
  session.positionId = String(now);
  return true;
}

export function advanceLocalClock(clock: ClockState | null, nextPlayer: Player, gameWon: boolean, now: number): ClockState | null {
  if (!clock?.enabled || !clock.activeSeat) {
    return null;
  }

  const nextClock = cloneClock(clock);
  if (!nextClock?.activeSeat) {
    return null;
  }

  const movingSeat = nextClock.activeSeat;
  nextClock.remainingMs[movingSeat] = currentRemainingMs(nextClock, movingSeat, now);
  if (gameWon) {
    nextClock.activeSeat = null;
    nextClock.turnStartedAt = null;
    nextClock.flaggedSeat = null;
    return nextClock;
  }

  nextClock.remainingMs[movingSeat] += nextClock.incrementMs;
  nextClock.activeSeat = playerSeat(nextPlayer);
  nextClock.turnStartedAt = now;
  nextClock.flaggedSeat = null;
  return nextClock;
}
