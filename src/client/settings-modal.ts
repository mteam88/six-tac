import type { BotName, ClockSettings } from "../domain/types.js";
import type { SettingsMode } from "./app-types.js";
import type { AppElements } from "./dom.js";
import type { LobbySettings } from "./persistence.js";
import {
  DEFAULT_CLOCK_BASE_SECONDS,
  DEFAULT_CLOCK_INCREMENT_SECONDS,
  msToSeconds,
  parseNonNegativeSeconds,
  parsePositiveSeconds,
} from "./helpers.js";

export const BOT_OPTIONS: Array<{ value: BotName; label: string }> = [
  { value: "sprout", label: "Sprout" },
  { value: "seal", label: "Seal" },
  { value: "ambrosia", label: "Ambrosia" },
  { value: "hydra", label: "Hydra" },
  { value: "orca", label: "Orca" },
];

export type SettingsResult = {
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

    const clock = mode === "local"
      ? settings.localClock
      : mode === "private"
        ? settings.privateClock
        : mode === "bot"
          ? settings.botClock
          : settings.matchmakingClock;
    this.setClockFields(
      Boolean(clock),
      clock ? msToSeconds(clock.initialMs) : DEFAULT_CLOCK_BASE_SECONDS,
      clock ? msToSeconds(clock.incrementMs) : DEFAULT_CLOCK_INCREMENT_SECONDS,
    );

    if (mode === "local") {
      settingsTitle.textContent = "Local game";
      settingsHint.textContent = "Set a chess clock or play without one.";
      settingsSaveButton.textContent = "Start";
    } else if (mode === "private") {
      settingsTitle.textContent = "Create room";
      settingsHint.textContent = "These settings apply to the room you create from this device.";
      settingsSaveButton.textContent = "Create";
    } else if (mode === "bot") {
      settingsTitle.textContent = "Play bot";
      settingsHint.innerHTML = 'Sprout is random. <a href="https://github.com/Ramora0/SealBot" target="_blank" rel="noreferrer">Seal</a> is the best bot. <a href="https://github.com/hex-tic-tac-toe/ambrosia" target="_blank" rel="noreferrer">Ambrosia</a>, Hydra, and Orca are lighter in-house minimax bots.';
      settingsSaveButton.textContent = "Play";
      this.elements.settingsBotSelect.value = BOT_OPTIONS.some((option) => option.value === settings.botName) ? settings.botName : "sprout";
    } else {
      settingsTitle.textContent = "Find match";
      settingsHint.textContent = "You will only be matched with players using the same clock settings.";
      settingsSaveButton.textContent = "Queue";
    }
  }

  read(mode: SettingsMode): SettingsResult {
    const result: SettingsResult = { clock: this.readChessClock() };
    if (mode === "bot") {
      result.botName = this.elements.settingsBotSelect.value as BotName;
    }
    return result;
  }

  private setClockFields(enabled: boolean, baseSeconds: number, incrementSeconds: number): void {
    this.elements.settingsClockEnabled.checked = enabled;
    this.elements.settingsBaseSecondsInput.value = String(baseSeconds);
    this.elements.settingsIncrementInput.value = String(incrementSeconds);
    this.elements.settingsIncrementRow.classList.remove("hidden");
    this.elements.settingsBaseSecondsLabel.textContent = "Base time (seconds)";
    this.elements.settingsClockEnabledLabel.textContent = "Enable chess clock";
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
