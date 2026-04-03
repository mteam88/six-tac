import type { BotName, ClockSettings, Cube, JoinSessionResponse, MatchmakingStatus, SessionRef, SessionView } from "../domain/types.js";

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

export function createPrivateSession(playerId: string, clock: ClockSettings | null): Promise<JoinSessionResponse> {
  return requestJson<JoinSessionResponse>("/api/v1/sessions/private", {
    method: "POST",
    body: JSON.stringify({ playerId, clock }),
  });
}

export function createBotSession(
  playerId: string,
  botName: BotName,
  clock: ClockSettings | null,
): Promise<JoinSessionResponse> {
  return requestJson<JoinSessionResponse>("/api/v1/sessions/bot", {
    method: "POST",
    body: JSON.stringify({ playerId, botName, clock }),
  });
}

export function joinPrivateSession(code: string, token: string | null, playerId: string): Promise<JoinSessionResponse> {
  return requestJson<JoinSessionResponse>("/api/v1/sessions/join", {
    method: "POST",
    body: JSON.stringify({ code, token, playerId }),
  });
}

export function loadSessionState(ref: SessionRef): Promise<SessionView> {
  return requestJson<SessionView>(
    `/api/v1/sessions/${encodeURIComponent(ref.id)}/state?token=${encodeURIComponent(ref.token)}`,
  );
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
