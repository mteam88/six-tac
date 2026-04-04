import type {
  BotCatalogEntry,
  BotName,
  ClockSettings,
  Cube,
  HumanSeat,
  JoinSessionResponse,
  MatchmakingStatus,
  SessionRef,
  SessionSyncResponse,
  SessionSyncUnchanged,
  SessionView,
} from "../domain/types.js";

async function requestJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
    },
    ...options,
  });

  const data = (await response.json()) as { error?: string } & T;
  if (!response.ok) {
    throw new Error(data.error || "Request failed");
  }
  return data as T;
}

export function loadAvailableBots(): Promise<{ bots: BotCatalogEntry[] }> {
  return requestJson<{ bots: BotCatalogEntry[] }>("/api/v1/bots");
}

export function createPrivateSession(playerId: string, clock: ClockSettings | null): Promise<JoinSessionResponse> {
  return requestJson<JoinSessionResponse>("/api/v1/sessions/private", {
    method: "POST",
    body: JSON.stringify({ playerId, clock }),
  });
}

export function createBotSession(
  playerId: string,
  botName: BotName,
  humanSeat: HumanSeat,
  clock: ClockSettings | null,
): Promise<JoinSessionResponse> {
  return requestJson<JoinSessionResponse>("/api/v1/sessions/bot", {
    method: "POST",
    body: JSON.stringify({ playerId, botName, humanSeat, clock }),
  });
}

export function joinPrivateSession(code: string, token: string | null, playerId: string): Promise<JoinSessionResponse> {
  return requestJson<JoinSessionResponse>("/api/v1/sessions/join", {
    method: "POST",
    body: JSON.stringify({ code, token, playerId }),
  });
}

function isUnchangedSessionResponse(response: SessionSyncResponse): response is SessionSyncUnchanged {
  return "unchanged" in response && response.unchanged;
}

export async function loadSessionState(ref: SessionRef, previousSession: SessionView | null = null): Promise<SessionView> {
  const params = new URLSearchParams({
    token: ref.token,
  });

  if (previousSession && previousSession.mode !== "local") {
    params.set("version", String(previousSession.version));
    params.set("seat", previousSession.seat);
  }

  const response = await requestJson<SessionSyncResponse>(
    `/api/v1/sessions/${encodeURIComponent(ref.id)}/state?${params.toString()}`,
  );

  if (previousSession && isUnchangedSessionResponse(response)) {
    return {
      ...previousSession,
      seat: response.seat,
      serverNow: response.serverNow,
      version: response.version,
    };
  }

  if (isUnchangedSessionResponse(response)) {
    throw new Error("Missing previous session state");
  }

  return response;
}

export function submitSessionTurn(ref: SessionRef, stones: Cube[]): Promise<SessionView> {
  return requestJson<SessionView>(`/api/v1/sessions/${encodeURIComponent(ref.id)}/move`, {
    method: "POST",
    body: JSON.stringify({ token: ref.token, stones }),
  });
}

export function queueMatchmaking(playerId: string, clock: ClockSettings | null): Promise<MatchmakingStatus> {
  return requestJson<MatchmakingStatus>("/api/v1/matchmaking/queue", {
    method: "POST",
    body: JSON.stringify({ playerId, clock }),
  });
}

export function loadMatchmakingStatus(playerId: string): Promise<MatchmakingStatus> {
  return requestJson<MatchmakingStatus>(`/api/v1/matchmaking/status?playerId=${encodeURIComponent(playerId)}`);
}

export function cancelMatchmaking(playerId: string): Promise<MatchmakingStatus> {
  return requestJson<MatchmakingStatus>("/api/v1/matchmaking/cancel", {
    method: "POST",
    body: JSON.stringify({ playerId }),
  });
}
