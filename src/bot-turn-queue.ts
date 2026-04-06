import { chooseBackendBotMove } from "./backend-bots";
import { sessionStub } from "./api/utils";
import type { BotName, Cube } from "./domain/types";
import type { Env } from "./env";

type BotJobCheckResponse = {
  current: boolean;
};

type BotJobApplyResponse = {
  applied: boolean;
};

export type BotTurnJob = {
  sessionId: string;
  version: number;
  botName: BotName;
  turnsJson: string;
};

async function checkBotJob(env: Env, sessionId: string, version: number): Promise<boolean> {
  const response = await sessionStub(env, sessionId).fetch("https://session/internal/bot-job/check", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ version }),
  });
  if (!response.ok) {
    throw new Error(`bot job check failed with ${response.status}`);
  }
  return ((await response.json()) as BotJobCheckResponse).current;
}

async function applyBotJob(
  env: Env,
  sessionId: string,
  version: number,
  stones: [Cube, Cube],
): Promise<boolean> {
  const response = await sessionStub(env, sessionId).fetch("https://session/internal/bot-job/apply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ version, stones }),
  });
  if (!response.ok) {
    throw new Error(`bot job apply failed with ${response.status}`);
  }
  return ((await response.json()) as BotJobApplyResponse).applied;
}

async function failBotJob(env: Env, sessionId: string, version: number, error: string): Promise<void> {
  await sessionStub(env, sessionId).fetch("https://session/internal/bot-job/fail", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ version, error }),
  });
}

async function processBotTurnMessage(message: Message<BotTurnJob>, env: Env): Promise<void> {
  const job = message.body;

  if (!(await checkBotJob(env, job.sessionId, job.version))) {
    message.ack();
    return;
  }

  try {
    const stones = await chooseBackendBotMove(env, job.botName, job.turnsJson);
    const applied = await applyBotJob(env, job.sessionId, job.version, stones);
    if (!applied) {
      message.ack();
      return;
    }
    message.ack();
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    console.error("bot turn failed", {
      sessionId: job.sessionId,
      version: job.version,
      botName: job.botName,
      error: messageText,
    });
    await failBotJob(env, job.sessionId, job.version, messageText).catch((failError) => {
      console.error("bot turn fail callback failed", failError);
    });
    message.retry();
  }
}

export async function handleBotTurnBatch(batch: MessageBatch<BotTurnJob>, env: Env): Promise<void> {
  await Promise.all(batch.messages.map((message) => processBotTurnMessage(message, env)));
}
