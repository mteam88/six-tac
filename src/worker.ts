import { handleLocalMove, handleLocalStart } from "./api/local";
import { handleBotList } from "./api/bots";
import {
  handleCreateBotSession,
  handleCreatePrivateSession,
  handleJoinSession,
  handleSessionMoves,
  handleSessionState,
} from "./api/sessions";
import {
  handleComputeBestMove,
  handleComputeBestMoveJob,
  handleComputeEval,
  handleComputeEvalJob,
  handleComputeJobState,
} from "./api/compute";
import { json } from "./api/utils";
import { ComputeJobObject, handleBestMoveJobBatch, handleEvalJobBatch } from "./compute-jobs";
import { SessionObject } from "./durable/session-object";
import type { ComputeJobEnvelope } from "./domain/types";
import type { Env } from "./env";

export { SessionObject };
export class SessionRuntime extends SessionObject {}
export { ComputeJobObject };
export class ComputeJobRuntime extends ComputeJobObject {}

function sessionRoute(pathname: string): { sessionId: string; action: string } | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length !== 5 || parts[0] !== "api" || parts[1] !== "v1" || parts[2] !== "sessions") {
    return null;
  }
  const [,,, sessionId, action] = parts;
  if (!sessionId || !action) return null;
  return { sessionId, action };
}

function computeJobRoute(pathname: string): { jobId: string } | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length !== 5 || parts[0] !== "api" || parts[1] !== "v1" || parts[2] !== "compute" || parts[3] !== "jobs") {
    return null;
  }
  const jobId = parts[4];
  return jobId ? { jobId } : null;
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

      if (request.method === "POST" && pathname === "/api/v1/compute/best-move") {
        return handleComputeBestMove(request, env);
      }

      if (request.method === "POST" && pathname === "/api/v1/compute/best-move/jobs") {
        return handleComputeBestMoveJob(request, env);
      }

      if (request.method === "POST" && pathname === "/api/v1/compute/eval") {
        return handleComputeEval(request, env);
      }

      if (request.method === "POST" && pathname === "/api/v1/compute/eval/jobs") {
        return handleComputeEvalJob(request, env);
      }

      const computeJob = computeJobRoute(pathname);
      if (computeJob && request.method === "GET") {
        return handleComputeJobState(request, env, computeJob.jobId);
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
      if (session && request.method === "POST" && session.action === "moves") {
        return handleSessionMoves(request, env, session.sessionId);
      }

      return env.ASSETS.fetch(request);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Unknown error" }, 400);
    }
  },

  async queue(batch: MessageBatch<ComputeJobEnvelope>, env: Env): Promise<void> {
    const queueName = batch.queue;
    if (queueName === "best-move-jobs-v1") {
      await handleBestMoveJobBatch(batch, env);
      return;
    }
    if (queueName === "eval-jobs-v1") {
      await handleEvalJobBatch(batch, env);
      return;
    }
    throw new Error(`Unknown queue: ${queueName}`);
  },
} satisfies ExportedHandler<Env>;
