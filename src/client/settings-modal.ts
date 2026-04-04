import { BOT_ORDER, buildBotCatalogEntry } from "../domain/bot.js";
import type { BotCatalogEntry, BotName, ClockSettings, HumanSeat } from "../domain/types.js";
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

export type SettingsResult = {
  clock?: ClockSettings | null;
  botName?: BotName;
  botHumanSeat?: HumanSeat;
};

function defaultAvailableBots(): BotCatalogEntry[] {
  return BOT_ORDER
    .filter((botName) => botName !== "kraken")
    .map((botName) => buildBotCatalogEntry(botName, { version: "builtin" }));
}

export class SettingsModal {
  private availableBots: BotCatalogEntry[] = defaultAvailableBots();

  constructor(private readonly elements: AppElements) {
    this.renderBotOptions();
  }

  setAvailableBots(botEntries: BotCatalogEntry[]): void {
    this.availableBots = botEntries.length > 0 ? botEntries : [buildBotCatalogEntry("sprout", { version: "builtin" })];
    this.renderBotOptions();
  }

  isOpen(): boolean {
    return !this.elements.settingsModal.classList.contains("hidden");
  }

  close(): void {
    this.elements.settingsModal.classList.add("hidden");
  }

  open(mode: SettingsMode, settings: LobbySettings): void {
    const {
      settingsModal,
      settingsBotRow,
      settingsBotSeatRow,
      settingsTitle,
      settingsHint,
      settingsSaveButton,
    } = this.elements;
    settingsModal.classList.remove("hidden");
    const showBotSettings = mode === "bot";
    settingsBotRow.classList.toggle("hidden", !showBotSettings);
    settingsBotSeatRow.classList.toggle("hidden", !showBotSettings);

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
      settingsHint.textContent = this.availableBots.map((bot) => `${bot.label}: ${bot.description}`).join(" ");
      settingsSaveButton.textContent = "Play";
      const availableBotNames = this.availableBots.map((bot) => bot.name);
      this.elements.settingsBotSelect.value = availableBotNames.includes(settings.botName)
        ? settings.botName
        : this.availableBots[0]?.name ?? "sprout";
      this.elements.settingsBotSeatSelect.value = settings.botHumanSeat;
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
      result.botHumanSeat = this.elements.settingsBotSeatSelect.value === "one" ? "one" : "two";
    }
    return result;
  }

  private renderBotOptions(): void {
    this.elements.settingsBotSelect.innerHTML = this.availableBots
      .map((bot) => `<option value="${bot.name}">${bot.label}</option>`)
      .join("");
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
