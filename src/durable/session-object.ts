import { DurableObject } from "cloudflare:workers";
import { json, readJson, clientAddress } from "../api/utils";
import { chooseBackendBotMove } from "../backend-bots";
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
import type { Cube, EngineSnapshot, HumanSeat, SessionData, Seat } from "../domain/types";
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

const BOT_TURN_RETRY_BASE_MS = 5_000;
const BOT_TURN_RETRY_MAX_MS = 60_000;

type BotTurnState = {
  retryCount: number;
  nextRetryAt: number | null;
  lastError: string | null;
};

type StoredSessionData = SessionData & {
  snapshot: EngineSnapshot;
  botTurn: BotTurnState;
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

function createBotTurnState(): BotTurnState {
  return {
    retryCount: 0,
    nextRetryAt: null,
    lastError: null,
  };
}

function getBotTurnRetryDelayMs(retryCount: number): number {
  return Math.min(BOT_TURN_RETRY_BASE_MS * 2 ** Math.max(0, retryCount - 1), BOT_TURN_RETRY_MAX_MS);
}

type LegacyRoomData = {
  code: string;
  turnsJson: string;
  seats: {
    one: string | null;
    two: string | null;
  };
};

export class SessionObject extends DurableObject<Env> {
  private readonly rateLimiter = new FixedWindowRateLimiter();
  private botTurnTask: Promise<void> | null = null;

  private async loadSession(): Promise<StoredSessionData | null> {
    const stored = await this.ctx.storage.get<StoredSessionData | SessionData>("session");
    if (stored) {
      if ("snapshot" in stored && stored.snapshot && "botTurn" in stored && stored.botTurn) {
        return stored as StoredSessionData;
      }

      const migrated = {
        ...stored,
        snapshot: "snapshot" in stored && stored.snapshot ? stored.snapshot : callSnapshot(stored.turnsJson),
        botTurn: "botTurn" in stored && stored.botTurn ? stored.botTurn : createBotTurnState(),
      } satisfies StoredSessionData;
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
      botTurn: createBotTurnState(),
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

    const nextAlarmAt = [getDeadlineAt(session.clock), session.botTurn.nextRetryAt]
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
      .reduce<number | null>((earliest, value) => earliest === null ? value : Math.min(earliest, value), null);

    if (nextAlarmAt === null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    await this.ctx.storage.setAlarm(nextAlarmAt);
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
      session.botTurn = createBotTurnState();
      session.updatedAt = now;
      await this.saveSession(session);
    }
  }

  private resetBotTurnState(session: StoredSessionData): void {
    session.botTurn = createBotTurnState();
  }

  private getCurrentBotParticipant(session: StoredSessionData) {
    if (session.status !== "active" || session.result) {
      return null;
    }

    const currentSeat: HumanSeat = session.snapshot.current_player === "One" ? "one" : "two";
    const participant = participantForSeat(session, currentSeat);
    return participant?.kind === "bot" && participant.botConfig ? participant : null;
  }

  private queueBotTurnProcessing(): void {
    if (this.botTurnTask) {
      return;
    }

    const task = this.runBotTurns()
      .catch((error) => {
        console.error("SessionObject bot turn processing error", error);
      })
      .finally(() => {
        this.botTurnTask = null;
      });

    this.botTurnTask = task;
    this.ctx.waitUntil(task);
  }

  private async maybeQueueBotTurnProcessing(session: StoredSessionData, now = Date.now()): Promise<void> {
    if (!this.getCurrentBotParticipant(session)) {
      if (session.botTurn.retryCount || session.botTurn.nextRetryAt || session.botTurn.lastError) {
        this.resetBotTurnState(session);
        await this.saveSession(session);
      }
      return;
    }

    if (session.botTurn.nextRetryAt && session.botTurn.nextRetryAt > now) {
      await this.syncAlarm(session);
      return;
    }

    this.queueBotTurnProcessing();
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

  private async runBotTurns(): Promise<void> {
    while (true) {
      const session = await this.loadSession();
      if (!session) {
        return;
      }

      await this.maybeExpireSession(session);
      if (session.status !== "active" || session.result) {
        if (session.botTurn.retryCount || session.botTurn.nextRetryAt || session.botTurn.lastError) {
          this.resetBotTurnState(session);
          session.updatedAt = Date.now();
          await this.saveSession(session);
        }
        return;
      }

      const snapshot = session.snapshot;
      const now = Date.now();
      if (applySnapshotResult(session, snapshot, now)) {
        this.resetBotTurnState(session);
        session.updatedAt = now;
        await this.saveSession(session);
        return;
      }

      const participant = this.getCurrentBotParticipant(session);
      if (!participant?.botConfig) {
        this.ensureActiveClock(session, snapshot, now);
        if (session.botTurn.retryCount || session.botTurn.nextRetryAt || session.botTurn.lastError) {
          this.resetBotTurnState(session);
          session.updatedAt = now;
          await this.saveSession(session);
        }
        return;
      }

      if (session.botTurn.nextRetryAt && session.botTurn.nextRetryAt > now) {
        await this.syncAlarm(session);
        return;
      }

      this.ensureActiveClock(session, snapshot, now);
      const turnsJsonBeforeMove = session.turnsJson;

      try {
        const stones = await chooseBackendBotMove(
          this.env,
          participant.botConfig.name,
          turnsJsonBeforeMove,
          session.id,
        );

        const latest = await this.loadSession();
        if (!latest) {
          return;
        }
        if (latest.status !== "active" || latest.result) {
          return;
        }
        if (latest.turnsJson !== turnsJsonBeforeMove) {
          continue;
        }

        const moveAppliedAt = Date.now();
        const nextSnapshot = callPlay(latest.turnsJson, stones);
        latest.turnsJson = nextSnapshot.turns_json;
        latest.snapshot = nextSnapshot;
        latest.updatedAt = moveAppliedAt;
        this.resetBotTurnState(latest);
        if (!applySnapshotResult(latest, nextSnapshot, moveAppliedAt)) {
          const nextSeat: HumanSeat = nextSnapshot.current_player === "One" ? "one" : "two";
          completeMove(latest.clock, nextSeat, moveAppliedAt);
        }
        await this.saveSession(latest);
      } catch (error) {
        const latest = await this.loadSession();
        if (!latest) {
          return;
        }
        if (latest.status !== "active" || latest.result) {
          return;
        }
        if (latest.turnsJson !== turnsJsonBeforeMove) {
          continue;
        }

        const retryCount = latest.botTurn.retryCount + 1;
        const retryDelayMs = getBotTurnRetryDelayMs(retryCount);
        latest.botTurn = {
          retryCount,
          nextRetryAt: Date.now() + retryDelayMs,
          lastError: error instanceof Error ? error.message : String(error),
        };
        latest.updatedAt = Date.now();
        await this.saveSession(latest);
        console.error("SessionObject bot turn attempt failed", {
          sessionId: latest.id,
          retryCount,
          retryDelayMs,
          error: latest.botTurn.lastError,
        });
        return;
      }
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
        const snapshot = callSnapshot(session.turnsJson);
        const storedSession: StoredSessionData = {
          ...session,
          snapshot,
          botTurn: createBotTurnState(),
        };
        this.ensureActiveClock(storedSession, snapshot, Date.now());
        await this.saveSession(storedSession);
        await this.maybeQueueBotTurnProcessing(storedSession);
        return json({ ok: true }, 201);
      }

      if (!existingSession) {
        return json({ error: "Session not found" }, 404);
      }

      const session = existingSession;

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
          await this.maybeQueueBotTurnProcessing(session);
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
          await this.maybeQueueBotTurnProcessing(session);
          const { view } = await this.snapshotForView(session, token);
          return json({ token, session: view });
        }

        await this.maybeQueueBotTurnProcessing(session);
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
        await this.maybeQueueBotTurnProcessing(session);
        const seat = getSeatForToken(session, token);
        const knownVersion = Number(url.searchParams.get("version") || "");
        const knownSeat = url.searchParams.get("seat");
        if (Number.isFinite(knownVersion) && knownVersion === session.updatedAt && knownSeat === seat) {
          return json({
            unchanged: true,
            seat,
            serverNow: Date.now(),
            version: session.updatedAt,
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
          this.resetBotTurnState(session);
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
        session.updatedAt = now;
        this.resetBotTurnState(session);
        if (!applySnapshotResult(session, nextSnapshot, now)) {
          const nextSeat: HumanSeat = nextSnapshot.current_player === "One" ? "one" : "two";
          completeMove(session.clock, nextSeat, now);
        }
        await this.saveSession(session);
        await this.maybeQueueBotTurnProcessing(session);
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
    if (expireSessionOnClock(session, now)) {
      this.resetBotTurnState(session);
      session.updatedAt = now;
      await this.saveSession(session);
      return;
    }

    this.ensureActiveClock(session, session.snapshot, now);
    await this.saveSession(session);
    await this.maybeQueueBotTurnProcessing(session, now);
  }
}
