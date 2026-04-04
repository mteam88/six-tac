#include "../vendor/SealBot/current/engine/constants.h"
#include "../vendor/SealBot/current/engine/engine.h"
#include "../vendor/SealBot/current/pattern_data.h"
#include "../vendor/SealBot/current/types.h"

#include <cstdint>
#include <exception>
#include <string>
#include <vector>

namespace {
thread_local std::string g_last_error;

bool in_bounds(int q, int r) {
    return q >= -OFF && q < OFF && r >= -OFF && r < OFF;
}

opt::MinimaxBot make_bot() {
    opt::MinimaxBot bot(0.05);
    bot.max_depth = 3;
    bot.max_nodes = 50000;
    std::vector<double> patterns(PATTERN_VALUES, PATTERN_VALUES + PATTERN_COUNT);
    bot.load_patterns(patterns, PATTERN_EVAL_LENGTH);
    return bot;
}
} // namespace

extern "C" {
const char* sealbot_last_error() {
    return g_last_error.c_str();
}

int sealbot_choose_move_flat(
    const int32_t* cells_qrp,
    int32_t cell_count,
    int32_t cur_player,
    int32_t moves_left,
    int32_t move_count,
    int32_t* out_move
) {
    try {
        g_last_error.clear();

        if (cell_count < 0 || cells_qrp == nullptr || out_move == nullptr) {
            g_last_error = "invalid SealBot FFI arguments";
            return 2;
        }
        if (cur_player != P_A && cur_player != P_B) {
            g_last_error = "invalid current player";
            return 2;
        }
        if (moves_left != 1 && moves_left != 2) {
            g_last_error = "invalid moves_left value";
            return 2;
        }

        GameState game_state;
        game_state.cells.reserve(static_cast<size_t>(cell_count));
        for (int32_t index = 0; index < cell_count; index++) {
            const int32_t base = index * 3;
            const int q = cells_qrp[base + 0];
            const int r = cells_qrp[base + 1];
            const int8_t player = static_cast<int8_t>(cells_qrp[base + 2]);
            if ((player != P_A && player != P_B) || !in_bounds(q, r)) {
                g_last_error = "SealBot only supports coordinates in the range [-70, 69]";
                return 1;
            }
            game_state.cells.push_back({q, r, player});
        }

        game_state.cur_player = static_cast<int8_t>(cur_player);
        game_state.moves_left = static_cast<int8_t>(moves_left);
        game_state.move_count = move_count;

        auto bot = make_bot();
        const MoveResult move = bot.get_move(game_state);
        out_move[0] = move.q1;
        out_move[1] = move.r1;
        out_move[2] = move.q2;
        out_move[3] = move.r2;
        out_move[4] = move.num_moves;
        return 0;
    } catch (const std::exception& error) {
        g_last_error = error.what();
        return 2;
    } catch (...) {
        g_last_error = "unknown SealBot error";
        return 2;
    }
}
}
