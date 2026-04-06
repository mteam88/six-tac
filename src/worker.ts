import { handleLocalMove, handleLocalStart } from "./api/local";
import { handleBotList } from "./api/bots";
import {
  handleCreateBotSession,
  handleCreatePrivateSession,
  handleJoinSession,
  handleSessionMove,
  handleSessionState,
} from "./api/sessions";
import {
  handleCancelMatchmaking,
  handleMatchmakingStatus,
  handleQueueMatchmaking,
} from "./api/matchmaking";
import { json } from "./api/utils";
import { handleBotTurnBatch } from "./bot-turn-queue";
import { MatchmakerObject } from "./durable/matchmaker-object";
import { SessionObject } from "./durable/session-object";
import type { Env } from "./env";

export class RoomObject extends SessionObject {}
export { SessionObject, MatchmakerObject };
export class SessionRuntime extends SessionObject {}
export class MatchmakerRuntime extends MatchmakerObject {}

function sessionRoute(pathname: string): { sessionId: string; action: string } | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length !== 5 || parts[0] !== "api" || parts[1] !== "v1" || parts[2] !== "sessions") {
    return null;
  }
  const [,,, sessionId, action] = parts;
  if (!sessionId || !action) return null;
  return { sessionId, action };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      const pathname = url.pathname;

      if (request.method === "POST" && pathname === "/api/v1/local/start") {
        return handleLocalStart();
      }

      if (request.method === "POST" && pathname === "/api/v1/local/move") {
        return handleLocalMove(request);
      }

      if (request.method === "GET" && pathname === "/api/v1/bots") {
        return handleBotList(env);
      }

      if (request.method === "POST" && pathname === "/api/v1/sessions/private") {
        return handleCreatePrivateSession(request, env);
      }

      if (request.method === "POST" && pathname === "/api/v1/sessions/bot") {
        return handleCreateBotSession(request, env);
      }

      if (request.method === "POST" && pathname === "/api/v1/sessions/join") {
        return handleJoinSession(request, env);
      }

      const session = sessionRoute(pathname);
      if (session && request.method === "GET" && session.action === "state") {
        return handleSessionState(request, env, session.sessionId);
      }
      if (session && request.method === "POST" && session.action === "move") {
        return handleSessionMove(request, env, session.sessionId);
      }

      if (request.method === "POST" && pathname === "/api/v1/matchmaking/queue") {
        return handleQueueMatchmaking(request, env);
      }

      if (request.method === "GET" && pathname === "/api/v1/matchmaking/status") {
        return handleMatchmakingStatus(request, env);
      }

      if (request.method === "POST" && pathname === "/api/v1/matchmaking/cancel") {
        return handleCancelMatchmaking(request, env);
      }

      return env.ASSETS.fetch(request);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Unknown error" }, 400);
    }
  },

  async queue(batch: MessageBatch<import("./bot-turn-queue").BotTurnJob>, env: Env): Promise<void> {
    await handleBotTurnBatch(batch, env);
  },
} satisfies ExportedHandler<Env>;
