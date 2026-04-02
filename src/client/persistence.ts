import type { BotName, ClockSettings, SessionRef } from "../domain/types.js";

export const SESSION_KEY = "six-tac-session";
export const LOCAL_GAME_KEY = "six-tac-local-game";
export const PLAYER_ID_KEY = "six-tac-player-id";
export const SETTINGS_KEY = "six-tac-settings";
export const POLL_INTERVAL_MS = 1200;

export type LobbySettings = {
  privateClock: ClockSettings | null;
  botClock: ClockSettings | null;
  botName: BotName;
  matchmakingClock: ClockSettings | null;
};

const DEFAULT_SETTINGS: LobbySettings = {
  privateClock: null,
  botClock: null,
  botName: "sprout",
  matchmakingClock: null,
};

export function loadSettings(): LobbySettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<LobbySettings> & {
      privateClockTurnMs?: number | null;
      botClockTurnMs?: number | null;
      matchmakingClockTurnMs?: number | null;
    };
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      privateClock: parsed.privateClock ?? (parsed.privateClockTurnMs ? { initialMs: parsed.privateClockTurnMs, incrementMs: 0 } : null),
      botClock: parsed.botClock ?? (parsed.botClockTurnMs ? { initialMs: parsed.botClockTurnMs, incrementMs: 0 } : null),
      matchmakingClock: parsed.matchmakingClock ?? (parsed.matchmakingClockTurnMs ? { initialMs: parsed.matchmakingClockTurnMs, incrementMs: 0 } : null),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: LobbySettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export function loadSession(): SessionRef | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SessionRef;
    if (!parsed.id || !parsed.token) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveSession(session: SessionRef | null): void {
  if (!session) {
    localStorage.removeItem(SESSION_KEY);
    return;
  }
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function loadLocalGame(): string | null {
  const raw = localStorage.getItem(LOCAL_GAME_KEY);
  return raw && raw.trim() ? raw : null;
}

export function saveLocalGame(gameJson: string | null): void {
  if (!gameJson) {
    localStorage.removeItem(LOCAL_GAME_KEY);
    return;
  }
  localStorage.setItem(LOCAL_GAME_KEY, gameJson);
}

export function ensurePlayerId(): string {
  let playerId = localStorage.getItem(PLAYER_ID_KEY);
  if (!playerId) {
    playerId = crypto.randomUUID();
    localStorage.setItem(PLAYER_ID_KEY, playerId);
  }
  return playerId;
}
