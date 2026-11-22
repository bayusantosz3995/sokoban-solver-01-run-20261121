// Sokoban solver for make.fun's sokoban-solver-01-run-20261121.
//
// Strategy
// --------
// Every level this competition draws is a hallway with independent rooms off
// it: a box pushed out of a room into the hallway can never come back, so in
// any optimal solution every box stays in its own room and the level's
// push-optimum is the sum of the rooms' optima. This solver exploits that
// structure instead of searching the whole level (whose state space is the
// product of the rooms'):
//
//   1. Parse the level and work out, for every square, whether a box there
//      could ever reach a goal (pull-reachability from the goals, ignoring
//      the other boxes). Squares that cannot are dead for boxes.
//   2. Cut the dead squares of the player's row (the hallway) out of the
//      floor; each remaining connected part that holds boxes is one room.
//   3. Solve each room on its own, push-optimally, with A* over pushes:
//      a state is the room's boxes plus the player's reachable region, the
//      heuristic is the cheapest assignment of boxes to goals over
//      push-distance tables (admissible, so the first solution found is
//      optimal), and two deadlocks are pruned (a box on a dead square, a
//      frozen 2x2 block of walls and boxes). The other rooms' boxes stand as
//      walls while a room is solved; the player walks on from wherever the
//      previous room left it. The rooms' move strings concatenate.
//   4. Fallbacks, all deterministic: if a room's A* exhausts its expansion
//      budget, a greedy best-first search (same pruning, heuristic-only
//      priority) tries to solve it anyway; if the level has no room
//      structure at all, the whole level is searched the same way; if all
//      else fails the instance gets an empty (valid, scoreless) answer.
//
// Determinism: the search is budgeted by counted expansions, never by the
// clock; there is no randomness, no wall-clock read, and every tie breaks on
// fixed orders (directions u, d, l, r; deeper states first; insertion
// order). Two runs on the same input write the same bytes.
//
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Expansion budgets: work counts, never the clock, so the answers are the
// same on every run. Rooms here are tiny (3-4 boxes in a 6x6 slot), so the
// searches finish far below these caps; the caps only bound pathological
// inputs. The total caps the whole set's work inside the 60 s wall.
const ROOM_EXPANSIONS = 400_000;
const WHOLE_EXPANSIONS = 400_000;
const GREEDY_EXPANSIONS = 200_000;
const TOTAL_EXPANSIONS = 2_000_000;

const DIRS = [
  { dx: 0, dy: -1, step: 'u', push: 'U' },
  { dx: 0, dy: 1, step: 'd', push: 'D' },
  { dx: -1, dy: 0, step: 'l', push: 'L' },
  { dx: 1, dy: 0, step: 'r', push: 'R' },
];

/** Parse XSB text (# wall, space floor, . goal, $ box, * box on goal, @ player, + player on goal). */
function parseLevel(text) {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals = [];
  const boxes = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // The outermost frame is wall whatever it shows: nothing leaves the board.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/**
 * For each goal, the fewest pushes a lone box needs to reach it from every
 * square (reverse BFS over pulls: a box at y can be pulled to x when both y
 * and the square behind it are floor). -1 means unreachable. Ignoring the
 * other boxes makes every distance a lower bound on the real cost.
 */
function pushDistances(board, goals) {
  const { w, wall } = board;
  const size = wall.length;
  const tables = [];
  for (const g of goals) {
    const dist = new Int32Array(size).fill(-1);
    dist[g] = 0;
    const queue = [g];
    for (let qi = 0; qi < queue.length; qi++) {
      const x = queue[qi];
      for (const d of DIRS) {
        const step = d.dy * w + d.dx;
        const y = x - step;
        const behind = y - step;
        if (y < 0 || y >= size || behind < 0 || behind >= size) continue;
        if (wall[y] || wall[behind] || dist[y] >= 0) continue;
        dist[y] = dist[x] + 1;
        queue.push(y);
      }
    }
    tables.push(dist);
  }
  return tables;
}

/** The squares from which a box can reach some goal (any distance table finite there). */
function liveSquares(tables) {
  const size = tables[0].length;
  const live = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    for (const t of tables) {
      if (t[i] >= 0) {
        live[i] = 1;
        break;
      }
    }
  }
  return live;
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway)
 * out of the floor and flood-fill what is left; each part holding boxes is
 * a room. Null when the level is no set of rooms (a box in the cut, a goal
 * in the cut, or a part with unequal boxes and goals).
 */
function findRooms(level, live) {
  const { w, wall, goals, boxes, player } = level;
  const size = wall.length;
  const row = Math.floor(player / w);
  const cut = new Uint8Array(size);
  for (let x = 0; x < w; x++) {
    const i = row * w + x;
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(size).fill(-1);
  const rooms = [];
  for (let s = 0; s < size; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      const p = squares[i];
      for (const d of DIRS) {
        const q = p + d.dy * w + d.dx;
        if (q < 0 || q >= size) continue;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [], done: false });
  }
  for (const b of boxes) rooms[part[b]].boxes.push(b);
  for (const g of goals) {
    if (part[g] < 0) return null;
    rooms[part[g]].goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/**
 * Cheapest assignment of boxes to goals over the push-distance tables:
 * admissible, since each box needs at least its matched distance. Small
 * counts enumerate permutations; larger ones fall back to the sum of each
 * box's nearest goal (also admissible). Infinity when a box reaches no goal.
 */
function heuristic(boxes, tables) {
  const n = boxes.length;
  if (n === 0) return 0;
  if (n > 6) {
    let sum = 0;
    for (const b of boxes) {
      let best = Infinity;
      for (const t of tables) {
        if (t[b] >= 0 && t[b] < best) best = t[b];
      }
      if (best === Infinity) return Infinity;
      sum += best;
    }
    return sum;
  }
  const perm = tables.map((_, i) => i);
  let best = Infinity;
  const rec = (k, acc) => {
    if (acc >= best) return;
    if (k === n) {
      best = acc;
      return;
    }
    for (let i = k; i < perm.length; i++) {
      const tmp = perm[k];
      perm[k] = perm[i];
      perm[i] = tmp;
      const d = tables[perm[k]][boxes[k]];
      if (d >= 0) rec(k + 1, acc + d);
      perm[i] = perm[k];
      perm[k] = tmp;
    }
  };
  rec(0, 0);
  return best;
}

/**
 * A* (greedy=false) or greedy best-first (greedy=true) over pushes on one
 * board: {pushes, moves} or null when the budget runs out or no solution
 * exists. A state is the sorted boxes plus the player's reachable region
 * (named by its lowest square); the first solved state popped is
 * push-optimal under A* with the admissible heuristic above.
 */
function search(board, goals, boxes, player, budget, cap, greedy) {
  const { w, wall } = board;
  const size = wall.length;
  const goalSet = new Uint8Array(size);
  for (const g of goals) goalSet[g] = 1;
  const tables = pushDistances(board, goals);
  const live = liveSquares(tables);
  if (boxes.some((b) => !live[b])) return null;
  const solved = (bs) => bs.every((b) => goalSet[b]);
  if (solved(boxes)) return { pushes: 0, moves: '' };

  const occupied = new Uint8Array(size);
  const seenA = new Int32Array(size);
  const seenB = new Int32Array(size);
  const floodStack = new Int32Array(size);
  let stampA = 0;
  let stampB = 0;
  // Flood-fill the player's region from `from` around walls and boxes
  // (occupied as it stands), stamping it into `seen`; returns its lowest
  // square, the region's name.
  const flood = (from, seen, stamp) => {
    let low = from;
    let n = 0;
    floodStack[n++] = from;
    seen[from] = stamp;
    while (n > 0) {
      const p = floodStack[--n];
      if (p < low) low = p;
      for (const d of DIRS) {
        const q = p + d.dy * w + d.dx;
        if (q < 0 || q >= size) continue;
        if (!wall[q] && !occupied[q] && seen[q] !== stamp) {
          seen[q] = stamp;
          floodStack[n++] = q;
        }
      }
    }
    return low;
  };

  // Whether the box just pushed to `t` sits in a frozen 2x2 block: four
  // squares of walls and boxes with a box among them off its goal. Such a
  // box can never move again, so the state is dead.
  const frozenAt = (t) => {
    for (const a of [t, t - 1, t - w, t - w - 1]) {
      if (a < 0 || a % w === w - 1 || a + w + 1 >= size) continue;
      const b = a + 1;
      const c = a + w;
      const d = c + 1;
      if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) ||
          !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
      if ((occupied[a] && !goalSet[a]) || (occupied[b] && !goalSet[b]) ||
          (occupied[c] && !goalSet[c]) || (occupied[d] && !goalSet[d])) return true;
    }
    return false;
  };

  // The open list: a binary heap on [priority, g, sequence, state], smaller
  // priority first, deeper states first on ties, then insertion order.
  const heap = [];
  let seq = 0;
  const less = (a, b) =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e) => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i], heap[p])) break;
      const tmp = heap[i];
      heap[i] = heap[p];
      heap[p] = tmp;
      i = p;
    }
  };
  const heapPop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1], heap[c])) c++;
        if (!less(heap[c], heap[i])) break;
        const tmp = heap[i];
        heap[i] = heap[c];
        heap[c] = tmp;
        i = c;
      }
    }
    return top;
  };

  // The states, in the order found: boxes, player square, parent, the push
  // that made them, their cost, and their key (region + boxes).
  const stBoxes = [boxes.slice()];
  const stPlayer = [player];
  const stParent = [-1];
  const stFrom = [-1];
  const stTo = [-1];
  const stG = [0];
  const stKey = [];
  const keyOf = (bs, low) => `${low}|${bs.join(',')}`;
  const best = new Map();
  for (const b of boxes) occupied[b] = 1;
  const low0 = flood(player, seenA, ++stampA);
  for (const b of boxes) occupied[b] = 0;
  const key0 = keyOf(boxes, low0);
  stKey.push(key0);
  best.set(key0, 0);
  const h0 = heuristic(boxes, tables);
  heapPush([greedy ? h0 : h0, 0, seq++, 0]);

  let expanded = 0;
  let goalIdx = -1;
  while (heap.length > 0) {
    const [, g, , s] = heapPop();
    if (best.get(stKey[s]) !== s) continue; // superseded by a cheaper path
    const bs = stBoxes[s];
    if (solved(bs)) {
      goalIdx = s;
      break;
    }
    if (expanded >= cap || budget.used >= budget.limit) return null;
    expanded++;
    budget.used++;
    for (const b of bs) occupied[b] = 1;
    const curStamp = ++stampA;
    flood(stPlayer[s], seenA, curStamp);
    for (let bi = 0; bi < bs.length; bi++) {
      const b = bs[bi];
      for (const d of DIRS) {
        const step = d.dy * w + d.dx;
        const pushSq = b - step;
        const target = b + step;
        if (pushSq < 0 || pushSq >= size || target < 0 || target >= size) continue;
        if (seenA[pushSq] !== curStamp) continue; // player cannot reach the push square
        if (wall[target] || occupied[target] || !live[target]) continue;
        occupied[b] = 0;
        occupied[target] = 1;
        if (frozenAt(target)) {
          occupied[target] = 0;
          occupied[b] = 1;
          continue;
        }
        const child = bs.slice();
        child[bi] = target;
        child.sort((a, b2) => a - b2);
        const low = flood(b, seenB, ++stampB); // the player ends on b
        const key = keyOf(child, low);
        const g2 = g + 1;
        const prev = best.get(key);
        if (prev !== undefined && stG[prev] <= g2) {
          occupied[target] = 0;
          occupied[b] = 1;
          continue;
        }
        const h = heuristic(child, tables);
        if (h === Infinity) {
          occupied[target] = 0;
          occupied[b] = 1;
          continue;
        }
        const idx = stBoxes.length;
        stBoxes.push(child);
        stPlayer.push(b);
        stParent.push(s);
        stFrom.push(b);
        stTo.push(target);
        stG.push(g2);
        stKey.push(key);
        best.set(key, idx);
        heapPush([greedy ? h : g2 + h, g2, seq++, idx]);
        occupied[target] = 0;
        occupied[b] = 1;
      }
    }
    for (const b of bs) occupied[b] = 0;
  }
  if (goalIdx < 0) return null;

  // Rebuild the push sequence, then the moves: walk to each push square
  // (shortest path, directions in fixed order), then push.
  const path = [];
  for (let s = goalIdx; s > 0; s = stParent[s]) path.push(s);
  path.reverse();
  let moves = '';
  let curPlayer = player;
  let curBoxes = boxes.slice();
  for (const s of path) {
    const from = stFrom[s];
    const to = stTo[s];
    const step = to - from;
    const dir = DIRS.find((d) => d.dy * w + d.dx === step);
    for (const b of curBoxes) occupied[b] = 1;
    const walk = walkTo(board, occupied, curPlayer, from - step);
    for (const b of curBoxes) occupied[b] = 0;
    if (walk === null) return null;
    moves += walk;
    moves += dir.push;
    curPlayer = from;
    curBoxes = stBoxes[s];
  }
  return { pushes: path.length, moves };
}

/** Shortest walk from `from` to `to` around walls and boxes (occupied), in lower LURD letters; null when unreachable. */
function walkTo(board, occupied, from, to) {
  const { w, wall } = board;
  if (from === to) return '';
  const size = wall.length;
  const prev = new Int32Array(size).fill(-1);
  const how = new Array(size);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (const d of DIRS) {
      const q = p + d.dy * w + d.dx;
      if (q < 0 || q >= size) continue;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = d.step;
      queue.push(q);
    }
  }
  if (prev[to] === -1) return null;
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

/** The square the player stands on after `moves` (LURD, case aside) from `from` on a board `w` wide. */
function endOf(w, from, moves) {
  let p = from;
  for (const ch of moves.toLowerCase()) {
    p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  }
  return p;
}

/** One level's moves: room by room when the level has rooms, else a whole-level search. '' when unsolved. */
function solveLevel(text, budget) {
  const level = parseLevel(text);
  if (level.boxes.length === 0 || level.player < 0) return '';
  const tables = pushDistances(level, level.goals);
  const live = liveSquares(tables);
  const rooms = findRooms(level, live);
  if (rooms !== null) {
    let player = level.player;
    let moves = '';
    for (const room of rooms) {
      // The other rooms' boxes stand as walls: solved ones on their goals,
      // the rest where they are.
      const wall = level.wall.slice();
      for (const other of rooms) {
        if (other === room) continue;
        const squares = other.done ? other.goals : other.boxes;
        for (const b of squares) wall[b] = 1;
      }
      const sub = { w: level.w, h: level.h, wall };
      let res = search(sub, room.goals, room.boxes, player, budget, ROOM_EXPANSIONS, false);
      if (res === null) res = search(sub, room.goals, room.boxes, player, budget, GREEDY_EXPANSIONS, true);
      if (res === null) return '';
      moves += res.moves;
      player = endOf(level.w, player, res.moves);
      room.done = true;
    }
    return moves;
  }
  const sub = { w: level.w, h: level.h, wall: level.wall };
  let res = search(sub, level.goals, level.boxes, level.player, budget, WHOLE_EXPANSIONS, false);
  if (res === null) res = search(sub, level.goals, level.boxes, level.player, budget, GREEDY_EXPANSIONS, true);
  return res === null ? '' : res.moves;
}

const budget = { used: 0, limit: TOTAL_EXPANSIONS };
for (const id of readdirSync(INPUT_DIR).sort()) {
  let moves = '';
  try {
    moves = solveLevel(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8'), budget);
  } catch {
    moves = '';
  }
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
