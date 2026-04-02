import { MATCHMAKER_OBJECT_ID } from "../domain/types";
import type { Env } from "../env";

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export async function readJson<T>(request: Request): Promise<T> {
  const text = await request.text();
  if (!text.trim()) {
    return {} as T;
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("Invalid JSON body");
  }
}

export function sessionStub(env: Env, sessionId: string): DurableObjectStub {
  return env.SESSIONS.get(env.SESSIONS.idFromName(sessionId));
}

export function matchmakerStub(env: Env): DurableObjectStub {
  return env.MATCHMAKER.get(env.MATCHMAKER.idFromName(MATCHMAKER_OBJECT_ID));
}
