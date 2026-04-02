import { finishSession, otherSeat, playerForSeat } from "./session-state";
import type { ClockState, HumanSeat, SessionData } from "./types";

export function startClock(clock: ClockState | null, seat: HumanSeat, now: number): void {
  if (!clock || !clock.enabled) return;
  clock.activeSeat = seat;
  clock.turnStartedAt = now;
  clock.flaggedSeat = null;
}

export function pauseClock(clock: ClockState | null): void {
  if (!clock) return;
  clock.activeSeat = null;
  clock.turnStartedAt = null;
}

export function getDisplayedRemainingMs(clock: ClockState | null, seat: HumanSeat, now: number): number | null {
  if (!clock?.enabled) return null;
  if (clock.activeSeat !== seat || clock.turnStartedAt === null) {
    return clock.remainingMs[seat];
  }
  return Math.max(0, clock.remainingMs[seat] - (now - clock.turnStartedAt));
}

export function getDeadlineAt(clock: ClockState | null): number | null {
  if (!clock?.enabled || !clock.activeSeat || clock.turnStartedAt === null) {
    return null;
  }
  return clock.turnStartedAt + clock.remainingMs[clock.activeSeat];
}

export function consumeActiveTime(clock: ClockState | null, now: number): number | null {
  if (!clock?.enabled || !clock.activeSeat) {
    return null;
  }
  const remaining = getDisplayedRemainingMs(clock, clock.activeSeat, now);
  if (remaining === null) {
    return null;
  }
  clock.remainingMs[clock.activeSeat] = remaining;
  clock.turnStartedAt = now;
  return remaining;
}

export function completeMove(clock: ClockState | null, nextSeat: HumanSeat, now: number): number | null {
  if (!clock?.enabled || !clock.activeSeat) {
    return null;
  }

  const movingSeat = clock.activeSeat;
  const remaining = consumeActiveTime(clock, now);
  if (remaining === null) {
    return null;
  }
  if (remaining <= 0) {
    return remaining;
  }

  clock.remainingMs[movingSeat] += clock.incrementMs;
  clock.activeSeat = nextSeat;
  clock.turnStartedAt = now;
  clock.flaggedSeat = null;
  return clock.remainingMs[movingSeat];
}

export function expireSessionOnClock(session: SessionData, now: number): boolean {
  if (session.status !== "active" || session.result || !session.clock?.enabled) {
    return false;
  }

  const activeSeat = session.clock.activeSeat;
  if (!activeSeat) {
    return false;
  }

  const remaining = getDisplayedRemainingMs(session.clock, activeSeat, now);
  if (remaining === null || remaining > 0) {
    return false;
  }

  session.clock.remainingMs[activeSeat] = 0;
  session.clock.flaggedSeat = activeSeat;
  pauseClock(session.clock);
  finishSession(session, playerForSeat(otherSeat(activeSeat)), "timeout", now);
  return true;
}
