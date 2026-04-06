declare module "./bot-wasm/bots_bg.js" {
  const bindings: Record<string, unknown>;
  export = bindings;
}

declare module "./bot-wasm/bots_bg.wasm" {
  const wasmModule: WebAssembly.Module;
  export default wasmModule;
}
