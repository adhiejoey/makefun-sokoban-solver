// Sokoban solver for make.fun's sokoban-solver-01-run-20261121.
// Strategy: the generator builds each level as one hallway with independent
// rooms off it (a box pushed out of a room can never come back), and the
// level's push-optimum is the sum of the rooms' optima. So each room is
// solved push-optimally on its own with A* over pushes, and the room
// solutions are joined by plain player walks through the hallway.
// A room holds at most 4 boxes in a 6x6 slot, so per-room A* is small.
// Fallback: a whole-level push A* (then a greedy best-first search) if the
// room split ever fails. No randomness, no clock-dependent output: search
// cutoffs are expansion budgets, so two runs write the same bytes.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const IN_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// ------------------------------------------------------------------ level
type Level = {
  w: number;
  h: number;
  wall: Uint8Array; // 1 = wall (or off-board), 0 = floor
  goals: number[];
  boxes: number[];
  player: number;
};

const DIRS: { dx: number; dy: number; ch: string }[] = [
  { dx: 0, dy: -1, ch: 'u' },
  { dx: 0, dy: 1, ch: 'd' },
  { dx: -1, dy: 0, ch: 'l' },
  { dx: 1, dy: 0, ch: 'r' },
];

function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

// ------------------------------------------------------------ BFS helpers
// BFS distances from `from` over cells where `pass` is true. -1 = unreachable.
function bfsDist(from: number, pass: (i: number) => boolean, w: number, h: number): Int32Array {
  const dist = new Int32Array(w * h).fill(-1);
  if (!pass(from)) return dist;
  const q: number[] = [from];
  dist[from] = 0;
  for (let head = 0; head < q.length; head++) {
    const c = q[head]!;
    const cx = c % w;
    const cy = (c / w) | 0;
    for (const d of DIRS) {
      const nx = cx + d.dx;
      const ny = cy + d.dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const n = ny * w + nx;
      if (dist[n] !== -1 || !pass(n)) continue;
      dist[n] = dist[c]! + 1;
      q.push(n);
    }
  }
  return dist;
}

// Shortest walk (list of step letters) from `from` to `to` over passable cells.
// Empty string when from === to; null when unreachable.
function bfsPath(from: number, to: number, pass: (i: number) => boolean, w: number, h: number): string | null {
  if (from === to) return '';
  const prev = new Int32Array(w * h).fill(-2);
  const prevCh: string[] = new Array<string>(w * h).fill('');
  const q: number[] = [from];
  prev[from] = -1;
  for (let head = 0; head < q.length; head++) {
    const c = q[head]!;
    const cx = c % w;
    const cy = (c / w) | 0;
    for (const d of DIRS) {
      const nx = cx + d.dx;
      const ny = cy + d.dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const n = ny * w + nx;
      if (prev[n] !== -2 || !pass(n)) continue;
      prev[n] = c;
      prevCh[n] = d.ch;
      if (n === to) {
        let s = '';
        for (let t = n; t !== from; t = prev[t]!) s = prevCh[t]! + s;
        return s;
      }
      q.push(n);
    }
  }
  return null;
}

// ------------------------------------------------------------ decomposition
type Room = {
  cells: Set<number>; // floor cells of the room (door cell included)
  goals: number[];
  boxes: number[];
  door: number; // room cell next to the hallway
  hallCell: number; // hallway cell outside the door
};

function findRooms(level: Level): Room[] | null {
  const { w, h, wall, goals, boxes, player } = level;
  const hallRow = (player / w) | 0;
  const floor = (i: number): boolean => wall[i] === 0;
  const seen = new Uint8Array(w * h);
  const rooms: Room[] = [];
  for (let i = 0; i < w * h; i++) {
    if (!floor(i) || ((i / w) | 0) === hallRow || seen[i]) continue;
    // Flood one connected component (rooms never touch the hallway row).
    const comp: number[] = [];
    const q: number[] = [i];
    seen[i] = 1;
    for (let head = 0; head < q.length; head++) {
      const c = q[head]!;
      comp.push(c);
      const cx = c % w;
      const cy = (c / w) | 0;
      for (const d of DIRS) {
        const nx = cx + d.dx;
        const ny = cy + d.dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const n = ny * w + nx;
        if (!floor(n) || ((n / w) | 0) === hallRow || seen[n]) continue;
        seen[n] = 1;
        q.push(n);
      }
    }
    const cellSet = new Set(comp);
    const rGoals = goals.filter((g) => cellSet.has(g));
    const rBoxes = boxes.filter((b) => cellSet.has(b));
    if (rBoxes.length === 0 && rGoals.length === 0) continue; // stray floor, not a room
    if (rBoxes.length === 0 || rGoals.length === 0 || rBoxes.length !== rGoals.length) return null;
    // Door: a room cell next to a hallway-row floor cell.
    let door = -1;
    let hallCell = -1;
    for (const c of comp) {
      const cx = c % w;
      const cy = (c / w) | 0;
      for (const d of DIRS) {
        const nx = cx + d.dx;
        const ny = cy + d.dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const n = ny * w + nx;
        if (((n / w) | 0) === hallRow && floor(n)) {
          if (door === -1 || c < door) {
            door = c;
            hallCell = n;
          }
        }
      }
    }
    if (door === -1) return null;
    rooms.push({ cells: cellSet, goals: rGoals, boxes: rBoxes, door, hallCell });
  }
  // Every box must sit in exactly one room.
  const covered = rooms.reduce((a, r) => a + r.boxes.length, 0);
  if (covered !== boxes.length || rooms.length === 0) return null;
  rooms.sort((a, b) => a.door - b.door);
  return rooms;
}

// ------------------------------------------------------- push A* over boxes
type Push = { box: number; dir: number }; // dir indexes DIRS; box moves box+DIRS[dir]

type SearchOpts = {
  level: Level;
  cells: Set<number>; // cells the boxes may occupy (room cells, or whole floor)
  goals: number[];
  boxes: number[];
  startPlayer: number; // where the player stands before the first push
  otherBoxes: number[]; // boxes outside this search, fixed obstacles
  budget: number; // max expansions
  greedy: boolean; // best-first on h only when true
};

// Dead squares: floor cells a box can never be pulled to a goal from.
// live = goals; repeat: c is live when some c+d is live and c-d is floor.
function deadSquares(level: Level, goals: number[]): Uint8Array {
  const { w, h, wall } = level;
  const live = new Uint8Array(w * h);
  for (const g of goals) live[g] = 1;
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < w * h; i++) {
      if (wall[i] === 1 || live[i] === 1) continue;
      const cx = i % w;
      const cy = (i / w) | 0;
      for (const d of DIRS) {
        const ax = cx + d.dx;
        const ay = cy + d.dy;
        const bx = cx - d.dx;
        const by = cy - d.dy;
        if (ax < 0 || ay < 0 || ax >= w || ay >= h || bx < 0 || by < 0 || bx >= w || by >= h) continue;
        const a = ay * w + ax;
        const b = by * w + bx;
        if (live[a] === 1 && wall[b] === 0) {
          live[i] = 1;
          changed = true;
          break;
        }
      }
    }
  }
  return live;
}

// True when some box sits in a 2x2 block of walls/boxes while off its goal.
function frozenBlock(level: Level, boxes: number[], goalSet: Set<number>): boolean {
  const { w, h, wall } = level;
  const boxSet = new Set(boxes);
  const blocked = (i: number): boolean => wall[i] === 1 || boxSet.has(i);
  for (let y = 0; y + 1 < h; y++) {
    for (let x = 0; x + 1 < w; x++) {
      const a = y * w + x;
      const b = a + 1;
      const c = a + w;
      const d = c + 1;
      if (blocked(a) && blocked(b) && blocked(c) && blocked(d)) {
        for (const cell of [a, b, c, d]) {
          if (boxSet.has(cell) && !goalSet.has(cell)) return true;
        }
      }
    }
  }
  return false;
}

// Minimum-assignment heuristic: the cheapest way to match every box to a
// distinct goal over floor distances (admissible: each push moves one box
// one square). Infinity when some box cannot reach any goal.
function assignmentHeuristic(
  boxes: number[],
  goals: number[],
  distFromGoal: Map<number, Int32Array>,
): number {
  const n = boxes.length;
  if (n === 0) return 0;
  // Distances box -> goal.
  const cost: number[][] = [];
  for (let i = 0; i < n; i++) {
    cost.push([]);
    for (let j = 0; j < goals.length; j++) {
      const d = distFromGoal.get(goals[j]!)![boxes[i]!]!;
      cost[i]!.push(d === -1 ? Infinity : d);
    }
  }
  // Brute-force the assignment (n <= 4, at most 24 permutations).
  let best = Infinity;
  const used: boolean[] = new Array<boolean>(goals.length).fill(false);
  const pick = (i: number, sum: number): void => {
    if (sum >= best) return;
    if (i === n) {
      best = sum;
      return;
    }
    for (let j = 0; j < goals.length; j++) {
      if (used[j] || cost[i]![j] === Infinity) continue;
      used[j] = true;
      pick(i + 1, sum + cost[i]![j]!);
      used[j] = false;
    }
  };
  pick(0, 0);
  return best;
}

function solvePushes(opts: SearchOpts): Push[] | null {
  const { level, cells, goals, boxes, startPlayer, otherBoxes, budget, greedy } = opts;
  const { w, h, wall } = level;
  const goalSet = new Set(goals);
  const live = deadSquares(level, goals);
  const distFromGoal = new Map<number, Int32Array>();
  for (const g of goals) {
    distFromGoal.set(g, bfsDist(g, (i) => wall[i] === 0, w, h));
  }
  const solved = (bs: number[]): boolean => bs.every((b) => goalSet.has(b));

  // A state is (sorted boxes, player reachable region). The region is the
  // set of cells the player can walk to without pushing; its sorted join is
  // the canonical key alongside the boxes.
  const regionOf = (playerPos: number, bs: number[]): number[] => {
    const boxSet = new Set(bs);
    for (const b of otherBoxes) boxSet.add(b);
    const dist = bfsDist(playerPos, (i) => wall[i] === 0 && !boxSet.has(i), w, h);
    const region: number[] = [];
    for (let i = 0; i < w * h; i++) if (dist[i] !== -1) region.push(i);
    return region;
  };
  const stateKey = (bs: number[], region: number[]): string =>
    bs.join(',') + '|' + region.join(',');

  // Heap of [f, g, stateIndex], smallest f first (ties: larger g first).
  type Node = { boxes: number[]; player: number; region: number[]; g: number; parent: number; push: Push | null };
  const nodes: Node[] = [];
  const startBoxes = [...boxes].sort((a, b) => a - b);
  const startRegion = regionOf(startPlayer, startBoxes);
  const startH = assignmentHeuristic(startBoxes, goals, distFromGoal);
  if (startH === Infinity) return null;
  nodes.push({ boxes: startBoxes, player: startPlayer, region: startRegion, g: 0, parent: -1, push: null });
  const best = new Map<string, number>();
  best.set(stateKey(startBoxes, startRegion), 0);
  const heap: [number, number, number][] = [[greedy ? startH : startH, 0, 0]];
  const less = (a: [number, number, number], b: [number, number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && a[1] > b[1]);
  const heapPush = (e: [number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): [number, number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1]!, heap[c]!)) c++;
        if (!less(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };

  let expanded = 0;
  while (heap.length > 0 && expanded < budget) {
    const [, g, s] = heapPop();
    const node = nodes[s]!;
    if (best.get(stateKey(node.boxes, node.region)) !== s) continue;
    if (solved(node.boxes)) {
      const pushes: Push[] = [];
      for (let t = s; nodes[t]!.push !== null; t = nodes[t]!.parent) pushes.push(nodes[t]!.push!);
      pushes.reverse();
      return pushes;
    }
    expanded++;
    const regionSet = new Set(node.region);
    const boxSet = new Set(node.boxes);
    for (let bi = 0; bi < node.boxes.length; bi++) {
      const b = node.boxes[bi]!;
      const bx = b % w;
      const by = (b / w) | 0;
      for (let di = 0; di < DIRS.length; di++) {
        const d = DIRS[di]!;
        const tx = bx + d.dx;
        const ty = by + d.dy;
        if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue;
        const target = ty * w + tx;
        if (!cells.has(target) || wall[target] === 1 || boxSet.has(target)) continue;
        const px = bx - d.dx;
        const py = by - d.dy;
        if (px < 0 || py < 0 || px >= w || py >= h) continue;
        const pushFrom = py * w + px;
        if (wall[pushFrom] === 1 || boxSet.has(pushFrom) || !regionSet.has(pushFrom)) continue;
        // The pushed box must stay live and unfrozen.
        if (live[target] === 0) continue;
        const nb = node.boxes.slice();
        nb[bi] = target;
        nb.sort((a, b) => a - b);
        if (frozenBlock(level, nb, goalSet)) continue;
        const nRegion = regionOf(b, nb);
        const hEst = assignmentHeuristic(nb, goals, distFromGoal);
        if (hEst === Infinity) continue;
        const ng = g + 1;
        const key = stateKey(nb, nRegion);
        const prev = best.get(key);
        if (prev !== undefined && nodes[prev]!.g <= ng) continue;
        const t = nodes.length;
        nodes.push({ boxes: nb, player: b, region: nRegion, g: ng, parent: s, push: { box: b, dir: di } });
        best.set(key, t);
        heapPush([greedy ? hEst : ng + hEst, ng, t]);
      }
    }
  }
  return null;
}

// ------------------------------------------------------------ move assembly
// Replay moves on a level: returns pushes used and whether every box ends
// on a goal, or an error string for an illegal step.
function replay(level: Level, moves: string): { solved: boolean; pushes: number; error: string | null } {
  const { w, wall, goals } = level;
  const box = new Uint8Array(w * level.h);
  for (const b of level.boxes) box[b] = 1;
  const goalSet = new Set(goals);
  let player = level.player;
  let pushes = 0;
  for (let k = 0; k < moves.length; k++) {
    const ch = moves[k]!.toLowerCase();
    const d = DIRS.find((dd) => dd.ch === ch);
    if (!d) return { solved: false, pushes, error: `bad move ${ch}` };
    const next = player + d.dy * w + d.dx;
    if (wall[next] === 1) return { solved: false, pushes, error: `move ${k + 1} walks into a wall` };
    if (box[next] === 1) {
      const beyond = next + d.dy * w + d.dx;
      if (wall[beyond] === 1 || box[beyond] === 1) return { solved: false, pushes, error: `move ${k + 1} pushes into a wall or box` };
      box[next] = 0;
      box[beyond] = 1;
      pushes++;
    }
    player = next;
  }
  for (let i = 0; i < box.length; i++) {
    if (box[i] === 1 && !goalSet.has(i)) return { solved: false, pushes, error: null };
  }
  return { solved: true, pushes, error: null };
}

// Solve one level. Returns the move string ('' when unsolved).
function solveLevel(level: Level): string {
  const { w, h, wall } = level;
  const floorPass = (boxesNow: number[]) => {
    const boxSet = new Set(boxesNow);
    return (i: number): boolean => wall[i] === 0 && !boxSet.has(i);
  };

  // Try the room split first: rooms are independent, so each room's
  // push-optimal plan joins into a level push-optimal answer.
  const rooms = findRooms(level);
  if (rooms !== null) {
    let moves = '';
    let player = level.player;
    const boxesNow = [...level.boxes];
    let ok = true;
    for (const room of rooms) {
      // Walk to the hallway square outside this room's door.
      const walk = bfsPath(player, room.hallCell, floorPass(boxesNow), w, h);
      if (walk === null) {
        ok = false;
        break;
      }
      moves += walk;
      player = room.hallCell;
      // Solve the room from the door. Other rooms' boxes are fixed walls.
      const others = boxesNow.filter((b) => !room.cells.has(b));
      let plan = solvePushes({
        level,
        cells: room.cells,
        goals: room.goals,
        boxes: room.boxes,
        startPlayer: room.hallCell,
        otherBoxes: others,
        budget: 200_000,
        greedy: false,
      });
      if (plan === null) {
        plan = solvePushes({
          level,
          cells: room.cells,
          goals: room.goals,
          boxes: room.boxes,
          startPlayer: room.hallCell,
          otherBoxes: others,
          budget: 200_000,
          greedy: true,
        });
      }
      if (plan === null) {
        ok = false;
        break;
      }
      // Turn the push plan into moves, walking between pushes.
      const roomBoxSet = new Set(room.boxes);
      for (const push of plan) {
        const d = DIRS[push.dir]!;
        const pushFrom = push.box - d.dy * w - d.dx;
        const step = bfsPath(player, pushFrom, floorPass(boxesNow), w, h);
        if (step === null) {
          ok = false;
          break;
        }
        moves += step;
        moves += d.ch;
        player = push.box;
        const at = boxesNow.indexOf(push.box);
        boxesNow[at] = push.box + d.dy * w + d.dx;
        roomBoxSet.delete(push.box);
        roomBoxSet.add(push.box + d.dy * w + d.dx);
      }
      if (!ok) break;
    }
    if (ok) {
      const check = replay(level, moves);
      if (check.solved && check.error === null) return moves;
    }
  }

  // Fallback: push A* over the whole level, then greedy best-first.
  const allFloor = new Set<number>();
  for (let i = 0; i < w * h; i++) if (wall[i] === 0) allFloor.add(i);
  for (const greedy of [false, true]) {
    const plan = solvePushes({
      level,
      cells: allFloor,
      goals: level.goals,
      boxes: level.boxes,
      startPlayer: level.player,
      otherBoxes: [],
      budget: 500_000,
      greedy,
    });
    if (plan === null) continue;
    let moves = '';
    let player = level.player;
    const boxesNow = [...level.boxes];
    let ok = true;
    for (const push of plan) {
      const d = DIRS[push.dir]!;
      const pushFrom = push.box - d.dy * w - d.dx;
      const step = bfsPath(player, pushFrom, floorPass(boxesNow), w, h);
      if (step === null) {
        ok = false;
        break;
      }
      moves += step;
      moves += d.ch;
      player = push.box;
      boxesNow[boxesNow.indexOf(push.box)] = push.box + d.dy * w + d.dx;
    }
    if (!ok) continue;
    const check = replay(level, moves);
    if (check.solved && check.error === null) return moves;
  }
  return '';
}

// --------------------------------------------------------------------- main
for (const id of readdirSync(IN_DIR).sort()) {
  const moves = solveLevel(parseLevel(readFileSync(join(IN_DIR, id, 'level.txt'), 'utf8')));
  mkdirSync(join(OUT_DIR, id), { recursive: true });
  writeFileSync(join(OUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
