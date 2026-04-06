import type { LobbySettings } from "./persistence.js";
import type { CameraState } from "./render.js";
import type { Cube, PositionEval, SessionRef, SessionView } from "../domain/types.js";

export type Player = "One" | "Two";

export type LocalBindings = {
  snapshotJson: (gameJson: string) => string;
  playJson: (gameJson: string, stonesJson: string) => string;
};

export type SettingsMode = "local" | "private" | "bot";

export type PointerState = {
  id: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  dragging: boolean;
};

export type PinchGesture = {
  distance: number;
  midpointX: number;
  midpointY: number;
};

export type AppState = {
  hexSize: number;
  camera: CameraState;
  hovered: Cube | null;
  selected: Cube[];
  session: SessionView | null;
  sessionRef: SessionRef | null;
  pointer: PointerState | null;
  touchPoints: Map<number, { x: number; y: number }>;
  pinchGesture: PinchGesture | null;
  multiTouchGesture: boolean;
  pollTimer: number;
  clockTimer: number;
  pendingSubmit: boolean;
  pendingBrowserBotPositionId: string | null;
  positionEval: PositionEval | null;
  pendingEvalPositionId: string | null;
  evalRequestSerial: number;
  recentHighlights: Cube[];
  playerId: string;
  settings: LobbySettings;
  activeSettingsMode: SettingsMode | null;
  serverClockOffsetMs: number;
};
