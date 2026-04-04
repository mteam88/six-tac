import { Container, getContainer } from "@cloudflare/containers";
import type { Env } from "./env";

const KRAKEN_CONTAINER_PORT = 8788;
const DEFAULT_KRAKEN_POOL_SIZE = 2;

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

function krakenContainerName(env: Env, cacheKey?: string): string {
  const poolSize = krakenPoolSize(env);
  if (poolSize <= 1) {
    return "kraken-0";
  }
  const shard = hashString(cacheKey || "kraken") % poolSize;
  return `kraken-${shard}`;
}

function buildStartEnv(env: Env): Record<string, string> {
  const vars: Record<string, string> = {
    BOT_SERVICE_ADDR: `0.0.0.0:${KRAKEN_CONTAINER_PORT}`,
    KRAKEN_BUILD_EXTENSIONS: env.KRAKEN_BUILD_EXTENSIONS || "0",
    KRAKEN_DEVICE: env.KRAKEN_DEVICE || "cpu",
    KRAKEN_MODEL_VERSION: env.KRAKEN_MODEL_VERSION || "kraken_v1",
    KRAKEN_PYTHON_EXECUTABLE: env.KRAKEN_PYTHON_EXECUTABLE || "python3",
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

export function hasKrakenContainer(env: Env): boolean {
  return Boolean(env.KRAKEN_CONTAINER);
}

export async function fetchKrakenContainer(env: Env, request: Request, cacheKey?: string): Promise<Response> {
  if (!env.KRAKEN_CONTAINER) {
    throw new Error("kraken container is not configured");
  }

  const container = getContainer(env.KRAKEN_CONTAINER, krakenContainerName(env, cacheKey));
  const state = await container.getState();
  if (state.status !== "healthy" && state.status !== "running") {
    await container.start(buildStartEnv(env), {
      portToCheck: KRAKEN_CONTAINER_PORT,
      retries: 60,
      waitInterval: 500,
    });
  }

  return container.fetch(request);
}
