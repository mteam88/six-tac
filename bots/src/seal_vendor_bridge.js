import createSealBotModule from "../generated/sealbot.js";

const sealBotModule = await createSealBotModule();

export function chooseSealBotMove(stateJson) {
  try {
    const state = JSON.parse(stateJson);
    const cells = state.cells ?? [];
    const cellTriples = new Int32Array(cells.length * 3);
    for (let index = 0; index < cells.length; index += 1) {
      const base = index * 3;
      const cell = cells[index];
      cellTriples[base + 0] = cell.q | 0;
      cellTriples[base + 1] = cell.r | 0;
      cellTriples[base + 2] = cell.player | 0;
    }

    const mod = sealBotModule;
    const cellPtr = mod._malloc(cellTriples.byteLength);
    const outPtr = mod._malloc(Int32Array.BYTES_PER_ELEMENT * 5);
    try {
      mod.HEAP32.set(cellTriples, cellPtr >> 2);
      const status = mod._sealbot_choose_move_flat(
        cellPtr,
        cells.length,
        state.cur_player | 0,
        state.moves_left | 0,
        state.move_count | 0,
        outPtr,
      );
      if (status !== 0) {
        throw new Error(mod.UTF8ToString(mod._sealbot_last_error()));
      }
      const out = mod.HEAP32.subarray(outPtr >> 2, (outPtr >> 2) + 5);
      return JSON.stringify(Array.from(out));
    } finally {
      mod._free(cellPtr);
      mod._free(outPtr);
    }
  } catch (error) {
    throw new Error(error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error));
  }
}
