import initLocalEngine, {
  play_json as localPlayJson,
  snapshot_json as localSnapshotJson,
} from "./local-engine/engine.js";
import { initApp } from "./src/client/app.js";

void (async () => {
  await initLocalEngine();
  initApp({
    playJson: localPlayJson,
    snapshotJson: localSnapshotJson,
  });
})().catch((error) => {
  console.error(error);
  const errorEl = document.getElementById("lobby-error");
  if (errorEl) {
    errorEl.textContent = error instanceof Error ? error.message : "Could not load Six Tac.";
  }
});
