import type { BotName, ClockSettings } from "../domain/types.js";
import type { SettingsMode } from "./app-types.js";
import type { AppElements } from "./dom.js";
import type { LobbySettings } from "./persistence.js";
import {
  DEFAULT_CHESS_BASE_SECONDS,
  DEFAULT_CHESS_INCREMENT_SECONDS,
  DEFAULT_LOCAL_TIMER_SECONDS,
  msToSeconds,
  parseNonNegativeSeconds,
  parsePositiveSeconds,
} from "./helpers.js";

export const BOT_OPTIONS: Array<{ value: BotName; label: string }> = [
  { value: "sprout", label: "Sprout" },
  { value: "seal", label: "Seal" },
  { value: "ambrosia", label: "Ambrosia" },
];

export type SettingsResult = {
  localTimerMs?: number | null;
  clock?: ClockSettings | null;
  botName?: BotName;
};

export class SettingsModal {
  constructor(private readonly elements: AppElements) {
    this.elements.settingsBotSelect.innerHTML = BOT_OPTIONS
      .map((option) => `<option value="${option.value}">${option.label}</option>`)
      .join("");
  }

  isOpen(): boolean {
    return !this.elements.settingsModal.classList.contains("hidden");
  }

  close(): void {
    this.elements.settingsModal.classList.add("hidden");
  }

  open(mode: SettingsMode, settings: LobbySettings): void {
    const { settingsModal, settingsBotRow, settingsTitle, settingsHint, settingsSaveButton } = this.elements;
    settingsModal.classList.remove("hidden");
    settingsBotRow.classList.toggle("hidden", mode !== "bot");

    if (mode === "local") {
      settingsTitle.textContent = "Local game";
      settingsHint.textContent = "The move timer resets every turn. If time runs out, the other color wins.";
      settingsSaveButton.textContent = "Start";
      this.setClockFields(Boolean(settings.localTimerMs), settings.localTimerMs ? msToSeconds(settings.localTimerMs) : DEFAULT_LOCAL_TIMER_SECONDS, 0, true);
      return;
    }

    const clock = mode === "private" ? settings.privateClock : mode === "bot" ? settings.botClock : settings.matchmakingClock;
    this.setClockFields(Boolean(clock), clock ? msToSeconds(clock.initialMs) : DEFAULT_CHESS_BASE_SECONDS, clock ? msToSeconds(clock.incrementMs) : DEFAULT_CHESS_INCREMENT_SECONDS, false);

    if (mode === "private") {
      settingsTitle.textContent = "Create room";
      settingsHint.textContent = "These settings apply to the room you create from this device.";
      settingsSaveButton.textContent = "Create";
    } else if (mode === "bot") {
      settingsTitle.textContent = "Play bot";
      settingsHint.textContent = "Sprout is random. Seal searches. Ambrosia is a translated feature-based heuristic bot.";
      settingsSaveButton.textContent = "Play";
      this.elements.settingsBotSelect.value = settings.botName;
    } else {
      settingsTitle.textContent = "Find match";
      settingsHint.textContent = "You will only be matched with players using the same clock settings.";
      settingsSaveButton.textContent = "Queue";
    }
  }

  read(mode: SettingsMode): SettingsResult {
    if (mode === "local") {
      return { localTimerMs: this.readLocalTimer() };
    }
    const result: SettingsResult = { clock: this.readChessClock() };
    if (mode === "bot") {
      result.botName = this.elements.settingsBotSelect.value as BotName;
    }
    return result;
  }

  private setClockFields(enabled: boolean, baseSeconds: number, incrementSeconds: number, localMode: boolean): void {
    this.elements.settingsClockEnabled.checked = enabled;
    this.elements.settingsBaseSecondsInput.value = String(baseSeconds);
    this.elements.settingsIncrementInput.value = String(incrementSeconds);
    this.elements.settingsIncrementRow.classList.toggle("hidden", localMode);
    this.elements.settingsBaseSecondsLabel.textContent = localMode ? "Move timer (seconds)" : "Base time (seconds)";
    this.elements.settingsClockEnabledLabel.textContent = localMode ? "Enable move timer" : "Enable chess clock";
  }

  private readLocalTimer(): number | null {
    return this.elements.settingsClockEnabled.checked
      ? parsePositiveSeconds(this.elements.settingsBaseSecondsInput.value.trim(), "Move timer")
      : null;
  }

  private readChessClock(): ClockSettings | null {
    if (!this.elements.settingsClockEnabled.checked) {
      return null;
    }
    return {
      initialMs: parsePositiveSeconds(this.elements.settingsBaseSecondsInput.value.trim(), "Base time"),
      incrementMs: parseNonNegativeSeconds(this.elements.settingsIncrementInput.value.trim(), "Increment"),
    };
  }
}
