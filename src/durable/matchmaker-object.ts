import { DurableObject } from "cloudflare:workers";
import { startClock } from "../domain/clock";
import { createSession, createToken } from "../domain/session-state";
import type { ClockSettings, MatchmakingStatus, SessionData, SessionRef, SessionView } from "../domain/types";
import type { Env } from "../env";
import { json, readJson } from "../api/utils";

type QueueEntry = {
  playerId: string;
  queuedAt: number;
  clock: ClockSettings | null;
};

type StoredMatch = SessionRef;

function sessionStub(env: Env, sessionId: string): DurableObjectStub {
  return env.SESSIONS.get(env.SESSIONS.idFromName(sessionId));
}

export class MatchmakerObject extends DurableObject<Env> {
  private async loadQueue(): Promise<QueueEntry[]> {
    return (await this.ctx.storage.get<QueueEntry[]>("queue")) ?? [];
  }

  private async saveQueue(queue: QueueEntry[]): Promise<void> {
    await this.ctx.storage.put("queue", queue);
  }

  private async loadMatches(): Promise<Record<string, StoredMatch>> {
    return (await this.ctx.storage.get<Record<string, StoredMatch>>("matches")) ?? {};
  }

  private async saveMatches(matches: Record<string, StoredMatch>): Promise<void> {
    await this.ctx.storage.put("matches", matches);
  }

  private async createMatchedSession(first: QueueEntry, second: QueueEntry): Promise<Record<string, StoredMatch>> {
    const sessionId = crypto.randomUUID();
    const firstToken = createToken();
    const secondToken = createToken();
    const now = Date.now();
    const session = createSession(
      {
        id: sessionId,
        code: null,
        type: "matchmade",
        participants: [
          {
            id: first.playerId,
            kind: "human",
            seat: "two",
            token: firstToken,
            playerId: first.playerId,
          },
          {
            id: second.playerId,
            kind: "human",
            seat: "one",
            token: secondToken,
            playerId: second.playerId,
          },
        ],
        clock: first.clock,
        active: true,
      },
      now,
    );
    startClock(session.clock, "two", now);

    const response = await sessionStub(this.env, sessionId).fetch("https://session/internal/init", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(session satisfies SessionData),
    });
    if (!response.ok) {
      const error = (await response.json()) as { error?: string };
      throw new Error(error.error || "Could not create matchmade session");
    }

    return {
      [first.playerId]: { id: sessionId, code: null, token: firstToken },
      [second.playerId]: { id: sessionId, code: null, token: secondToken },
    };
  }

  private async buildMatchedStatus(ref: SessionRef): Promise<MatchmakingStatus> {
    const response = await sessionStub(this.env, ref.id).fetch(
      `https://session/state?token=${encodeURIComponent(ref.token)}`,
    );
    if (!response.ok) {
      const error = (await response.json()) as { error?: string };
      throw new Error(error.error || "Could not load matched session");
    }

    return {
      status: "matched",
      ref,
      session: (await response.json()) as SessionView,
    };
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const queue = await this.loadQueue();
      const matches = await this.loadMatches();

      if (request.method === "POST" && url.pathname === "/queue") {
        const body = await readJson<{ playerId?: string; clock?: ClockSettings | null }>(request);
        const playerId = String(body.playerId || "").trim();
        if (!playerId) {
          return json({ error: "Missing player id" }, 400);
        }

        const existingMatch = matches[playerId];
        if (existingMatch) {
          return json(await this.buildMatchedStatus(existingMatch));
        }

        const existingQueue = queue.find((entry) => entry.playerId === playerId);
        if (existingQueue) {
          return json({
            status: "queued",
            queuedAt: existingQueue.queuedAt,
            clock: existingQueue.clock,
          } satisfies MatchmakingStatus);
        }

        const desiredClock = body.clock ?? null;
        const desiredClockKey = JSON.stringify(desiredClock);
        const opponentIndex = queue.findIndex(
          (entry) => entry.playerId !== playerId && JSON.stringify(entry.clock) === desiredClockKey,
        );
        if (opponentIndex >= 0) {
          const [opponent] = queue.splice(opponentIndex, 1);
          const createdMatches = await this.createMatchedSession(opponent, {
            playerId,
            queuedAt: Date.now(),
            clock: desiredClock,
          });
          Object.assign(matches, createdMatches);
          await this.saveQueue(queue);
          await this.saveMatches(matches);
          return json(await this.buildMatchedStatus(matches[playerId]));
        }

        const entry: QueueEntry = {
          playerId,
          queuedAt: Date.now(),
          clock: desiredClock,
        };
        queue.push(entry);
        await this.saveQueue(queue);
        return json({
          status: "queued",
          queuedAt: entry.queuedAt,
          clock: entry.clock,
        } satisfies MatchmakingStatus);
      }

      if (request.method === "GET" && url.pathname === "/status") {
        const playerId = String(url.searchParams.get("playerId") || "").trim();
        if (!playerId) {
          return json({ error: "Missing player id" }, 400);
        }

        const match = matches[playerId];
        if (match) {
          return json(await this.buildMatchedStatus(match));
        }

        const entry = queue.find((item) => item.playerId === playerId);
        if (entry) {
          return json({
            status: "queued",
            queuedAt: entry.queuedAt,
            clock: entry.clock,
          } satisfies MatchmakingStatus);
        }

        return json({ status: "idle" } satisfies MatchmakingStatus);
      }

      if (request.method === "POST" && url.pathname === "/cancel") {
        const body = await readJson<{ playerId?: string }>(request);
        const playerId = String(body.playerId || "").trim();
        if (!playerId) {
          return json({ error: "Missing player id" }, 400);
        }

        const nextQueue = queue.filter((entry) => entry.playerId !== playerId);
        if (nextQueue.length !== queue.length) {
          await this.saveQueue(nextQueue);
        }
        return json({ status: "idle" } satisfies MatchmakingStatus);
      }

      return json({ error: "Not found" }, 404);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Unknown error" }, 400);
    }
  }
}
