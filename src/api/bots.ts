import { listAvailableBots } from "../backend-bots";
import { json } from "./utils";
import type { Env } from "../env";

export async function handleBotList(env: Env): Promise<Response> {
  return json({ bots: await listAvailableBots(env) });
}
