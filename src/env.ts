import type { BotTurnJob } from "./bot-turn-queue";

export type Env = {
  ASSETS: Fetcher;
  SESSIONS: DurableObjectNamespace;
  MATCHMAKER: DurableObjectNamespace;
  BOT_TURNS_QUEUE: Queue<BotTurnJob>;
  BOT_SERVICE_URL?: string;
  MODAL_BOT_TOKEN?: string;
  KRAKEN_MODEL_VERSION?: string;
  KRAKEN_MOVE_TIMEOUT_MS?: string;
};
