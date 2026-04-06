import { expect, test } from "@playwright/test";

const BOT_SESSION = {
  id: "bot-session-1",
  code: null,
  mode: "bot",
  seat: "one",
  status: "active",
  currentPlayer: "One",
  currentActor: {
    seat: "one",
    kind: "human",
    botName: null,
    execution: null,
  },
  winner: null,
  resultReason: null,
  yourTurn: true,
  turns: 0,
  stones: [
    { x: 0, y: 0, z: 0, player: "One" },
    { x: 1, y: -1, z: 0, player: "Two" },
  ],
  lastTurnPlayer: null,
  lastTurnStones: [],
  gameJson: '{"turns":[]}',
  clock: null,
  serverNow: 1_775_503_500_000,
  positionId: "position-1",
  pendingRemoteMove: false,
  lastRemoteError: null,
};

test.beforeEach(async ({ page }) => {
  await page.route("**/api/v1/bots", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        bots: [
          { name: "sprout", label: "Sprout", description: "Random legal-move baseline.", execution: "browser", version: "builtin", available: true, offlineCapable: true },
          { name: "kraken", label: "Kraken", description: "Hosted Kraken.", execution: "remote", version: "kraken_v1", available: true, offlineCapable: false },
        ],
      }),
    });
  });

  await page.goto("/");
});

test("landing page buttons open the expected flows", async ({ page }) => {
  await page.getByRole("button", { name: "Local" }).click();
  await expect(page.locator("#settings-modal")).toBeVisible();
  await expect(page.locator("#settings-title")).toHaveText("Local game");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator("#settings-modal")).toBeHidden();

  await page.getByRole("button", { name: "Create room" }).click();
  await expect(page.locator("#settings-modal")).toBeVisible();
  await expect(page.locator("#settings-title")).toHaveText("Create room");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator("#settings-modal")).toBeHidden();

  await page.getByRole("button", { name: "Play bot" }).click();
  await expect(page.locator("#settings-modal")).toBeVisible();
  await expect(page.locator("#settings-title")).toHaveText("Play bot");
});

test("local mode can start without loading browser bot wasm", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));

  await page.getByRole("button", { name: "Local" }).click();
  await page.getByRole("button", { name: "Start" }).click();

  await expect(page.locator("#bottom-bar")).toBeVisible();
  await expect(page.locator("#turn-pill")).toContainText("to move");
  await expect(page.locator("#lobby")).toBeHidden();
  expect(requests.some((url) => url.includes("browser-bots.js"))).toBe(false);
});

test("remote bot sessions fetch eval client-side and render the eval bar", async ({ page }) => {
  let evalCalls = 0;

  await page.route("**/api/v1/sessions/bot", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        token: "token-1",
        session: BOT_SESSION,
      }),
    });
  });

  await page.route("**/api/v1/sessions/*/state**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        unchanged: true,
        seat: "one",
        serverNow: BOT_SESSION.serverNow + 1000,
        positionId: BOT_SESSION.positionId,
      }),
    });
  });

  await page.route("**/api/v1/compute/eval", async (route) => {
    evalCalls += 1;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        positionId: BOT_SESSION.positionId,
        score: 0.48,
        winProb: 0.62,
        bestMove: [
          { x: 0, y: 1, z: -1 },
          { x: -1, y: 0, z: 1 },
        ],
        modelVersion: "kraken_v1",
      }),
    });
  });

  await page.getByRole("button", { name: "Play bot" }).click();
  await page.locator("#settings-save-button").click();

  await expect(page.locator("#bottom-bar")).toBeVisible();
  await expect(page.locator("#eval-panel")).toBeVisible();
  await expect(page.locator("#eval-label")).toHaveText("Red 62%");
  expect(evalCalls).toBe(1);
});
