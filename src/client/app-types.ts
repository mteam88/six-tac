import type { LobbySettings } from "./persistence.js";
import type { CameraState } from "./render.js";
import type { Cube, FrontendGameFile, SessionRef, SessionView } from "../domain/types.js";

export type Player = "One" | "Two";

export type LocalBindings = {
  snapshotJson: (gameJson: string) => string;
  playJson: (gameJson: string, stonesJson: string) => string;
};

export type SettingsMode = "local" | "private" | "bot" | "matchmade";

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

export type ReviewState = {
  title: string;
  game: FrontendGameFile;
  history: string[];
  index: number;
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
  matchmakingTimer: number;
  clockTimer: number;
  pendingSubmit: boolean;
  recentHighlights: Cube[];
  playerId: string;
  settings: LobbySettings;
  activeSettingsMode: SettingsMode | null;
  matchmakingQueued: boolean;
  serverClockOffsetMs: number;
  review: ReviewState | null;
};
