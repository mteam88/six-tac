import { chooseBotMove as chooseEmbeddedBotMove, listBotNames as listEmbeddedBotNames } from "./bots";
import { BOT_ORDER, buildBotCatalogEntry } from "./domain/bot";
import type { BotCatalogEntry, BotName, Cube } from "./domain/types";
import type { Env } from "./env";

const DEFAULT_REMOTE_BOT_MOVE_TIMEOUT_MS = 30_000;

function normalizeEnvUrl(raw: string | undefined): string | null {
  if (!raw) return null;
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

function remoteMoveTimeoutMs(env: Env): number {
  return parsePositiveInt(env.KRAKEN_MOVE_TIMEOUT_MS, DEFAULT_REMOTE_BOT_MOVE_TIMEOUT_MS);
}

function embeddedBotSet(): Set<BotName> {
  return new Set(listEmbeddedBotNames());
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

function listEmbeddedBots(): BotCatalogEntry[] {
  const embedded = embeddedBotSet();
  return BOT_ORDER
    .filter((botName) => embedded.has(botName))
    .map((botName) => buildBotCatalogEntry(botName, { execution: "worker", version: "builtin" }));
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
  return uniqueBots([...listEmbeddedBots(), ...listRemoteBots(env)]);
}

export async function listAvailableBotNames(env: Env): Promise<BotName[]> {
  return (await listAvailableBots(env)).map((bot) => bot.name);
}

export async function getAvailableBot(env: Env, botName: BotName): Promise<BotCatalogEntry | null> {
  return (await listAvailableBots(env)).find((bot) => bot.name === botName) ?? null;
}

export async function hasAvailableBot(env: Env, botName: BotName): Promise<boolean> {
  return Boolean(await getAvailableBot(env, botName));
}

function fetchWithTimeout(resource: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(`Remote bot move timed out after ${timeoutMs}ms`), timeoutMs);
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

async function chooseRemoteBotMove(
  env: Env,
  botName: BotName,
  gameJson: string,
): Promise<[Cube, Cube]> {
  const baseUrl = remoteServiceBaseUrl(env);
  if (!baseUrl) {
    throw new Error("BOT_SERVICE_URL is not configured");
  }

  const token = env.MODAL_BOT_TOKEN?.trim();
  if (!token) {
    throw new Error("MODAL_BOT_TOKEN is not configured");
  }

  const response = await fetchWithTimeout(`${baseUrl}/v1/best-move`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      bot_name: botName,
      game_json: gameJson,
    }),
  }, remoteMoveTimeoutMs(env));

  const data = (await response.json()) as { stones?: unknown[]; error?: string };
  const first = axialToCube(data.stones?.[0]);
  const second = axialToCube(data.stones?.[1]);
  if (!response.ok || !first || !second) {
    throw new Error(data.error || `Could not choose a move for ${botName}`);
  }

  return [first, second];
}

export async function chooseBackendBotMove(
  env: Env,
  botName: BotName,
  gameJson: string,
): Promise<[Cube, Cube]> {
  const bot = await getAvailableBot(env, botName);
  if (!bot?.available) {
    throw new Error(`${botName} is not available on this backend`);
  }

  if (bot.execution === "remote") {
    return chooseRemoteBotMove(env, botName, gameJson);
  }

  if (!embeddedBotSet().has(botName)) {
    throw new Error(`${botName} is not embedded in this worker build`);
  }

  return chooseEmbeddedBotMove(botName, gameJson);
}
