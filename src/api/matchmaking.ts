import type { Env } from "../env";
import { matchmakerStub } from "./utils";

export async function handleQueueMatchmaking(request: Request, env: Env): Promise<Response> {
  return matchmakerStub(env).fetch(new Request("https://matchmaker/queue", request));
}

export async function handleMatchmakingStatus(request: Request, env: Env): Promise<Response> {
  const url = new URL("https://matchmaker/status");
  url.search = new URL(request.url).search;
  return matchmakerStub(env).fetch(url.toString());
}

export async function handleCancelMatchmaking(request: Request, env: Env): Promise<Response> {
  return matchmakerStub(env).fetch(new Request("https://matchmaker/cancel", request));
}
