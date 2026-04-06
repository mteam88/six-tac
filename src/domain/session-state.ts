import type {
  ClockSettings,
  CurrentActor,
  Cube,
  EngineSnapshot,
  HumanSeat,
  Participant,
  Player,
  PositionEval,
  Seat,
  SessionData,
  SessionMode,
  SessionView,
} from "./types";

export function cubeKey(cube: Cube): string {
  return `${cube.x},${cube.y},${cube.z}`;
}

export function createToken(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

export function randomInt(maxExclusive: number): number {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return values[0] % maxExclusive;
}

export function generateCode(): string {
  return String(randomInt(1_000_000)).padStart(6, "0");
}

export function playerForSeat(seat: Seat | HumanSeat): Player | null {
  if (seat === "one") return "One";
  if (seat === "two") return "Two";
  return null;
}

export function seatForPlayer(player: Player): HumanSeat {
  return player === "One" ? "one" : "two";
}

export function otherSeat(seat: HumanSeat): HumanSeat {
  return seat === "one" ? "two" : "one";
}

export function getLastTurnInfo(turnsJson: string): { lastTurnPlayer: Player | null; lastTurnStones: Cube[] } {
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

export function participantForSeat(session: SessionData, seat: HumanSeat): Participant | null {
  return session.participants.find((participant) => participant.seat === seat) ?? null;
}

export function getSeatForToken(session: SessionData, token: string | null): Seat {
  if (!token) return "spectator";
  for (const participant of session.participants) {
    if (participant.kind === "human" && participant.token === token) {
      return participant.seat;
    }
  }
  return "spectator";
}

export function getHumanSeatCount(session: SessionData): number {
  return session.participants.filter((participant) => participant.kind === "human").length;
}

export function isSessionReady(session: SessionData): boolean {
  if (session.type === "private") {
    return Boolean(participantForSeat(session, "one") && participantForSeat(session, "two"));
  }
  return true;
}

export function createClockSettings(initialMs: number | null, incrementMs = 0): ClockSettings | null {
  if (!initialMs || initialMs <= 0) return null;
  return {
    initialMs,
    incrementMs: Math.max(0, incrementMs),
  };
}

export function cloneClock<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function getEffectiveWinner(session: SessionData, snapshot: EngineSnapshot): Player | null {
  return session.result?.winner ?? snapshot.winner;
}

export function getResultReason(session: SessionData): SessionView["resultReason"] {
  return session.result?.reason ?? null;
}

export function currentActor(session: SessionData, snapshot: EngineSnapshot): CurrentActor | null {
  const seat = seatForPlayer(snapshot.current_player);
  const participant = participantForSeat(session, seat);
  if (!participant) {
    return null;
  }

  if (participant.kind === "human") {
    return {
      seat,
      kind: "human",
      botName: null,
      execution: null,
    };
  }

  return {
    seat,
    kind: "bot",
    botName: participant.botConfig?.name ?? null,
    execution: participant.botConfig?.execution ?? "remote",
  };
}

export function canTokenControlCurrentTurn(session: SessionData, snapshot: EngineSnapshot, token: string | null): boolean {
  if (!token || session.status !== "active" || getEffectiveWinner(session, snapshot)) {
    return false;
  }

  const actor = currentActor(session, snapshot);
  if (!actor) {
    return false;
  }

  if (actor.kind === "human") {
    return getSeatForToken(session, token) === actor.seat;
  }

  if (actor.execution !== "browser" || session.type !== "bot") {
    return false;
  }

  return session.participants.some((participant) => participant.kind === "human" && participant.token === token);
}

export function buildSessionView(
  session: SessionData,
  snapshot: EngineSnapshot,
  seat: Seat,
  options: {
    token: string | null;
    positionId: string;
    latestEval: PositionEval | null;
    pendingRemoteMove: boolean;
    lastRemoteError: string | null;
    now?: number;
  },
): SessionView {
  const lastTurn = getLastTurnInfo(snapshot.turns_json);
  const effectiveWinner = getEffectiveWinner(session, snapshot);
  const ready = isSessionReady(session);
  const now = options.now ?? Date.now();

  return {
    id: session.id,
    code: session.code,
    mode: session.type,
    seat,
    status: session.status,
    currentPlayer: snapshot.current_player,
    currentActor: currentActor(session, snapshot),
    winner: effectiveWinner,
    resultReason: getResultReason(session),
    yourTurn: Boolean(ready && canTokenControlCurrentTurn(session, snapshot, options.token)),
    turns: snapshot.turn_count,
    stones: snapshot.stones,
    lastTurnPlayer: lastTurn.lastTurnPlayer,
    lastTurnStones: lastTurn.lastTurnStones,
    gameJson: snapshot.turns_json,
    clock: session.clock ? cloneClock(session.clock) : null,
    serverNow: now,
    positionId: options.positionId,
    latestEval: options.latestEval,
    pendingRemoteMove: options.pendingRemoteMove,
    lastRemoteError: options.lastRemoteError,
  };
}

export function buildLocalSessionView(snapshot: EngineSnapshot, now = Date.now()): SessionView {
  const lastTurn = getLastTurnInfo(snapshot.turns_json);
  return {
    id: "local",
    code: null,
    mode: "local",
    seat: "local",
    status: snapshot.winner ? "finished" : "active",
    currentPlayer: snapshot.current_player,
    currentActor: null,
    winner: snapshot.winner,
    resultReason: snapshot.winner ? "win" : null,
    yourTurn: !snapshot.winner,
    turns: snapshot.turn_count,
    stones: snapshot.stones,
    lastTurnPlayer: lastTurn.lastTurnPlayer,
    lastTurnStones: lastTurn.lastTurnStones,
    gameJson: snapshot.turns_json,
    clock: null,
    serverNow: now,
    positionId: String(now),
    latestEval: null,
    pendingRemoteMove: false,
    lastRemoteError: null,
  };
}

export function finishSession(
  session: SessionData,
  winner: Player | null,
  reason: SessionView["resultReason"],
  now: number,
): void {
  session.status = reason === "abandoned" ? "abandoned" : "finished";
  session.result = {
    winner,
    reason,
  };
  session.updatedAt = now;
  if (session.clock) {
    session.clock.activeSeat = null;
    session.clock.turnStartedAt = null;
  }
}

export function applySnapshotResult(session: SessionData, snapshot: EngineSnapshot, now: number): boolean {
  if (!snapshot.winner) {
    return false;
  }

  if (session.result?.winner === snapshot.winner && session.result.reason === "win") {
    return false;
  }

  finishSession(session, snapshot.winner, "win", now);
  return true;
}

export function createSession(
  params: {
    id: string;
    code: string | null;
    type: SessionMode;
    participants: Participant[];
    clock: ClockSettings | null;
    active: boolean;
  },
  now = Date.now(),
): SessionData {
  const clock = params.clock && params.clock.initialMs > 0
    ? {
        initialMs: params.clock.initialMs,
        incrementMs: Math.max(0, params.clock.incrementMs),
      }
    : null;
  return {
    id: params.id,
    code: params.code,
    type: params.type,
    status: params.active ? "active" : "waiting",
    version: 0,
    createdAt: now,
    updatedAt: now,
    turnsJson: '{"turns":[]}',
    participants: params.participants,
    clock: clock
      ? {
          enabled: true,
          type: "chess",
          initialMs: clock.initialMs,
          incrementMs: clock.incrementMs,
          activeSeat: null,
          turnStartedAt: null,
          remainingMs: {
            one: clock.initialMs,
            two: clock.initialMs,
          },
          flaggedSeat: null,
        }
      : null,
    result: null,
  };
}
