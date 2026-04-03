use hex_tic_tac_engine::{Cube, Game, Player};
use serde::Serialize;

const P_A: i32 = 1;
const P_B: i32 = 2;
const MOVES_PER_TURN: i32 = 2;

#[derive(Serialize)]
struct SealBotCell {
    q: i32,
    r: i32,
    player: i32,
}

#[derive(Serialize)]
struct SealBotState {
    cells: Vec<SealBotCell>,
    cur_player: i32,
    moves_left: i32,
    move_count: i32,
}

fn map_player(player: Player) -> i32 {
    match player {
        Player::One => P_A,
        Player::Two => P_B,
    }
}

fn encode_state(game: &Game) -> Result<SealBotState, String> {
    if game.is_over() {
        return Err("seal cannot move after the game is over".to_string());
    }

    let mut cells = Vec::with_capacity(game.stone_count() as usize);
    cells.push(SealBotCell {
        q: 0,
        r: 0,
        player: P_A,
    });
    for (turn_index, turn) in game.turns().enumerate() {
        let player = if turn_index % 2 == 0 { P_B } else { P_A };
        for coord in turn.stones {
            let (q, r) = coord.axial();
            cells.push(SealBotCell { q, r, player });
        }
    }

    Ok(SealBotState {
        cells,
        cur_player: map_player(game.current_player()),
        moves_left: MOVES_PER_TURN,
        move_count: game.stone_count() as i32,
    })
}

fn decode_move(raw: &[i32]) -> Result<[Cube; 2], String> {
    match raw {
        [q1, r1, q2, r2, 2] => Ok([Cube::from_axial(*q1, *r1), Cube::from_axial(*q2, *r2)]),
        [q, r, _, _, 1] => {
            let coord = Cube::from_axial(*q, *r);
            Ok([coord, coord])
        }
        _ => Err(format!("unexpected SealBot move payload: {raw:?}")),
    }
}

#[cfg(not(target_arch = "wasm32"))]
mod native {
    use super::{decode_move, encode_state};
    use hex_tic_tac_engine::Game;
    use std::ffi::CStr;
    use std::os::raw::{c_char, c_int};

    unsafe extern "C" {
        fn sealbot_choose_move_flat(
            cells_qrp: *const i32,
            cell_count: c_int,
            cur_player: c_int,
            moves_left: c_int,
            move_count: c_int,
            out_move: *mut i32,
        ) -> c_int;
        fn sealbot_last_error() -> *const c_char;
    }

    fn last_error() -> String {
        unsafe {
            let ptr = sealbot_last_error();
            if ptr.is_null() {
                return "unknown SealBot error".to_string();
            }
            CStr::from_ptr(ptr).to_string_lossy().into_owned()
        }
    }

    pub(super) fn choose_move(game: &Game) -> Result<[hex_tic_tac_engine::Cube; 2], String> {
        let state = encode_state(game)?;
        let mut flat_cells = Vec::with_capacity(state.cells.len() * 3);
        for cell in &state.cells {
            flat_cells.push(cell.q);
            flat_cells.push(cell.r);
            flat_cells.push(cell.player);
        }

        let mut out_move = [0i32; 5];
        let status = unsafe {
            sealbot_choose_move_flat(
                flat_cells.as_ptr(),
                state.cells.len() as c_int,
                state.cur_player as c_int,
                state.moves_left as c_int,
                state.move_count as c_int,
                out_move.as_mut_ptr(),
            )
        };
        if status != 0 {
            return Err(last_error());
        }
        decode_move(&out_move)
    }
}

#[cfg(target_arch = "wasm32")]
mod wasm {
    use super::{decode_move, encode_state};
    use hex_tic_tac_engine::Game;
    use wasm_bindgen::prelude::*;

    #[wasm_bindgen(module = "/src/seal_vendor_bridge.js")]
    unsafe extern "C" {
        #[wasm_bindgen(catch, js_name = chooseSealBotMove)]
        fn choose_sealbot_move(state_json: &str) -> Result<String, JsValue>;
    }

    pub(super) fn choose_move(game: &Game) -> Result<[hex_tic_tac_engine::Cube; 2], String> {
        let state = encode_state(game)?;
        let state_json = serde_json::to_string(&state).map_err(|error| error.to_string())?;
        let raw = choose_sealbot_move(&state_json).map_err(|error| {
            error
                .as_string()
                .unwrap_or_else(|| "SealBot wasm bridge failed".to_string())
        })?;
        let move_data = serde_json::from_str::<Vec<i32>>(&raw).map_err(|error| error.to_string())?;
        decode_move(&move_data)
    }
}

pub(crate) fn choose_seal_move(game: &Game) -> Result<[Cube; 2], String> {
    #[cfg(target_arch = "wasm32")]
    {
        wasm::choose_move(game)
    }

    #[cfg(not(target_arch = "wasm32"))]
    {
        native::choose_move(game)
    }
}
