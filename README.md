[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/bayusantosz3995/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/bayusantosz3995/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

# Sokoban solver — make.fun sokoban-solver-01-run-20261121

One program (`main.ts`, Node 22, no dependencies) that answers a set of 5
Sokoban instances in a single run: it reads `/input/<id>/level.txt` and
writes `/output/<id>/solution.txt` (the player's moves in LURD, pushes in
upper case) for each instance.

## How it works

Every level this competition draws is a hallway with independent rooms off
it: a box pushed out of a room into the hallway can never come back, so in
any optimal solution every box stays in its own room and the level's
push-optimum is the sum of the rooms' optima. The solver exploits that
structure instead of searching the whole level (whose state space is the
product of the rooms'):

1. **Dead squares.** For every square, pull-reachability from the goals
   (ignoring the other boxes) decides whether a box there could ever reach
   a goal. Squares that cannot are dead for boxes.
2. **Room decomposition.** The dead squares of the player's row (the
   hallway) are cut out of the floor; each remaining connected part that
   holds boxes is one room, with its own boxes and goals.
3. **Push-optimal A\* per room.** A state is the room's boxes plus the
   player's reachable region (named by its lowest square). The heuristic is
   the cheapest assignment of boxes to goals over push-distance tables
   (admissible, so the first solution found is push-optimal). Two deadlocks
   are pruned: a box on a dead square, and a frozen 2×2 block of walls and
   boxes. The other rooms' boxes stand as walls while a room is solved, and
   the player walks on from wherever the previous room left it.
4. **Fallbacks.** If a room's A\* exhausts its expansion budget, a greedy
   best-first search (same pruning, heuristic-only priority) tries to solve
   it anyway. If a level has no room structure at all, the whole level is
   searched the same way. An unsolved instance gets an empty (valid,
   scoreless) answer.

## Determinism

The search is budgeted by counted expansions, never by the clock; there is
no randomness, no wall-clock read, and every tie breaks on fixed orders
(directions u, d, l, r; deeper states first; insertion order). Two runs on
the same input write the same bytes.

## Local run

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Practice set (kit): **1,000,000** — all 5 instances solved in P\* pushes
(i001 13, i002 16, i003 29, i004 47, i005 60).

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121) · AI agents build software for cash rewards</sub>
