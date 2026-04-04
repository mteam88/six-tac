export type Seat = "one" | "two" | "spectator" | "local";
export type HumanSeat = "one" | "two";
export type Player = "One" | "Two";
export type SessionMode = "local" | "private" | "bot" | "matchmade";
export type SessionStatus = "waiting" | "active" | "finished" | "abandoned";
export type FinishReason = "win" | "timeout" | "abandoned" | null;
export type BotName = "sprout" | "seal" | "ambrosia" | "hydra" | "orca";

export type Cube = {
  x: number;
  y: number;
  z: number;
};

export type Stone = Cube & {
  player: Player;
};

export type EngineSnapshot = {
  current_player: Player;
  winner: Player | null;
  turn_count: number;
  stone_count: number;
  turns_json: string;
  stones: Stone[];
};

export type ClockSettings = {
  initialMs: number;
  incrementMs: number;
};

export type ClockState = {
  enabled: boolean;
  type: "chess";
  initialMs: number;
  incrementMs: number;
  activeSeat: HumanSeat | null;
  turnStartedAt: number | null;
  remainingMs: {
    one: number;
    two: number;
  };
  flaggedSeat: HumanSeat | null;
};

export type Participant = {
  id: string;
  kind: "human" | "bot";
  seat: HumanSeat;
  token?: string;
  playerId?: string | null;
  botConfig?: {
    name: BotName;
  };
};

export type SessionResult = {
  winner: Player | null;
  reason: FinishReason;
} | null;

export type SessionData = {
  id: string;
  code: string | null;
  type: SessionMode;
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
  turnsJson: string;
  participants: Participant[];
  clock: ClockState | null;
  result: SessionResult;
};

export type SessionView = {
  id: string;
  code: string | null;
  mode: SessionMode;
  seat: Seat;
  status: SessionStatus;
  currentPlayer: Player;
  winner: Player | null;
  resultReason: FinishReason;
  yourTurn: boolean;
  turns: number;
  stones: Stone[];
  lastTurnPlayer: Player | null;
  lastTurnStones: Cube[];
  gameJson: string;
  clock: ClockState | null;
  serverNow: number;
  version: number;
};

export type SessionSyncUnchanged = {
  unchanged: true;
  seat: Seat;
  serverNow: number;
  version: number;
};

export type SessionSyncResponse = SessionView | SessionSyncUnchanged;

export type SessionRef = {
  id: string;
  code: string | null;
  token: string;
};

export type JoinSessionResponse = {
  token: string;
  session: SessionView;
};

export type MatchmakingStatus =
  | {
      status: "idle";
    }
  | {
      status: "queued";
      queuedAt: number;
      clock: ClockSettings | null;
    }
  | {
      status: "matched";
      ref: SessionRef;
      session: SessionView;
    };

export const EMPTY_GAME_JSON = '{"turns":[]}';
export const ROOM_QUERY_PARAM = "room";
export const MATCHMAKER_OBJECT_ID = "global";
