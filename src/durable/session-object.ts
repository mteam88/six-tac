import { DurableObject } from "cloudflare:workers";
import { chooseBotMove } from "../bots";
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
import { json, readJson } from "../api/utils";

function callSnapshot(gameJson: string): EngineSnapshot {
  return JSON.parse(snapshot_json(gameJson)) as EngineSnapshot;
}

function callPlay(gameJson: string, stones: Cube[]): EngineSnapshot {
  if (stones.length !== 2) {
    throw new Error("A turn must contain exactly 2 stones");
  }
  return JSON.parse(play_json(gameJson, JSON.stringify(stones))) as EngineSnapshot;
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
  private async loadSession(): Promise<SessionData | null> {
    const session = await this.ctx.storage.get<SessionData>("session");
    if (session) {
      return session;
    }

    const legacyRoom = await this.ctx.storage.get<LegacyRoomData>("room");
    if (!legacyRoom) {
      return null;
    }

    const snapshot = callSnapshot(legacyRoom.turnsJson);
    const now = Date.now();
    const migrated: SessionData = {
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
    };

    await this.ctx.storage.put("session", migrated);
    return migrated;
  }

  private async saveSession(session: SessionData): Promise<void> {
    await this.ctx.storage.put("session", session);
    await this.syncAlarm(session);
  }

  private async syncAlarm(session: SessionData): Promise<void> {
    const deadline = getDeadlineAt(session.clock);
    if (!deadline || session.status !== "active" || session.result) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(deadline);
  }

  private ensureActiveClock(session: SessionData, snapshot: EngineSnapshot, now: number): void {
    if (!session.clock?.enabled || session.result || session.status !== "active") {
      return;
    }
    if (session.clock.activeSeat) {
      return;
    }
    const seat = snapshot.current_player === "One" ? "one" : "two";
    startClock(session.clock, seat, now);
  }

  private async maybeExpireSession(session: SessionData, snapshot: EngineSnapshot): Promise<EngineSnapshot> {
    const now = Date.now();
    if (expireSessionOnClock(session, now)) {
      session.updatedAt = now;
      await this.saveSession(session);
    }
    return snapshot;
  }

  private async snapshotForView(session: SessionData, token: string | null): Promise<{ seat: Seat; view: ReturnType<typeof buildSessionView> }> {
    const snapshot = callSnapshot(session.turnsJson);
    await this.maybeExpireSession(session, snapshot);
    const nextSnapshot = callSnapshot(session.turnsJson);
    const seat = getSeatForToken(session, token);
    return {
      seat,
      view: buildSessionView(session, nextSnapshot, seat),
    };
  }

  private async runBotTurns(session: SessionData): Promise<void> {
    while (session.status === "active" && !session.result) {
      const snapshot = callSnapshot(session.turnsJson);
      applySnapshotResult(session, snapshot, Date.now());
      if (session.result || session.status !== "active") {
        break;
      }

      const currentSeat: HumanSeat = snapshot.current_player === "One" ? "one" : "two";
      const participant = participantForSeat(session, currentSeat);
      if (!participant || participant.kind !== "bot" || !participant.botConfig) {
        this.ensureActiveClock(session, snapshot, Date.now());
        break;
      }

      const now = Date.now();
      this.ensureActiveClock(session, snapshot, now);
      const stones = chooseBotMove(participant.botConfig.name, session.turnsJson);
      const nextSnapshot = callPlay(session.turnsJson, stones);
      session.turnsJson = nextSnapshot.turns_json;
      session.updatedAt = now;
      if (!applySnapshotResult(session, nextSnapshot, now)) {
        const nextSeat: HumanSeat = nextSnapshot.current_player === "One" ? "one" : "two";
        completeMove(session.clock, nextSeat, now);
      }
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
        const snapshot = callSnapshot(session.turnsJson);
        this.ensureActiveClock(session, snapshot, Date.now());
        await this.saveSession(session);
        await this.runBotTurns(session);
        return json({ ok: true }, 201);
      }

      if (!existingSession) {
        return json({ error: "Session not found" }, 404);
      }

      const session = existingSession;

      if (request.method === "POST" && url.pathname === "/join") {
        const body = await readJson<{ token?: string | null; playerId?: string | null }>(request);
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
            this.ensureActiveClock(session, callSnapshot(session.turnsJson), Date.now());
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
        const { view } = await this.snapshotForView(session, token);
        return json(view);
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
        const snapshot = callSnapshot(session.turnsJson);
        this.ensureActiveClock(session, snapshot, now);
        if (expireSessionOnClock(session, now)) {
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
        session.updatedAt = now;
        if (!applySnapshotResult(session, nextSnapshot, now)) {
          const nextSeat: HumanSeat = nextSnapshot.current_player === "One" ? "one" : "two";
          completeMove(session.clock, nextSeat, now);
        }
        await this.saveSession(session);
        await this.runBotTurns(session);
        const { view } = await this.snapshotForView(session, token);
        return json(view);
      }

      return json({ error: "Not found" }, 404);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Unknown error" }, 400);
    }
  }

  async alarm(): Promise<void> {
    const session = await this.loadSession();
    if (!session) {
      return;
    }
    const snapshot = callSnapshot(session.turnsJson);
    if (expireSessionOnClock(session, Date.now())) {
      await this.saveSession(session);
      return;
    }
    this.ensureActiveClock(session, snapshot, Date.now());
    await this.saveSession(session);
  }
}
