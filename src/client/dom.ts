export type AppElements = {
  canvas: HTMLCanvasElement;
  lobby: HTMLDivElement;
  lobbyError: HTMLDivElement;
  localModeButton: HTMLButtonElement;
  createRoomButton: HTMLButtonElement;
  playBotButton: HTMLButtonElement;
  joinRoomButton: HTMLButtonElement;
  joinCodeInput: HTMLInputElement;
  bottomBar: HTMLDivElement;
  roomCodePill: HTMLSpanElement;
  copyRoomButton: HTMLButtonElement;
  turnPill: HTMLSpanElement;
  evalPanel: HTMLDivElement;
  evalFill: HTMLDivElement;
  evalLabel: HTMLSpanElement;
  clockPanel: HTMLDivElement;
  clockOneCard: HTMLDivElement;
  clockTwoCard: HTMLDivElement;
  clockOneTime: HTMLSpanElement;
  clockTwoTime: HTMLSpanElement;
  leaveRoomButton: HTMLButtonElement;
  submitTurnButton: HTMLButtonElement;
  submitLabel: HTMLSpanElement;
  siteFooter: HTMLElement;
  settingsModal: HTMLDivElement;
  settingsTitle: HTMLHeadingElement;
  settingsClockEnabled: HTMLInputElement;
  settingsClockEnabledLabel: HTMLSpanElement;
  settingsBaseSecondsRow: HTMLLabelElement;
  settingsBaseSecondsLabel: HTMLSpanElement;
  settingsBaseSecondsInput: HTMLInputElement;
  settingsIncrementRow: HTMLLabelElement;
  settingsIncrementInput: HTMLInputElement;
  settingsBotRow: HTMLLabelElement;
  settingsBotSelect: HTMLSelectElement;
  settingsBotSeatRow: HTMLLabelElement;
  settingsBotSeatSelect: HTMLSelectElement;
  settingsHint: HTMLParagraphElement;
  settingsCancelButton: HTMLButtonElement;
  settingsSaveButton: HTMLButtonElement;
};

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing required element: #${id}`);
  }
  return element as T;
}

export function getAppElements(): AppElements {
  return {
    canvas: requiredElement("board"),
    lobby: requiredElement("lobby"),
    lobbyError: requiredElement("lobby-error"),
    localModeButton: requiredElement("local-mode-button"),
    createRoomButton: requiredElement("create-room-button"),
    playBotButton: requiredElement("play-bot-button"),
    joinRoomButton: requiredElement("join-room-button"),
    joinCodeInput: requiredElement("join-code-input"),
    bottomBar: requiredElement("bottom-bar"),
    roomCodePill: requiredElement("room-code-pill"),
    copyRoomButton: requiredElement("copy-room-button"),
    turnPill: requiredElement("turn-pill"),
    evalPanel: requiredElement("eval-panel"),
    evalFill: requiredElement("eval-fill"),
    evalLabel: requiredElement("eval-label"),
    clockPanel: requiredElement("clock-panel"),
    clockOneCard: requiredElement("clock-one"),
    clockTwoCard: requiredElement("clock-two"),
    clockOneTime: requiredElement("clock-one-time"),
    clockTwoTime: requiredElement("clock-two-time"),
    leaveRoomButton: requiredElement("leave-room-button"),
    submitTurnButton: requiredElement("submit-turn-button"),
    submitLabel: requiredElement("submit-label"),
    siteFooter: requiredElement("site-footer"),
    settingsModal: requiredElement("settings-modal"),
    settingsTitle: requiredElement("settings-title"),
    settingsClockEnabled: requiredElement("settings-clock-enabled"),
    settingsClockEnabledLabel: requiredElement("settings-clock-enabled-label"),
    settingsBaseSecondsRow: requiredElement("settings-base-seconds-row"),
    settingsBaseSecondsLabel: requiredElement("settings-base-seconds-label"),
    settingsBaseSecondsInput: requiredElement("settings-base-seconds-input"),
    settingsIncrementRow: requiredElement("settings-increment-row"),
    settingsIncrementInput: requiredElement("settings-increment-input"),
    settingsBotRow: requiredElement("settings-bot-row"),
    settingsBotSelect: requiredElement("settings-bot-select"),
    settingsBotSeatRow: requiredElement("settings-bot-seat-row"),
    settingsBotSeatSelect: requiredElement("settings-bot-seat-select"),
    settingsHint: requiredElement("settings-hint"),
    settingsCancelButton: requiredElement("settings-cancel-button"),
    settingsSaveButton: requiredElement("settings-save-button"),
  };
}
