import { DurableObject } from "cloudflare:workers";
import { clientAddress, json, readJson } from "../api/utils";
import { createBestMoveJob } from "../compute-jobs";
import { completeMove, expireSessionOnClock, getDeadlineAt, startClock } from "../domain/clock";
import { positionIdForTurnsJson } from "../domain/position";
import {
  applySnapshotResult,
  buildSessionView,
  canTokenControlCurrentTurn,
  createToken,
  getSeatForToken,
  isSessionReady,
  participantForSeat,
  playerForSeat,
  seatForPlayer,
} from "../domain/session-state";
import type { BotName, Cube, EngineSnapshot, HumanSeat, PositionEval, SessionData, Seat } from "../domain/types";
import type { Env } from "../env";
import { play_json, snapshot_json } from "../engine";
import { FixedWindowRateLimiter, rateLimitKey } from "./rate-limit";

const SESSION_STATE_LIMIT = {
  limit: 240,
  windowMs: 60_000,
  retryAfterSeconds: 15,
};

const SESSION_JOIN_LIMIT = {
  limit: 15,
  windowMs: 60_000,
  retryAfterSeconds: 30,
};

type StoredSessionData = SessionData & {
  snapshot: EngineSnapshot;
  headPositionId: string;
  pendingRemoteMoveJobId: string | null;
  pendingRemoteMoveBasePositionId: string | null;
  latestEval: PositionEval | null;
  lastRemoteError: string | null;
};

type LegacyRoomData = {
  code: string;
  turnsJson: string;
  seats: {
    one: string | null;
    two: string | null;
  };
};

function callSnapshot(gameJson: string): EngineSnapshot {
  return JSON.parse(snapshot_json(gameJson)) as EngineSnapshot;
}

function callPlay(gameJson: string, stones: Cube[]): EngineSnapshot {
  if (stones.length !== 2) {
    throw new Error("A turn must contain exactly 2 stones");
  }
  return JSON.parse(play_json(gameJson, JSON.stringify(stones))) as EngineSnapshot;
}

function tooManyRequests(retryAfterSeconds: number): Response {
  return json(
    { error: "Too many requests. Please slow down." },
    429,
    { "Retry-After": String(retryAfterSeconds) },
  );
}

function isStoredSessionData(value: Record<string, unknown>): boolean {
  return typeof value.headPositionId === "string";
}

function isPositionEval(value: unknown): value is PositionEval {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.positionId === "string"
    && typeof candidate.score === "number"
    && typeof candidate.winProb === "number"
    && typeof candidate.updatedAt === "number";
}

function normalizeParticipants(session: SessionData): SessionData["participants"] {
  return session.participants.map((participant) => {
    if (participant.kind !== "bot" || !participant.botConfig) {
      return participant;
    }
    return {
      ...participant,
      botConfig: {
        ...participant.botConfig,
        execution: participant.botConfig.execution === "worker" ? "browser" : participant.botConfig.execution,
      },
    };
  });
}

export class SessionObject extends DurableObject<Env> {
  private readonly rateLimiter = new FixedWindowRateLimiter();

  private async buildStoredSession(session: SessionData): Promise<StoredSessionData> {
    const snapshot = callSnapshot(session.turnsJson);
    return {
      ...session,
      participants: normalizeParticipants(session),
      snapshot,
      headPositionId: await positionIdForTurnsJson(session.turnsJson),
      pendingRemoteMoveJobId: null,
      pendingRemoteMoveBasePositionId: null,
      latestEval: null,
      lastRemoteError: null,
    };
  }

  private async loadSession(): Promise<StoredSessionData | null> {
    const stored = await this.ctx.storage.get<Record<string, unknown>>("session");
    if (stored) {
      const turnsJson = typeof stored.turnsJson === "string" ? stored.turnsJson : '{"turns":[]}';
      const snapshot = (stored.snapshot as EngineSnapshot | undefined) ?? callSnapshot(turnsJson);
      const session = {
        ...(stored as SessionData),
        participants: normalizeParticipants(stored as SessionData),
        turnsJson,
        snapshot,
        headPositionId: isStoredSessionData(stored)
          ? stored.headPositionId as string
          : await positionIdForTurnsJson(turnsJson),
        pendingRemoteMoveJobId: typeof stored.pendingRemoteMoveJobId === "string" ? stored.pendingRemoteMoveJobId : null,
        pendingRemoteMoveBasePositionId: typeof stored.pendingRemoteMoveBasePositionId === "string"
          ? stored.pendingRemoteMoveBasePositionId
          : null,
        latestEval: isPositionEval(stored.latestEval) ? stored.latestEval : null,
        lastRemoteError: typeof stored.lastRemoteError === "string" ? stored.lastRemoteError : null,
      } satisfies StoredSessionData;
      await this.ctx.storage.put("session", session);
      return session;
    }

    const legacyRoom = await this.ctx.storage.get<LegacyRoomData>("room");
    if (!legacyRoom) {
      return null;
    }

    const snapshot = callSnapshot(legacyRoom.turnsJson);
    const now = Date.now();
    const migrated: StoredSessionData = {
      id: legacyRoom.code,
      code: legacyRoom.code,
      type: "private",
      status: snapshot.winner
        ? "finished"
        : legacyRoom.seats.one && legacyRoom.seats.two
          ? "active"
          : "waiting",
      version: snapshot.turn_count,
      createdAt: now,
      updatedAt: now,
      turnsJson: legacyRoom.turnsJson,
      participants: [
        ...(legacyRoom.seats.one
          ? [{ id: `legacy-one-${legacyRoom.seats.one.slice(0, 8)}`, kind: "human" as const, seat: "one" as const, token: legacyRoom.seats.one, playerId: null }]
          : []),
        ...(legacyRoom.seats.two
          ? [{ id: `legacy-two-${legacyRoom.seats.two.slice(0, 8)}`, kind: "human" as const, seat: "two" as const, token: legacyRoom.seats.two, playerId: null }]
          : []),
      ],
      clock: null,
      result: snapshot.winner ? { winner: snapshot.winner, reason: "win" } : null,
      snapshot,
      headPositionId: await positionIdForTurnsJson(legacyRoom.turnsJson),
      pendingRemoteMoveJobId: null,
      pendingRemoteMoveBasePositionId: null,
      latestEval: null,
      lastRemoteError: null,
    };

    await this.ctx.storage.put("session", migrated);
    return migrated;
  }

  private async saveSession(session: StoredSessionData): Promise<void> {
    await this.ctx.storage.put("session", session);
    await this.syncAlarm(session);
  }

  private async syncAlarm(session: StoredSessionData): Promise<void> {
    if (session.status !== "active" || session.result) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    const deadlineAt = getDeadlineAt(session.clock);
    if (deadlineAt === null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    await this.ctx.storage.setAlarm(deadlineAt);
  }

  private ensureActiveClock(session: StoredSessionData, snapshot: EngineSnapshot, now: number): void {
    if (!session.clock?.enabled || session.result || session.status !== "active") {
      return;
    }
    if (session.clock.activeSeat) {
      return;
    }
    const seat = snapshot.current_player === "One" ? "one" : "two";
    startClock(session.clock, seat, now);
  }

  private async maybeExpireSession(session: StoredSessionData): Promise<void> {
    const now = Date.now();
    if (expireSessionOnClock(session, now)) {
      session.pendingRemoteMoveJobId = null;
      session.pendingRemoteMoveBasePositionId = null;
      session.updatedAt = now;
      await this.saveSession(session);
    }
  }

  private getCurrentRemoteBot(session: StoredSessionData): { botName: BotName; seat: HumanSeat } | null {
    if (session.status !== "active" || session.result) {
      return null;
    }

    const seat = seatForPlayer(session.snapshot.current_player);
    const participant = participantForSeat(session, seat);
    if (participant?.kind !== "bot" || participant.botConfig?.execution !== "remote" || !participant.botConfig.name) {
      return null;
    }

    return { botName: participant.botConfig.name, seat };
  }

  private async ensureRemoteTurnScheduled(session: StoredSessionData): Promise<void> {
    const participant = this.getCurrentRemoteBot(session);
    if (!participant) {
      session.pendingRemoteMoveJobId = null;
      session.pendingRemoteMoveBasePositionId = null;
      return;
    }

    if (session.pendingRemoteMoveBasePositionId === session.headPositionId && session.pendingRemoteMoveJobId) {
      return;
    }

    const job = await createBestMoveJob(this.env, {
      position: { turnsJson: session.turnsJson },
      config: { botName: participant.botName },
      cacheKey: session.id,
    }, {
      type: "session-remote-move",
      sessionId: session.id,
      basePositionId: session.headPositionId,
    });

    session.pendingRemoteMoveJobId = job.id;
    session.pendingRemoteMoveBasePositionId = session.headPositionId;
    session.lastRemoteError = null;
    session.updatedAt = Date.now();
    await this.saveSession(session);
  }

  private async buildView(session: StoredSessionData, token: string | null, now = Date.now()) {
    await this.maybeExpireSession(session);
    const seat = getSeatForToken(session, token);
    return {
      seat,
      view: buildSessionView(session, session.snapshot, seat, {
        token,
        positionId: session.headPositionId,
        latestEval: session.latestEval,
        pendingRemoteMove: session.pendingRemoteMoveBasePositionId === session.headPositionId,
        lastRemoteError: session.lastRemoteError,
        now,
      }),
    };
  }

  private takeRateLimit(key: string, limit: { limit: number; windowMs: number; retryAfterSeconds: number }): Response | null {
    if (this.rateLimiter.consume(key, limit.limit, limit.windowMs)) {
      return null;
    }
    return tooManyRequests(limit.retryAfterSeconds);
  }

  private async applyCommittedMove(session: StoredSessionData, nextSnapshot: EngineSnapshot, now: number): Promise<void> {
    session.turnsJson = nextSnapshot.turns_json;
    session.snapshot = nextSnapshot;
    session.headPositionId = await positionIdForTurnsJson(nextSnapshot.turns_json);
    session.version = nextSnapshot.turn_count;
    session.pendingRemoteMoveJobId = null;
    session.pendingRemoteMoveBasePositionId = null;
    session.latestEval = null;
    session.lastRemoteError = null;
    session.updatedAt = now;
    if (!applySnapshotResult(session, nextSnapshot, now)) {
      const nextSeat: HumanSeat = nextSnapshot.current_player === "One" ? "one" : "two";
      completeMove(session.clock, nextSeat, now);
    }
    await this.saveSession(session);
    try {
      await this.ensureRemoteTurnScheduled(session);
    } catch (error) {
      session.lastRemoteError = error instanceof Error ? error.message : String(error);
      session.updatedAt = Date.now();
      await this.saveSession(session);
    }
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const existingSession = await this.loadSession();

      if (request.method === "POST" && url.pathname === "/internal/init") {
        if (existingSession) {
          return json({ error: "Session already exists" }, 409);
        }

        const session = await readJson<SessionData>(request);
        const storedSession = await this.buildStoredSession(session);
        this.ensureActiveClock(storedSession, storedSession.snapshot, Date.now());
        await this.saveSession(storedSession);
        try {
          await this.ensureRemoteTurnScheduled(storedSession);
        } catch (error) {
          storedSession.lastRemoteError = error instanceof Error ? error.message : String(error);
          storedSession.updatedAt = Date.now();
          await this.saveSession(storedSession);
        }
        return json({ ok: true }, 201);
      }

      if (!existingSession) {
        return json({ error: "Session not found" }, 404);
      }

      const session = existingSession;

      if (request.method === "POST" && url.pathname === "/internal/apply-remote-move") {
        await this.maybeExpireSession(session);
        const body = await readJson<{ basePositionId?: string; stones?: Cube[] }>(request);
        if (
          session.status !== "active"
          || session.result
          || session.headPositionId !== body.basePositionId
          || !Array.isArray(body.stones)
          || body.stones.length !== 2
          || !this.getCurrentRemoteBot(session)
        ) {
          return json({ applied: false });
        }

        const now = Date.now();
        const nextSnapshot = callPlay(session.turnsJson, body.stones);
        await this.applyCommittedMove(session, nextSnapshot, now);
        return json({ applied: true });
      }

      if (request.method === "POST" && url.pathname === "/internal/remote-move-failed") {
        const body = await readJson<{ basePositionId?: string; error?: string }>(request);
        if (session.headPositionId === body.basePositionId && this.getCurrentRemoteBot(session)) {
          session.lastRemoteError = String(body.error || "Remote bot turn failed");
          session.updatedAt = Date.now();
          await this.saveSession(session);
        }
        return json({ ok: true });
      }

      if (request.method === "POST" && url.pathname === "/internal/apply-eval") {
        const body = await readJson<{ positionId?: string; score?: number; winProb?: number; bestMove?: [Cube, Cube] | null }>(request);
        if (session.headPositionId !== body.positionId) {
          return json({ applied: false });
        }
        if (!Number.isFinite(body.score) || !Number.isFinite(body.winProb)) {
          return json({ applied: false });
        }
        session.latestEval = {
          positionId: body.positionId!,
          score: Number(body.score),
          winProb: Number(body.winProb),
          bestMove: Array.isArray(body.bestMove) ? body.bestMove : null,
          updatedAt: Date.now(),
        };
        session.updatedAt = Date.now();
        await this.saveSession(session);
        return json({ applied: true });
      }

      if (request.method === "POST" && url.pathname === "/join") {
        const body = await readJson<{ token?: string | null; playerId?: string | null }>(request);
        const limited = this.takeRateLimit(
          rateLimitKey("join", clientAddress(request), body.token ?? body.playerId ?? "guest"),
          SESSION_JOIN_LIMIT,
        );
        if (limited) {
          return limited;
        }

        const incomingToken = body.token ?? null;
        const existingSeat = getSeatForToken(session, incomingToken);
        if (existingSeat !== "spectator" && incomingToken) {
          const { view } = await this.buildView(session, incomingToken);
          return json({ token: incomingToken, session: view });
        }

        if (session.type !== "private") {
          return json({ error: "This session cannot be joined by room code" }, 400);
        }

        let seat: HumanSeat | null = null;
        if (!participantForSeat(session, "one")) {
          seat = "one";
        } else if (!participantForSeat(session, "two")) {
          seat = "two";
        }

        const token = createToken();
        if (seat) {
          session.participants.push({
            id: body.playerId || crypto.randomUUID(),
            kind: "human",
            seat,
            token,
            playerId: body.playerId ?? null,
          });
          if (isSessionReady(session) && session.status === "waiting") {
            session.status = "active";
            this.ensureActiveClock(session, session.snapshot, Date.now());
          }
          session.updatedAt = Date.now();
          await this.saveSession(session);
          const { view } = await this.buildView(session, token);
          return json({ token, session: view });
        }

        const { view } = await this.buildView(session, token);
        return json({ token, session: view });
      }

      if (request.method === "GET" && url.pathname === "/state") {
        const token = url.searchParams.get("token");
        const limited = this.takeRateLimit(
          rateLimitKey("state", clientAddress(request), token ?? "spectator"),
          SESSION_STATE_LIMIT,
        );
        if (limited) {
          return limited;
        }

        await this.maybeExpireSession(session);
        const seat = getSeatForToken(session, token);
        const knownPositionId = url.searchParams.get("knownPositionId");
        const knownSeat = url.searchParams.get("seat");
        if (knownPositionId && knownPositionId === session.headPositionId && knownSeat === seat) {
          return json({
            unchanged: true,
            seat,
            serverNow: Date.now(),
            positionId: session.headPositionId,
          });
        }

        return json((await this.buildView(session, token)).view);
      }

      if (request.method === "POST" && url.pathname === "/moves") {
        const body = await readJson<{ token?: string | null; basePositionId?: string; stones?: Cube[] }>(request);
        const token = body.token ?? null;
        const seat = getSeatForToken(session, token);
        if (seat === "spectator") {
          return json({ error: "You are not seated in this session" }, 403);
        }

        const now = Date.now();
        const snapshot = session.snapshot;
        this.ensureActiveClock(session, snapshot, now);
        if (expireSessionOnClock(session, now)) {
          session.pendingRemoteMoveJobId = null;
          session.pendingRemoteMoveBasePositionId = null;
          session.updatedAt = now;
          await this.saveSession(session);
          return json({ error: "Time has already expired for this turn" }, 400);
        }
        if (session.status !== "active") {
          return json({ error: "Session is not active" }, 400);
        }
        if (session.result || snapshot.winner) {
          return json({ error: "Game is already over" }, 400);
        }
        if (session.headPositionId !== body.basePositionId) {
          return json({ error: "Position has advanced. Refresh and try again." }, 409);
        }
        if (!canTokenControlCurrentTurn(session, snapshot, token)) {
          return json({ error: "You cannot act for the current turn" }, 403);
        }
        if (!Array.isArray(body.stones) || body.stones.length !== 2) {
          return json({ error: "A turn must contain exactly 2 stones" }, 400);
        }

        const nextSnapshot = callPlay(session.turnsJson, body.stones);
        await this.applyCommittedMove(session, nextSnapshot, now);
        return json((await this.buildView(session, token, now)).view);
      }

      return json({ error: "Not found" }, 404);
    } catch (error) {
      console.error("SessionObject error", error);
      return json({ error: typeof error === "string" ? error : error instanceof Error ? error.message : "Unknown error" }, 400);
    }
  }

  async alarm(): Promise<void> {
    const session = await this.loadSession();
    if (!session) {
      return;
    }

    const now = Date.now();
    this.ensureActiveClock(session, session.snapshot, now);
    if (expireSessionOnClock(session, now)) {
      session.pendingRemoteMoveJobId = null;
      session.pendingRemoteMoveBasePositionId = null;
      session.updatedAt = now;
      await this.saveSession(session);
      return;
    }

    await this.syncAlarm(session);
  }
}
