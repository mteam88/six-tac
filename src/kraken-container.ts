import { Container, getContainer } from "@cloudflare/containers";
import type { Env } from "./env";

const KRAKEN_CONTAINER_PORT = 8788;
const DEFAULT_KRAKEN_POOL_SIZE = 2;
const DEFAULT_KRAKEN_MOVE_TIMEOUT_MS = 30_000;
const DEFAULT_KRAKEN_MAX_ATTEMPTS = 2;

export class KrakenContainer extends Container {
  defaultPort = KRAKEN_CONTAINER_PORT;
  sleepAfter = "10m";
  pingEndpoint = "health";
  enableInternet = true;
  envVars = {
    BOT_SERVICE_ADDR: `0.0.0.0:${KRAKEN_CONTAINER_PORT}`,
    KRAKEN_BUILD_EXTENSIONS: "0",
    KRAKEN_DEVICE: "cpu",
    KRAKEN_MODEL_VERSION: "kraken_v1",
    KRAKEN_PYTHON_EXECUTABLE: "python3",
    KRAKEN_MOVE_TIMEOUT_MS: String(DEFAULT_KRAKEN_MOVE_TIMEOUT_MS),
  };
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value || "");
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function krakenPoolSize(env: Env): number {
  return parsePositiveInt(env.KRAKEN_CONTAINER_POOL_SIZE, DEFAULT_KRAKEN_POOL_SIZE);
}

function krakenMoveTimeoutMs(env: Env): number {
  return parsePositiveInt(env.KRAKEN_MOVE_TIMEOUT_MS, DEFAULT_KRAKEN_MOVE_TIMEOUT_MS);
}

function krakenContainerName(env: Env, cacheKey?: string, attempt = 0): string {
  const poolSize = krakenPoolSize(env);
  if (poolSize <= 1) {
    return "kraken-0";
  }
  const baseShard = hashString(cacheKey || "kraken") % poolSize;
  const shard = (baseShard + attempt) % poolSize;
  return `kraken-${shard}`;
}

function buildStartEnv(env: Env): Record<string, string> {
  const vars: Record<string, string> = {
    BOT_SERVICE_ADDR: `0.0.0.0:${KRAKEN_CONTAINER_PORT}`,
    KRAKEN_BUILD_EXTENSIONS: env.KRAKEN_BUILD_EXTENSIONS || "0",
    KRAKEN_DEVICE: env.KRAKEN_DEVICE || "cpu",
    KRAKEN_MODEL_VERSION: env.KRAKEN_MODEL_VERSION || "kraken_v1",
    KRAKEN_PYTHON_EXECUTABLE: env.KRAKEN_PYTHON_EXECUTABLE || "python3",
    KRAKEN_MOVE_TIMEOUT_MS: String(krakenMoveTimeoutMs(env)),
  };

  if (env.KRAKEN_MODEL_PATH) {
    vars.KRAKEN_MODEL_PATH = env.KRAKEN_MODEL_PATH;
  }
  if (env.KRAKEN_MODEL_URL) {
    vars.KRAKEN_MODEL_URL = env.KRAKEN_MODEL_URL;
  }
  if (env.KRAKEN_N_SIMS) {
    vars.KRAKEN_N_SIMS = env.KRAKEN_N_SIMS;
  }
  if (env.KRAKEN_TORCH_THREADS) {
    vars.KRAKEN_TORCH_THREADS = env.KRAKEN_TORCH_THREADS;
  }

  return vars;
}

function cloneRequestWithSignal(request: Request, signal: AbortSignal): Request {
  return new Request(request, { signal });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

async function ensureKrakenContainerReady(env: Env, containerName: string): Promise<ReturnType<typeof getContainer>> {
  const container = getContainer(env.KRAKEN_CONTAINER!, containerName);
  const state = await container.getState();
  if (state.status !== "healthy" && state.status !== "running") {
    await container.start(buildStartEnv(env), {
      portToCheck: KRAKEN_CONTAINER_PORT,
      retries: 60,
      waitInterval: 500,
    });
  }
  return container;
}

async function destroyContainerQuietly(container: ReturnType<typeof getContainer>, containerName: string, reason: string): Promise<void> {
  try {
    console.warn(`[kraken] destroying container ${containerName}: ${reason}`);
    await container.destroy();
  } catch (error) {
    console.warn(`[kraken] failed to destroy container ${containerName}`, error);
  }
}

async function fetchKrakenContainerOnce(
  env: Env,
  request: Request,
  cacheKey: string | undefined,
  attempt: number,
  timeoutMs: number,
): Promise<Response> {
  const containerName = krakenContainerName(env, cacheKey, attempt);
  const container = await ensureKrakenContainerReady(env, containerName);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(`Kraken move timed out after ${timeoutMs}ms`), timeoutMs);

  try {
    return await container.fetch(cloneRequestWithSignal(request, controller.signal));
  } catch (error) {
    if (isAbortError(error)) {
      await destroyContainerQuietly(container, containerName, `request timeout after ${timeoutMs}ms`);
      throw new Error(`Kraken move timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function hasKrakenContainer(env: Env): boolean {
  return Boolean(env.KRAKEN_CONTAINER);
}

export async function fetchKrakenContainer(env: Env, request: Request, cacheKey?: string): Promise<Response> {
  if (!env.KRAKEN_CONTAINER) {
    throw new Error("kraken container is not configured");
  }

  const timeoutMs = krakenMoveTimeoutMs(env);
  let lastError: unknown = null;

  for (let attempt = 0; attempt < DEFAULT_KRAKEN_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchKrakenContainerOnce(env, request, cacheKey, attempt, timeoutMs);
      if (!isRetryableStatus(response.status) || attempt === DEFAULT_KRAKEN_MAX_ATTEMPTS - 1) {
        return response;
      }

      const containerName = krakenContainerName(env, cacheKey, attempt);
      console.warn(`[kraken] retrying after ${response.status} from ${containerName}`);
      const container = getContainer(env.KRAKEN_CONTAINER, containerName);
      await destroyContainerQuietly(container, containerName, `retryable ${response.status} response`);
      lastError = new Error(`Kraken container returned ${response.status}`);
    } catch (error) {
      lastError = error;
      if (attempt === DEFAULT_KRAKEN_MAX_ATTEMPTS - 1) {
        break;
      }
      const containerName = krakenContainerName(env, cacheKey, attempt);
      console.warn(`[kraken] retrying after failed move request on ${containerName}`, error);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Kraken container request failed");
}
