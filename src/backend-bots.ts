import { chooseBotMove as chooseEmbeddedBotMove, listBotNames as listEmbeddedBotNames } from "./bots";
import { BOT_ORDER, buildBotCatalogEntry } from "./domain/bot";
import type { BotCatalogEntry, BotName, Cube } from "./domain/types";
import type { Env } from "./env";
import { fetchKrakenContainer, hasKrakenContainer } from "./kraken-container";

const REMOTE_BOT_LIST_TTL_MS = 60_000;

type RemoteBotCache = {
  at: number;
  bots: BotCatalogEntry[];
};

type RemoteBotListPayload = {
  bots?: Array<BotName | { name?: BotName; version?: string; available?: boolean }>;
  error?: string;
};

let remoteBotCache: RemoteBotCache | null = null;

function normalizeEnvUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  let value = raw.trim();
  if (!value) return null;

  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1).trim();
  }
  if ((value.startsWith('\\"') && value.endsWith('\\"')) || (value.startsWith("\\'") && value.endsWith("\\'"))) {
    value = value.slice(2, -2).trim();
  }

  return value ? value.replace(/\/$/, "") : null;
}

function remoteServiceBaseUrl(env: Env): string | null {
  return normalizeEnvUrl(env.BOT_SERVICE_URL);
}

function embeddedBotSet(): Set<BotName> {
  return new Set(listEmbeddedBotNames());
}

function normalizeRemoteBots(payload: RemoteBotListPayload, env: Env): BotCatalogEntry[] {
  const krakenVersion = env.KRAKEN_MODEL_VERSION?.trim() || "kraken_v1";
  const bots = payload.bots ?? [];
  const entries: BotCatalogEntry[] = [];

  for (const bot of bots) {
    if (typeof bot === "string") {
      if (!BOT_ORDER.includes(bot)) continue;
      entries.push(buildBotCatalogEntry(bot, {
        execution: "remote",
        version: bot === "kraken" ? krakenVersion : "builtin",
      }));
      continue;
    }

    if (!bot?.name || !BOT_ORDER.includes(bot.name)) {
      continue;
    }
    if (bot.available === false) {
      continue;
    }

    entries.push(buildBotCatalogEntry(bot.name, {
      execution: "remote",
      version: bot.version?.trim() || (bot.name === "kraken" ? krakenVersion : "builtin"),
    }));
  }

  return entries;
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

async function listRemoteBots(env: Env): Promise<BotCatalogEntry[]> {
  const baseUrl = remoteServiceBaseUrl(env);
  if (!baseUrl) return [];

  if (remoteBotCache && Date.now() - remoteBotCache.at < REMOTE_BOT_LIST_TTL_MS) {
    return remoteBotCache.bots;
  }

  const response = await fetch(`${baseUrl}/v1/bots`);
  const data = (await response.json()) as RemoteBotListPayload;
  if (!response.ok) {
    throw new Error(data.error || "Could not load remote bot list");
  }

  const bots = normalizeRemoteBots(data, env);
  remoteBotCache = { at: Date.now(), bots };
  return bots;
}

function listEmbeddedBots(): BotCatalogEntry[] {
  const embedded = embeddedBotSet();
  return BOT_ORDER
    .filter((botName) => embedded.has(botName))
    .map((botName) => buildBotCatalogEntry(botName, { execution: "worker", version: "builtin" }));
}

function listKrakenContainerBots(env: Env): BotCatalogEntry[] {
  if (!hasKrakenContainer(env)) {
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
  const embedded = listEmbeddedBots();
  const remote = remoteServiceBaseUrl(env)
    ? await listRemoteBots(env).catch(() => [])
    : hasKrakenContainer(env)
      ? listKrakenContainerBots(env)
      : [];
  return uniqueBots([...embedded, ...remote]);
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

async function chooseRemoteBotMove(
  env: Env,
  botName: BotName,
  gameJson: string,
  cacheKey?: string,
): Promise<[Cube, Cube]> {
  const body = JSON.stringify({
    bot_name: botName,
    game_json: gameJson,
    cache_key: cacheKey ?? null,
  });

  const baseUrl = remoteServiceBaseUrl(env);
  const response = baseUrl
    ? await fetch(`${baseUrl}/v1/best-move`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body,
      })
    : botName === "kraken" && hasKrakenContainer(env)
      ? await fetchKrakenContainer(
          env,
          new Request("https://kraken.internal/v1/best-move", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body,
          }),
          cacheKey,
        )
      : (() => {
          throw new Error(`${botName} requires a configured remote runtime`);
        })();

  const data = (await response.json()) as { stones?: [Cube, Cube]; error?: string };
  if (!response.ok || !Array.isArray(data.stones) || data.stones.length !== 2) {
    throw new Error(data.error || `Could not choose a move for ${botName}`);
  }
  return data.stones;
}

export async function chooseBackendBotMove(
  env: Env,
  botName: BotName,
  gameJson: string,
  cacheKey?: string,
): Promise<[Cube, Cube]> {
  const bot = await getAvailableBot(env, botName);
  if (!bot?.available) {
    throw new Error(`${botName} is not available on this backend`);
  }

  if (bot.execution === "remote") {
    return chooseRemoteBotMove(env, botName, gameJson, cacheKey);
  }

  if (!embeddedBotSet().has(botName)) {
    throw new Error(`${botName} is not embedded in this worker build`);
  }

  return chooseEmbeddedBotMove(botName, gameJson);
}
