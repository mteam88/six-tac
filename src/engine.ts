import * as bindings from "./engine-wasm/engine_bg.js";
import wasmModule from "./engine-wasm/engine_bg.wasm";

const instance = new WebAssembly.Instance(wasmModule, {
  "./engine_bg.js": bindings,
});

bindings.__wbg_set_wasm(instance.exports);
(instance.exports as { __wbindgen_start?: () => void }).__wbindgen_start?.();

export const { play_json, snapshot_json } = bindings;
