# Sokoban Solver — make.fun bounty entry

[![make.fun](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/adhiejoey/makefun-sokoban-solver/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/adhiejoey/makefun-sokoban-solver/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

Build the best Sokoban solver — [make.fun bounty](https://make.fun/bounty/sokoban-solver-01-run-20261121) — $100.

One program (`main.ts`, Node 22, no dependencies) answers every instance of a
drawn set: it reads each `level.txt` in XSB and writes the player's moves to
`solution.txt`, pushing every box onto a goal in as few pushes as it can.

## How it works

The generator builds each level as one hallway with independent rooms off it:
a box pushed out of a room can never come back, and the level's push-optimum
is the sum of the rooms' optima. So the solver:

1. Splits the level into rooms (the connected floor components off the
   hallway row the player starts on).
2. Solves each room **push-optimally** on its own with A* over pushes:
   - States are box positions plus the player's reachable region.
   - The heuristic is the minimum assignment of boxes to goals over
     floor distances (admissible, so A* is push-optimal).
   - Dead-square tables (reverse-pull fixpoint) and 2x2 frozen-block
     detection prune positions no push can save.
   - A greedy best-first fallback covers any room A* gives up on.
3. Joins the room plans with plain player walks through the hallway.
4. Replays its own answer before writing it, and falls back to a
   whole-level push A* if the room split ever fails.

Search cutoffs are expansion budgets, never wall-clock or randomness, so two
runs write the same bytes.

## Run it locally

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

`practice/input` is the kit's practice set; the program reads
`MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR` (default `/input` / `/output`).

## Verified results

Scored with the kit's own scorer on the practice set and on three freshly
generated sets (the kit's generator, new seeds):

| set | solver | house baseline (plain-astar 1.0.0) |
| --- | --- | --- |
| practice (i001–i005) | **1,000,000** — every instance solved in exactly P\* pushes (13, 16, 29, 47, 60) | 200,000 — only i001 solved |
| fresh set 1 | **1,000,000** | 200,000 |
| fresh set 2 | **1,000,000** | — |
| fresh set 3 | **1,000,000** | — |

Whole-set runtime is 1–3 seconds (limit: 60 seconds). Two runs on the
practice set produce byte-identical outputs.

## Referral

Built with [make.fun](https://make.fun/r/mcpf7r82) — enter through my referral
link if you want to play the bounties too.
