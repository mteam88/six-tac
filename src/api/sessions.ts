import { getAvailableBot } from "../backend-bots";
import { startClock } from "../domain/clock";
import { createSession, createToken, generateCode } from "../domain/session-state";
import type { BotName, ClockSettings, HumanSeat, JoinSessionResponse, SessionData } from "../domain/types";
import type { Env } from "../env";
import { forwardedHeaders, json, readJson, sessionStub } from "./utils";

async function initSession(env: Env, session: SessionData): Promise<Response> {
  return sessionStub(env, session.id).fetch("https://session/internal/init", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(session),
  });
}

async function fetchSessionState(env: Env, sessionId: string, token: string): Promise<JoinSessionResponse> {
  const response = await sessionStub(env, sessionId).fetch(
    `https://session/state?token=${encodeURIComponent(token)}`,
  );
  if (!response.ok) {
    const error = (await response.json()) as { error?: string };
    throw new Error(error.error || "Could not load session");
  }
  return {
    token,
    session: (await response.json()) as JoinSessionResponse["session"],
  };
}

export async function handleCreatePrivateSession(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ playerId?: string | null; clock?: ClockSettings | null }>(request);

  for (let attempt = 0; attempt < 16; attempt += 1) {
    const code = generateCode();
    const token = createToken();
    const session = createSession(
      {
        id: code,
        code,
        type: "private",
        participants: [
          {
            id: body.playerId || crypto.randomUUID(),
            kind: "human",
            seat: "two",
            token,
            playerId: body.playerId ?? null,
          },
        ],
        clock: body.clock ?? null,
        active: false,
      },
      Date.now(),
    );

    const response = await initSession(env, session);
    if (response.status === 409) {
      continue;
    }
    if (!response.ok) {
      return response;
    }

    return json(await fetchSessionState(env, session.id, token));
  }

  return json({ error: "Could not allocate a room code" }, 500);
}

export async function handleCreateBotSession(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{
    playerId?: string | null;
    botName?: BotName;
    clock?: ClockSettings | null;
    humanSeat?: HumanSeat;
  }>(request);
  const botName = body.botName ?? "sprout";
  const bot = await getAvailableBot(env, botName);
  if (!bot?.available) {
    return json({ error: `${botName} is not available on this backend` }, 400);
  }

  const humanSeat: HumanSeat = body.humanSeat === "one" ? "one" : "two";
  const botSeat: HumanSeat = humanSeat === "one" ? "two" : "one";
  const token = createToken();
  const now = Date.now();
  const session = createSession(
    {
      id: crypto.randomUUID(),
      code: null,
      type: "bot",
      participants: [
        {
          id: body.playerId || crypto.randomUUID(),
          kind: "human",
          seat: humanSeat,
          token,
          playerId: body.playerId ?? null,
        },
        {
          id: `bot-${crypto.randomUUID()}`,
          kind: "bot",
          seat: botSeat,
          botConfig: {
            name: bot.name,
            version: bot.version,
            execution: bot.execution,
          },
        },
      ],
      clock: body.clock ?? null,
      active: true,
    },
    now,
  );

  startClock(session.clock, "one", now);

  const response = await initSession(env, session);
  if (!response.ok) {
    return response;
  }

  return json(await fetchSessionState(env, session.id, token));
}

export async function handleJoinSession(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ code?: string; token?: string | null; playerId?: string | null }>(request);
  const code = String(body.code || "").trim();
  if (!/^\d{6}$/.test(code)) {
    return json({ error: "Room code must be 6 digits" }, 400);
  }

  return sessionStub(env, code).fetch("https://session/join", {
    method: "POST",
    headers: forwardedHeaders(request, {
      "Content-Type": "application/json",
    }),
    body: JSON.stringify({
      token: body.token ?? null,
      playerId: body.playerId ?? null,
    }),
  });
}

export async function handleSessionState(request: Request, env: Env, sessionId: string): Promise<Response> {
  const url = new URL("https://session/state");
  url.search = new URL(request.url).search;
  return sessionStub(env, sessionId).fetch(new Request(url.toString(), {
    headers: forwardedHeaders(request),
  }));
}

export async function handleSessionMove(request: Request, env: Env, sessionId: string): Promise<Response> {
  return sessionStub(env, sessionId).fetch(new Request("https://session/move", request));
}
