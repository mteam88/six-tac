import { DurableObject } from "cloudflare:workers";
import { clientAddress, json, readJson } from "../api/utils";
import { completeMove, expireSessionOnClock, getDeadlineAt, startClock } from "../domain/clock";
import {
  applySnapshotResult,
  buildSessionView,
  createToken,
  getSeatForToken,
  isSessionReady,
  participantForSeat,
  playerForSeat,
} from "../domain/session-state";
import type { BotName, Cube, EngineSnapshot, HumanSeat, SessionData, Seat } from "../domain/types";
import type { Env } from "../env";
import type { BotTurnJob } from "../bot-turn-queue";
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

type PendingBotJob = {
  version: number;
  botName: BotName;
  enqueuedAt: number;
};

type StoredSessionData = SessionData & {
  snapshot: EngineSnapshot;
  pendingBotJob: PendingBotJob | null;
  lastBotError: string | null;
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

export class SessionObject extends DurableObject<Env> {
  private readonly rateLimiter = new FixedWindowRateLimiter();

  private async loadSession(): Promise<StoredSessionData | null> {
    const stored = await this.ctx.storage.get<Record<string, unknown>>("session");
    if (stored) {
      const turnsJson = typeof stored.turnsJson === "string" ? stored.turnsJson : '{"turns":[]}';
      const snapshot = (stored.snapshot as EngineSnapshot | undefined) ?? callSnapshot(turnsJson);
      const version = typeof stored.version === "number" ? stored.version : snapshot.turn_count;
      const migrated: StoredSessionData = {
        ...(stored as SessionData),
        turnsJson,
        version,
        snapshot,
        pendingBotJob: isPendingBotJob(stored.pendingBotJob) ? stored.pendingBotJob : null,
        lastBotError: typeof stored.lastBotError === "string"
          ? stored.lastBotError
          : readLegacyBotTurnError(stored.botTurn),
      };
      await this.ctx.storage.put("session", migrated);
      return migrated;
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
      pendingBotJob: null,
      lastBotError: null,
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
      session.pendingBotJob = null;
      session.updatedAt = now;
      await this.saveSession(session);
    }
  }

  private getCurrentBotParticipant(session: StoredSessionData) {
    if (session.status !== "active" || session.result) {
      return null;
    }

    const currentSeat: HumanSeat = session.snapshot.current_player === "One" ? "one" : "two";
    const participant = participantForSeat(session, currentSeat);
    return participant?.kind === "bot" && participant.botConfig ? participant : null;
  }

  private buildBotTurnJob(session: StoredSessionData, botName: BotName): BotTurnJob {
    return {
      sessionId: session.id,
      version: session.version,
      botName,
      turnsJson: session.turnsJson,
    };
  }

  private async enqueueCurrentBotTurn(session: StoredSessionData): Promise<void> {
    const participant = this.getCurrentBotParticipant(session);
    if (!participant?.botConfig) {
      session.pendingBotJob = null;
      return;
    }

    if (session.pendingBotJob?.version === session.version) {
      return;
    }

    session.pendingBotJob = {
      version: session.version,
      botName: participant.botConfig.name,
      enqueuedAt: Date.now(),
    };
    session.lastBotError = null;
    session.updatedAt = Date.now();
    await this.saveSession(session);

    try {
      await this.env.BOT_TURNS_QUEUE.send(this.buildBotTurnJob(session, participant.botConfig.name));
    } catch (error) {
      session.lastBotError = error instanceof Error ? error.message : String(error);
      session.updatedAt = Date.now();
      await this.saveSession(session);
      console.error("failed to enqueue bot turn", {
        sessionId: session.id,
        version: session.version,
        botName: participant.botConfig.name,
        error: session.lastBotError,
      });
    }
  }

  private async snapshotForView(session: StoredSessionData, token: string | null): Promise<{ seat: Seat; view: ReturnType<typeof buildSessionView> }> {
    await this.maybeExpireSession(session);
    const seat = getSeatForToken(session, token);
    return {
      seat,
      view: buildSessionView(session, session.snapshot, seat),
    };
  }

  private takeRateLimit(key: string, limit: { limit: number; windowMs: number; retryAfterSeconds: number }): Response | null {
    if (this.rateLimiter.consume(key, limit.limit, limit.windowMs)) {
      return null;
    }
    return tooManyRequests(limit.retryAfterSeconds);
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
        const snapshot = callSnapshot(session.turnsJson);
        const storedSession: StoredSessionData = {
          ...session,
          version: typeof session.version === "number" ? session.version : snapshot.turn_count,
          snapshot,
          pendingBotJob: null,
          lastBotError: null,
        };
        this.ensureActiveClock(storedSession, snapshot, Date.now());
        await this.saveSession(storedSession);
        await this.enqueueCurrentBotTurn(storedSession);
        return json({ ok: true }, 201);
      }

      if (!existingSession) {
        return json({ error: "Session not found" }, 404);
      }

      const session = existingSession;

      if (request.method === "POST" && url.pathname === "/internal/bot-job/check") {
        await this.maybeExpireSession(session);
        const body = await readJson<{ version?: number }>(request);
        const current =
          session.status === "active"
          && !session.result
          && session.pendingBotJob?.version === body.version
          && Boolean(this.getCurrentBotParticipant(session));
        return json({ current });
      }

      if (request.method === "POST" && url.pathname === "/internal/bot-job/apply") {
        await this.maybeExpireSession(session);
        const body = await readJson<{ version?: number; stones?: Cube[] }>(request);
        if (
          session.status !== "active"
          || session.result
          || session.pendingBotJob?.version !== body.version
          || !Array.isArray(body.stones)
          || body.stones.length !== 2
        ) {
          return json({ applied: false });
        }

        const now = Date.now();
        const nextSnapshot = callPlay(session.turnsJson, body.stones);
        session.turnsJson = nextSnapshot.turns_json;
        session.snapshot = nextSnapshot;
        session.version += 1;
        session.pendingBotJob = null;
        session.lastBotError = null;
        session.updatedAt = now;
        if (!applySnapshotResult(session, nextSnapshot, now)) {
          const nextSeat: HumanSeat = nextSnapshot.current_player === "One" ? "one" : "two";
          completeMove(session.clock, nextSeat, now);
        }
        await this.saveSession(session);
        await this.enqueueCurrentBotTurn(session);
        return json({ applied: true });
      }

      if (request.method === "POST" && url.pathname === "/internal/bot-job/fail") {
        const body = await readJson<{ version?: number; error?: string }>(request);
        if (session.pendingBotJob?.version === body.version) {
          session.lastBotError = String(body.error || "Bot turn failed");
          session.updatedAt = Date.now();
          await this.saveSession(session);
        }
        return json({ ok: true });
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
          const { view } = await this.snapshotForView(session, incomingToken);
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
          const { view } = await this.snapshotForView(session, token);
          return json({ token, session: view });
        }

        const { view } = await this.snapshotForView(session, token);
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
        const knownVersion = Number(url.searchParams.get("version") || "");
        const knownSeat = url.searchParams.get("seat");
        if (Number.isFinite(knownVersion) && knownVersion === session.version && knownSeat === seat) {
          return json({
            unchanged: true,
            seat,
            serverNow: Date.now(),
            version: session.version,
          });
        }

        return json(buildSessionView(session, session.snapshot, seat));
      }

      if (request.method === "POST" && url.pathname === "/move") {
        const body = await readJson<{ token?: string | null; stones?: Cube[] }>(request);
        const token = body.token ?? null;
        const seat = getSeatForToken(session, token);
        const player = playerForSeat(seat);
        if (!player) {
          return json({ error: "You are not seated in this session" }, 403);
        }

        const now = Date.now();
        const snapshot = session.snapshot;
        this.ensureActiveClock(session, snapshot, now);
        if (expireSessionOnClock(session, now)) {
          session.pendingBotJob = null;
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
        if (snapshot.current_player !== player) {
          return json({ error: "It is not your turn" }, 400);
        }
        if (!Array.isArray(body.stones) || body.stones.length !== 2) {
          return json({ error: "A turn must contain exactly 2 stones" }, 400);
        }

        const nextSnapshot = callPlay(session.turnsJson, body.stones);
        session.turnsJson = nextSnapshot.turns_json;
        session.snapshot = nextSnapshot;
        session.version += 1;
        session.pendingBotJob = null;
        session.lastBotError = null;
        session.updatedAt = now;
        if (!applySnapshotResult(session, nextSnapshot, now)) {
          const nextSeat: HumanSeat = nextSnapshot.current_player === "One" ? "one" : "two";
          completeMove(session.clock, nextSeat, now);
        }
        await this.saveSession(session);
        await this.enqueueCurrentBotTurn(session);
        const { view } = await this.snapshotForView(session, token);
        return json(view);
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
      session.pendingBotJob = null;
      session.updatedAt = now;
      await this.saveSession(session);
      return;
    }

    await this.syncAlarm(session);
  }
}

function isPendingBotJob(value: unknown): value is PendingBotJob {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.version === "number"
    && typeof candidate.botName === "string"
    && typeof candidate.enqueuedAt === "number";
}

function readLegacyBotTurnError(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.lastError === "string" ? candidate.lastError : null;
}
