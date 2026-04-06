import { DurableObject } from "cloudflare:workers";
import { chooseRemoteBestMove, evaluateRemotePosition } from "./backend-bots";
import { json, readJson, sessionStub } from "./api/utils";
import { positionIdForTurnsJson } from "./domain/position";
import type {
  BestMoveComputeRequest,
  ComputeJobEnvelope,
  ComputeJobRecord,
  ComputeJobStatus,
  EvalComputeRequest,
} from "./domain/types";
import type { Env } from "./env";

type ComputeJobMutation = {
  result?: ComputeJobRecord["result"];
  error?: string | null;
  status: ComputeJobStatus;
};

function logComputeEvent(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields }));
}

function computeJobStub(env: Env, jobId: string): DurableObjectStub {
  return env.COMPUTE_JOBS.get(env.COMPUTE_JOBS.idFromName(jobId));
}

async function createJobRecord(
  env: Env,
  kind: ComputeJobRecord["kind"],
  request: BestMoveComputeRequest | EvalComputeRequest,
  callback: ComputeJobRecord["callback"],
): Promise<ComputeJobRecord> {
  const job: ComputeJobRecord = {
    id: crypto.randomUUID(),
    kind,
    status: "queued",
    positionId: await positionIdForTurnsJson(request.position.turnsJson),
    request,
    result: null,
    error: null,
    callback,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const response = await computeJobStub(env, job.id).fetch("https://compute/internal/init", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(job),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(payload.error || "Could not initialize compute job");
  }
  logComputeEvent("compute.job_created", {
    jobId: job.id,
    kind,
    positionId: job.positionId,
    callbackType: callback?.type ?? null,
  });
  return job;
}

async function setJobState(env: Env, jobId: string, mutation: ComputeJobMutation): Promise<ComputeJobRecord> {
  const response = await computeJobStub(env, jobId).fetch("https://compute/internal/update", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(mutation),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(payload.error || `Could not update compute job ${jobId}`);
  }
  return await response.json() as ComputeJobRecord;
}

export async function getComputeJob(env: Env, jobId: string): Promise<ComputeJobRecord | null> {
  const response = await computeJobStub(env, jobId).fetch("https://compute/state");
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(payload.error || `Could not load compute job ${jobId}`);
  }
  return await response.json() as ComputeJobRecord;
}

export async function createBestMoveJob(
  env: Env,
  request: BestMoveComputeRequest,
  callback: ComputeJobRecord["callback"] = null,
): Promise<ComputeJobRecord> {
  const job = await createJobRecord(env, "best-move", request, callback);
  await env.BEST_MOVE_JOBS_QUEUE.send({ jobId: job.id });
  logComputeEvent("compute.job_enqueued", { jobId: job.id, kind: job.kind, queue: "best-move-jobs-v1" });
  return job;
}

export async function createEvalJob(
  env: Env,
  request: EvalComputeRequest,
  callback: ComputeJobRecord["callback"] = null,
): Promise<ComputeJobRecord> {
  const job = await createJobRecord(env, "eval", request, callback);
  await env.EVAL_JOBS_QUEUE.send({ jobId: job.id });
  logComputeEvent("compute.job_enqueued", { jobId: job.id, kind: job.kind, queue: "eval-jobs-v1" });
  return job;
}

async function applyCallback(env: Env, job: ComputeJobRecord): Promise<void> {
  if (!job.callback || !job.result) {
    return;
  }

  const result = job.result;
  if (!("stones" in result)) {
    return;
  }

  await sessionStub(env, job.callback.sessionId).fetch("https://session/internal/apply-remote-move", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      basePositionId: job.callback.basePositionId,
      stones: result.stones,
    }),
  });
}

async function processComputeJob(message: Message<ComputeJobEnvelope>, env: Env, expectedKind: ComputeJobRecord["kind"]): Promise<void> {
  const job = await getComputeJob(env, message.body.jobId);
  if (!job || job.kind !== expectedKind) {
    logComputeEvent("compute.job_dropped", { jobId: message.body.jobId, reason: "missing_or_kind_mismatch", expectedKind });
    message.ack();
    return;
  }
  if (job.status === "done") {
    logComputeEvent("compute.job_dropped", { jobId: job.id, reason: "already_done", kind: job.kind });
    message.ack();
    return;
  }

  try {
    logComputeEvent("compute.job_running", { jobId: job.id, kind: job.kind, positionId: job.positionId });
    await setJobState(env, job.id, { status: "running", error: null });
    const result = job.kind === "best-move"
      ? await chooseRemoteBestMove(env, job.request as BestMoveComputeRequest)
      : await evaluateRemotePosition(env, job.request as EvalComputeRequest);
    const completed = await setJobState(env, job.id, { status: "done", result, error: null });
    await applyCallback(env, completed);
    logComputeEvent("compute.job_done", { jobId: job.id, kind: job.kind, positionId: job.positionId });
    message.ack();
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    console.error("compute job failed", { jobId: job.id, kind: job.kind, error: messageText });
    logComputeEvent("compute.job_failed", { jobId: job.id, kind: job.kind, positionId: job.positionId, error: messageText });
    await setJobState(env, job.id, { status: "failed", error: messageText }).catch((updateError) => {
      console.error("could not persist compute job failure", updateError);
    });
    if (job.callback?.type === "session-remote-move") {
      await sessionStub(env, job.callback.sessionId).fetch("https://session/internal/remote-move-failed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          basePositionId: job.callback.basePositionId,
          error: messageText,
        }),
      }).catch((callbackError) => {
        console.error("remote move failure callback failed", callbackError);
      });
    }
    message.retry();
  }
}

export async function handleBestMoveJobBatch(batch: MessageBatch<ComputeJobEnvelope>, env: Env): Promise<void> {
  await Promise.all(batch.messages.map((message) => processComputeJob(message, env, "best-move")));
}

export async function handleEvalJobBatch(batch: MessageBatch<ComputeJobEnvelope>, env: Env): Promise<void> {
  await Promise.all(batch.messages.map((message) => processComputeJob(message, env, "eval")));
}

export class ComputeJobObject extends DurableObject<Env> {
  private async load(): Promise<ComputeJobRecord | null> {
    return await this.ctx.storage.get<ComputeJobRecord>("job") ?? null;
  }

  private async save(job: ComputeJobRecord): Promise<void> {
    await this.ctx.storage.put("job", job);
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const job = await this.load();

      if (request.method === "POST" && url.pathname === "/internal/init") {
        const incoming = await readJson<ComputeJobRecord>(request);
        if (job) {
          return json(job);
        }
        await this.save(incoming);
        return json(incoming, 201);
      }

      if (!job) {
        return json({ error: "Compute job not found" }, 404);
      }

      if (request.method === "GET" && url.pathname === "/state") {
        return json(job);
      }

      if (request.method === "POST" && url.pathname === "/internal/update") {
        const mutation = await readJson<ComputeJobMutation>(request);
        const nextJob: ComputeJobRecord = {
          ...job,
          status: mutation.status,
          result: mutation.result === undefined ? job.result : mutation.result,
          error: mutation.error === undefined ? job.error : mutation.error,
          updatedAt: Date.now(),
        };
        await this.save(nextJob);
        return json(nextJob);
      }

      return json({ error: "Not found" }, 404);
    } catch (error) {
      console.error("ComputeJobObject error", error);
      return json({ error: error instanceof Error ? error.message : "Unknown error" }, 400);
    }
  }
}
