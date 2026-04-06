import { BOT_ORDER, buildBotCatalogEntry } from "./domain/bot";
import { positionIdForTurnsJson } from "./domain/position";
import type {
  BestMoveComputeRequest,
  BestMoveComputeResult,
  BotCatalogEntry,
  BotName,
  Cube,
  EvalComputeRequest,
  EvalComputeResult,
} from "./domain/types";
import type { Env } from "./env";

const DEFAULT_REMOTE_TIMEOUT_MS = 30_000;

function normalizeEnvUrl(raw: string | undefined): string | null {
  if (!raw) {
    return null;
  }
  const value = raw.trim().replace(/^['"]|['"]$/g, "").replace(/\/$/, "");
  return value || null;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value || "");
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function remoteServiceBaseUrl(env: Env): string | null {
  return normalizeEnvUrl(env.BOT_SERVICE_URL);
}

function remoteTimeoutMs(env: Env): number {
  return parsePositiveInt(env.KRAKEN_MOVE_TIMEOUT_MS, DEFAULT_REMOTE_TIMEOUT_MS);
}

function uniqueBots(botEntries: BotCatalogEntry[]): BotCatalogEntry[] {
  const seen = new Set<BotName>();
  const unique: BotCatalogEntry[] = [];
  for (const botName of BOT_ORDER) {
    const entry = botEntries.find((candidate) => candidate.name === botName);
    if (!entry || seen.has(entry.name)) {
      continue;
    }
    seen.add(entry.name);
    unique.push(entry);
  }
  return unique;
}

function listBrowserBots(): BotCatalogEntry[] {
  return BOT_ORDER
    .filter((botName) => botName !== "kraken")
    .map((botName) => buildBotCatalogEntry(botName, { execution: "browser", version: "builtin" }));
}

function listRemoteBots(env: Env): BotCatalogEntry[] {
  if (!remoteServiceBaseUrl(env)) {
    return [];
  }

  return [
    buildBotCatalogEntry("kraken", {
      execution: "remote",
      version: env.KRAKEN_MODEL_VERSION?.trim() || "kraken_v1",
    }),
  ];
}

export async function listAvailableBots(env: Env): Promise<BotCatalogEntry[]> {
  return uniqueBots([...listBrowserBots(), ...listRemoteBots(env)]);
}

export async function getAvailableBot(env: Env, botName: BotName): Promise<BotCatalogEntry | null> {
  return (await listAvailableBots(env)).find((bot) => bot.name === botName) ?? null;
}

function fetchWithTimeout(resource: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(`Remote compute timed out after ${timeoutMs}ms`), timeoutMs);
  return fetch(resource, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

function axialToCube(value: unknown): Cube | null {
  if (!Array.isArray(value) || value.length !== 2) {
    return null;
  }

  const [x, z] = value;
  if (!Number.isFinite(x) || !Number.isFinite(z)) {
    return null;
  }

  return {
    x,
    y: -x - z,
    z,
  };
}

function requireRemoteAuthToken(env: Env): string {
  const token = env.MODAL_BOT_TOKEN?.trim();
  if (!token) {
    throw new Error("MODAL_BOT_TOKEN is not configured");
  }
  return token;
}

async function postRemote<T>(env: Env, path: string, body: unknown): Promise<T> {
  const baseUrl = remoteServiceBaseUrl(env);
  if (!baseUrl) {
    throw new Error("BOT_SERVICE_URL is not configured");
  }

  const response = await fetchWithTimeout(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireRemoteAuthToken(env)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  }, remoteTimeoutMs(env));

  const data = await response.json().catch(() => ({})) as { error?: string } & T;
  if (!response.ok) {
    throw new Error(data.error || `Remote request failed with ${response.status}`);
  }
  return data;
}

export async function chooseRemoteBestMove(env: Env, request: BestMoveComputeRequest): Promise<BestMoveComputeResult> {
  if (request.config.botName !== "kraken") {
    throw new Error(`${request.config.botName} is browser-only and not available on the server`);
  }

  const data = await postRemote<{ stones?: unknown[]; model_version?: string }>(env, "/v1/best-move", {
    bot_name: request.config.botName,
    game_json: request.position.turnsJson,
    cache_key: request.cacheKey ?? undefined,
  });

  const first = axialToCube(data.stones?.[0]);
  const second = axialToCube(data.stones?.[1]);
  if (!first || !second) {
    throw new Error("Remote best-move returned no move");
  }

  return {
    stones: [first, second],
    modelVersion: data.model_version || env.KRAKEN_MODEL_VERSION?.trim() || "kraken_v1",
    positionId: await positionIdForTurnsJson(request.position.turnsJson),
  };
}

export async function evaluateRemotePosition(env: Env, request: EvalComputeRequest): Promise<EvalComputeResult> {
  if (request.config.botName !== "kraken") {
    throw new Error(`${request.config.botName} is browser-only and not available on the server`);
  }

  const data = await postRemote<{
    score?: unknown;
    win_prob?: unknown;
    best_move?: unknown[] | null;
    model_version?: string;
  }>(env, "/v1/eval", {
    bot_name: request.config.botName,
    game_json: request.position.turnsJson,
    cache_key: request.cacheKey ?? undefined,
  });

  const bestFirst = Array.isArray(data.best_move) ? axialToCube(data.best_move[0]) : null;
  const bestSecond = Array.isArray(data.best_move) ? axialToCube(data.best_move[1]) : null;

  const score = Number(data.score);
  const winProb = Number(data.win_prob);
  if (!Number.isFinite(score) || !Number.isFinite(winProb)) {
    throw new Error("Remote eval returned invalid score");
  }

  return {
    score,
    winProb,
    bestMove: bestFirst && bestSecond ? [bestFirst, bestSecond] : null,
    modelVersion: data.model_version || env.KRAKEN_MODEL_VERSION?.trim() || "kraken_v1",
    positionId: await positionIdForTurnsJson(request.position.turnsJson),
  };
}
