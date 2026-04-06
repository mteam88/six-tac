export type Seat = "one" | "two" | "spectator" | "local";
export type HumanSeat = "one" | "two";
export type Player = "One" | "Two";
export type SessionMode = "local" | "private" | "bot";
export type SessionStatus = "waiting" | "active" | "finished" | "abandoned";
export type FinishReason = "win" | "timeout" | "abandoned" | null;
export type BotName = "sprout" | "seal" | "ambrosia" | "hydra" | "orca" | "kraken";
export type BotExecution = "browser" | "remote";

export type BotCatalogEntry = {
  name: BotName;
  label: string;
  description: string;
  execution: BotExecution;
  version: string;
  available: boolean;
  offlineCapable: boolean;
};

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
    version?: string;
    execution?: BotExecution;
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
  version: number;
  createdAt: number;
  updatedAt: number;
  turnsJson: string;
  participants: Participant[];
  clock: ClockState | null;
  result: SessionResult;
};

export type CurrentActor = {
  seat: HumanSeat;
  kind: "human" | "bot";
  botName: BotName | null;
  execution: BotExecution | null;
};

export type PositionEval = {
  positionId: string;
  score: number;
  winProb: number;
  bestMove: [Cube, Cube] | null;
  updatedAt: number;
};

export type SessionView = {
  id: string;
  code: string | null;
  mode: SessionMode;
  seat: Seat;
  status: SessionStatus;
  currentPlayer: Player;
  currentActor: CurrentActor | null;
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
  positionId: string;
  latestEval: PositionEval | null;
  pendingRemoteMove: boolean;
  lastRemoteError: string | null;
};

export type SessionSyncUnchanged = {
  unchanged: true;
  seat: Seat;
  serverNow: number;
  positionId: string;
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

export type ComputePosition = {
  turnsJson: string;
};

export type BestMoveComputeRequest = {
  position: ComputePosition;
  config: {
    botName: BotName;
  };
  cacheKey?: string | null;
};

export type BestMoveComputeResult = {
  stones: [Cube, Cube];
  modelVersion: string;
  positionId: string;
};

export type EvalComputeRequest = {
  position: ComputePosition;
  config: {
    botName: BotName;
  };
  cacheKey?: string | null;
};

export type EvalComputeResult = {
  score: number;
  winProb: number;
  bestMove: [Cube, Cube] | null;
  modelVersion: string;
  positionId: string;
};

export type ComputeJobStatus = "queued" | "running" | "done" | "failed";
export type ComputeJobKind = "best-move" | "eval";

export type ComputeJobCallback =
  | {
      type: "session-remote-move";
      sessionId: string;
      basePositionId: string;
    }
  | {
      type: "session-eval";
      sessionId: string;
      positionId: string;
    };

export type ComputeJobRecord = {
  id: string;
  kind: ComputeJobKind;
  status: ComputeJobStatus;
  positionId: string;
  request: BestMoveComputeRequest | EvalComputeRequest;
  result: BestMoveComputeResult | EvalComputeResult | null;
  error: string | null;
  callback: ComputeJobCallback | null;
  createdAt: number;
  updatedAt: number;
};

export type ComputeJobEnvelope = {
  jobId: string;
};

export const EMPTY_GAME_JSON = '{"turns":[]}';
export const ROOM_QUERY_PARAM = "room";
