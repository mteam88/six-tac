export type AppElements = {
  canvas: HTMLCanvasElement;
  lobby: HTMLDivElement;
  lobbyError: HTMLDivElement;
  localModeButton: HTMLButtonElement;
  createRoomButton: HTMLButtonElement;
  playBotButton: HTMLButtonElement;
  importGameButton: HTMLButtonElement;
  importGameInput: HTMLInputElement;
  findMatchButton: HTMLButtonElement;
  joinRoomButton: HTMLButtonElement;
  joinCodeInput: HTMLInputElement;
  bottomBar: HTMLDivElement;
  roomCodePill: HTMLSpanElement;
  copyRoomButton: HTMLButtonElement;
  turnPill: HTMLSpanElement;
  clockPanel: HTMLDivElement;
  clockOneCard: HTMLDivElement;
  clockTwoCard: HTMLDivElement;
  clockOneTime: HTMLSpanElement;
  clockTwoTime: HTMLSpanElement;
  reviewPanel: HTMLDivElement;
  reviewTitle: HTMLSpanElement;
  reviewStatus: HTMLSpanElement;
  reviewStartButton: HTMLButtonElement;
  reviewPrevButton: HTMLButtonElement;
  reviewNextButton: HTMLButtonElement;
  reviewEndButton: HTMLButtonElement;
  leaveRoomButton: HTMLButtonElement;
  submitTurnButton: HTMLButtonElement;
  submitLabel: HTMLSpanElement;
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
    importGameButton: requiredElement("import-game-button"),
    importGameInput: requiredElement("import-game-input"),
    findMatchButton: requiredElement("find-match-button"),
    joinRoomButton: requiredElement("join-room-button"),
    joinCodeInput: requiredElement("join-code-input"),
    bottomBar: requiredElement("bottom-bar"),
    roomCodePill: requiredElement("room-code-pill"),
    copyRoomButton: requiredElement("copy-room-button"),
    turnPill: requiredElement("turn-pill"),
    clockPanel: requiredElement("clock-panel"),
    clockOneCard: requiredElement("clock-one"),
    clockTwoCard: requiredElement("clock-two"),
    clockOneTime: requiredElement("clock-one-time"),
    clockTwoTime: requiredElement("clock-two-time"),
    reviewPanel: requiredElement("review-panel"),
    reviewTitle: requiredElement("review-title"),
    reviewStatus: requiredElement("review-status"),
    reviewStartButton: requiredElement("review-start-button"),
    reviewPrevButton: requiredElement("review-prev-button"),
    reviewNextButton: requiredElement("review-next-button"),
    reviewEndButton: requiredElement("review-end-button"),
    leaveRoomButton: requiredElement("leave-room-button"),
    submitTurnButton: requiredElement("submit-turn-button"),
    submitLabel: requiredElement("submit-label"),
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
    settingsHint: requiredElement("settings-hint"),
    settingsCancelButton: requiredElement("settings-cancel-button"),
    settingsSaveButton: requiredElement("settings-save-button"),
  };
}
