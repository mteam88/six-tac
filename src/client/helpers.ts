import type { ClockState, Cube, SessionView } from "../domain/types.js";
import type { Player } from "./app-types.js";

export const TAP_SLOP = 8;
export const DEFAULT_LOCAL_TIMER_SECONDS = 30;
export const DEFAULT_CHESS_BASE_SECONDS = 180;
export const DEFAULT_CHESS_INCREMENT_SECONDS = 0;

export function sameCube(a: Cube | null, b: Cube | null): boolean {
  return Boolean(a && b && a.x === b.x && a.y === b.y && a.z === b.z);
}

export function cubeDistance(a: Cube, b: Cube): number {
  return (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z)) / 2;
}

export function seatPlayer(seat: SessionView["seat"]): Player | null {
  return seat === "one" ? "One" : seat === "two" ? "Two" : null;
}

export function playerSeat(player: Player): "one" | "two" {
  return player === "One" ? "one" : "two";
}

export function currentControllingPlayer(session: SessionView): Player | null {
  return session.mode === "local" ? session.currentPlayer : seatPlayer(session.seat);
}

export function cloneClock(clock: ClockState | null): ClockState | null {
  return clock ? JSON.parse(JSON.stringify(clock)) as ClockState : null;
}

export function secondsToMs(seconds: number): number {
  return Math.round(seconds * 1000);
}

export function msToSeconds(ms: number): number {
  return Math.max(0, Math.round(ms / 1000));
}

export function parsePositiveSeconds(value: string, label: string): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`${label} must be greater than 0 seconds`);
  }
  return secondsToMs(seconds);
}

export function parseNonNegativeSeconds(value: string, label: string): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error(`${label} must be 0 or more seconds`);
  }
  return secondsToMs(seconds);
}

export function formatRoomCode(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3, 6)}`;
}

export function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function loadRoomCodeFromUrl(param: string): string {
  return new URL(window.location.href).searchParams.get(param)?.replace(/\D+/g, "").slice(0, 6) ?? "";
}

export function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch(() => undefined);
  });
}
