import { MATCHMAKER_OBJECT_ID } from "../domain/types";
import type { Env } from "../env";

export const CLIENT_IP_HEADER = "x-client-ip";

export function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
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

export function clientAddress(request: Request): string {
  const forwarded = request.headers.get(CLIENT_IP_HEADER)
    ?? request.headers.get("CF-Connecting-IP")
    ?? request.headers.get("X-Forwarded-For")
    ?? "";
  const address = forwarded.split(",")[0]?.trim();
  return address || "unknown";
}

export function forwardedHeaders(request: Request, headers: HeadersInit = {}): Headers {
  const nextHeaders = new Headers(headers);
  const address = clientAddress(request);
  if (address !== "unknown") {
    nextHeaders.set(CLIENT_IP_HEADER, address);
  }
  return nextHeaders;
}

export function sessionStub(env: Env, sessionId: string): DurableObjectStub {
  return env.SESSIONS.get(env.SESSIONS.idFromName(sessionId));
}

export function matchmakerStub(env: Env): DurableObjectStub {
  return env.MATCHMAKER.get(env.MATCHMAKER.idFromName(MATCHMAKER_OBJECT_ID));
}
