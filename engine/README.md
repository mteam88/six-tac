# hex-tic-tac-engine

High-performance Rust library for **hex tic tac toe** on an infinite hex grid.

## Rules modeled by the engine

- The board is an infinite grid of hexagons.
- Coordinates use the **cube coordinate** system.
- The center `(0, 0, 0)` is treated as an **implied opening stone** for **Player One**.
- All public moves are **full turns** of exactly **two stones**.
- After the implied opening, **Player Two** moves first.
- A win is evaluated after the full two-stone turn has been applied.

## Highlights

- Sparse board representation for an infinite grid.
- Atomic two-stone turn API.
- Fast legality checks.
- Win detection scans only the 3 axes through the newly placed stones.
- Turn-list JSON serialization.
- Supports `play()` and `undo()` for search / AI use cases.
- Fully documented public API.

## Quick start

```rust
use hex_tic_tac_engine::{Cube, Game, Player, TurnOutcome};

let mut game = Game::new();
assert_eq!(game.current_player(), Player::Two);
assert_eq!(game.stone_count(), 1); // implied opening at the center

match game.play([Cube::from_axial(1, 0), Cube::from_axial(2, 0)])? {
    TurnOutcome::TurnPassed { next_player } => {
        assert_eq!(next_player, Player::One);
    }
    _ => unreachable!(),
}

let json = game.to_json_pretty()?;
let restored = Game::from_json_str(&json)?;
assert_eq!(restored.turn_count(), 1);
# Ok::<(), Box<dyn std::error::Error>>(())
```

## JSON format

Serialization is **turn-list based**, not full-state based. The implied opening is not stored, and the acting player is implied by turn order.

```json
{
  "turns": [
    {
      "stones": [
        { "x": 1, "y": -1, "z": 0 },
        { "x": 2, "y": -2, "z": 0 }
      ]
    },
    {
      "stones": [
        { "x": 0, "y": -1, "z": 1 },
        { "x": 0, "y": -2, "z": 2 }
      ]
    }
  ]
}
```

Turn `0` belongs to Player Two, turn `1` to Player One, and so on.

## Performance model

The engine stores occupied cells in hash-based sparse sets/maps. A turn is:

- **O(1)** average for occupancy checks and insertion
- **O(L)** for win detection, where `L` is the contiguous line length touching either new stone

Because only the 3 line axes through the two newly placed stones are inspected, win checks stay local and efficient.
