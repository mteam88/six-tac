import { chooseRemoteBestMove, evaluateRemotePosition, getAvailableBot } from "../backend-bots";
import { createBestMoveJob, createEvalJob, getComputeJob } from "../compute-jobs";
import type { BestMoveComputeRequest, EvalComputeRequest } from "../domain/types";
import type { Env } from "../env";
import { json, readJson } from "./utils";

function validateTurnsJson(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function validateBotName(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

async function validateBestMoveRequest(env: Env, request: BestMoveComputeRequest): Promise<string | null> {
  const botName = validateBotName(request.config?.botName);
  const turnsJson = validateTurnsJson(request.position?.turnsJson);
  if (!botName || !turnsJson) {
    return "Missing position.turnsJson or config.botName";
  }
  const bot = await getAvailableBot(env, request.config.botName);
  if (!bot?.available) {
    return `${request.config.botName} is not available`;
  }
  if (bot.execution !== "remote") {
    return `${request.config.botName} runs in the browser and is not available from the server compute API`;
  }
  return null;
}

async function validateEvalRequest(env: Env, request: EvalComputeRequest): Promise<string | null> {
  const botName = validateBotName(request.config?.botName);
  const turnsJson = validateTurnsJson(request.position?.turnsJson);
  if (!botName || !turnsJson) {
    return "Missing position.turnsJson or config.botName";
  }
  const bot = await getAvailableBot(env, request.config.botName);
  if (!bot?.available) {
    return `${request.config.botName} is not available`;
  }
  if (bot.execution !== "remote") {
    return `${request.config.botName} runs in the browser and is not available from the server compute API`;
  }
  return null;
}

export async function handleComputeBestMove(request: Request, env: Env): Promise<Response> {
  const body = await readJson<BestMoveComputeRequest>(request);
  const error = await validateBestMoveRequest(env, body);
  if (error) {
    return json({ error }, 400);
  }
  return json(await chooseRemoteBestMove(env, body));
}

export async function handleComputeBestMoveJob(request: Request, env: Env): Promise<Response> {
  const body = await readJson<BestMoveComputeRequest>(request);
  const error = await validateBestMoveRequest(env, body);
  if (error) {
    return json({ error }, 400);
  }
  const job = await createBestMoveJob(env, body);
  return json({ jobId: job.id, status: job.status, positionId: job.positionId }, 202);
}

export async function handleComputeEval(request: Request, env: Env): Promise<Response> {
  const body = await readJson<EvalComputeRequest>(request);
  const error = await validateEvalRequest(env, body);
  if (error) {
    return json({ error }, 400);
  }
  return json(await evaluateRemotePosition(env, body));
}

export async function handleComputeEvalJob(request: Request, env: Env): Promise<Response> {
  const body = await readJson<EvalComputeRequest>(request);
  const error = await validateEvalRequest(env, body);
  if (error) {
    return json({ error }, 400);
  }
  const job = await createEvalJob(env, body);
  return json({ jobId: job.id, status: job.status, positionId: job.positionId }, 202);
}

export async function handleComputeJobState(_request: Request, env: Env, jobId: string): Promise<Response> {
  const job = await getComputeJob(env, jobId);
  if (!job) {
    return json({ error: "Compute job not found" }, 404);
  }
  return json(job);
}
