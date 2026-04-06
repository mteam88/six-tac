// @ts-ignore generated at build time
import * as bindings from "./bot-wasm/bots_bg.js";
// @ts-ignore generated at build time
import wasmModule from "./bot-wasm/bots_bg.wasm";
import type { BotName, Cube } from "./domain/types";

const instance = new WebAssembly.Instance(wasmModule, {
  "./bots_bg.js": bindings,
});

bindings.__wbg_set_wasm(instance.exports);
(instance.exports as { __wbindgen_start?: () => void }).__wbindgen_start?.();

const exports = bindings as {
  best_move_json: (botName: string, gameJson: string) => string;
  list_bots_json: () => string;
};

export function listBotNames(): BotName[] {
  const data = JSON.parse(exports.list_bots_json()) as { bots: BotName[] };
  return data.bots;
}

export function chooseBotMove(botName: BotName, gameJson: string): [Cube, Cube] {
  const data = JSON.parse(exports.best_move_json(botName, gameJson)) as { stones: [Cube, Cube] };
  return data.stones;
}
