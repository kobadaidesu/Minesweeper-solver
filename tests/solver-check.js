// 推論エンジン(dist/solver.js)の検証。ブラウザ不要で Node だけで動く。
//
//   npm run build:web && node tests/solver-check.js [旧エンジンの worker.js]
//
// 1. 健全性: 地雷を開かない・安全なマスに旗を立てない
// 2. 厳密性: 小さい盤面で、全配置を数え上げた厳密な確率と一致するか。
//            厳密には p=0/1 なのに確定できていないマス(推論の見逃し)が無いか
// 3. 成績: 難易度ごとの勝率と「詰まって推測した回数」。推測は
//            random  … 未確定マスからランダム
//            minprob … 表示される地雷確率が一番低いマス(プレイヤーがヒントに従った場合)
// 4. 速さ: 推論1回あたりの時間
//
// 引数に旧エンジン(git show <rev>:dist/minesweeper-worker.js の出力)を渡すと、
// 同じ盤面で旧エンジンの成績も並べて出す。
'use strict';
const fs = require('fs');
const path = require('path');

const repo = path.join(__dirname, '..');
const NewSolver = new Function(fs.readFileSync(path.join(repo, 'dist/solver.js'), 'utf8') + '\nreturn MinesweeperSolver;')();
const OldSolver = process.argv[2]
    ? new Function('self', fs.readFileSync(process.argv[2], 'utf8') + '\nreturn MinesweeperSolver;')({})
    : null;

/** 再現できるように乱数は種付き */
function mulberry32(a) {
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function neighborsOf(w, h) {
    const out = [];
    for (let i = 0; i < w * h; i++) {
        const x = i % w, y = Math.floor(i / w), list = [];
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = x + dx, ny = y + dy;
            if (nx >= 0 && nx < w && ny >= 0 && ny < h) list.push(ny * w + nx);
        }
        out.push(list);
    }
    return out;
}

/** 旧エンジンが使っていた「2段階先まで」の隣接表 */
function extendedOf(neighbors) {
    return neighbors.map((ns, i) => {
        const s = new Set();
        for (const n of ns) { s.add(n); for (const m of neighbors[n]) if (m !== i) s.add(m); }
        return [...s];
    });
}

/** 最初のクリックとその周りには地雷を置かない(ゲーム本体と同じ) */
function makeBoard(w, h, mines, first, rng, neighbors) {
    const cells = [];
    for (let i = 0; i < w * h; i++) cells.push({ hasMine: false, isRevealed: false, isFlagged: false, neighborMines: 0, index: i });
    const exclude = new Set([first, ...neighbors[first]]);
    const pool = [];
    for (let i = 0; i < cells.length; i++) if (!exclude.has(i)) pool.push(i);
    for (let k = 0; k < mines; k++) {
        const j = k + Math.floor(rng() * (pool.length - k));
        [pool[k], pool[j]] = [pool[j], pool[k]];
        cells[pool[k]].hasMine = true;
    }
    for (let i = 0; i < cells.length; i++) cells[i].neighborMines = neighbors[i].filter((n) => cells[n].hasMine).length;
    return cells;
}

/** ゲーム本体と同じ開き方(0なら連鎖)。地雷を開いたら false */
function reveal(cells, neighbors, index) {
    const c = cells[index];
    if (c.isRevealed || c.isFlagged) return true;
    c.isRevealed = true;
    if (c.hasMine) return false;
    if (c.neighborMines === 0) {
        const stack = [index];
        while (stack.length) {
            for (const n of neighbors[stack.pop()]) {
                const nc = cells[n];
                if (nc.isRevealed || nc.isFlagged || nc.hasMine) continue;
                nc.isRevealed = true;
                if (nc.neighborMines === 0) stack.push(n);
            }
        }
    }
    return true;
}

function runSolver(kind, w, h, cells, neighbors, extended, mines) {
    const copy = JSON.parse(JSON.stringify(cells));
    if (kind === 'new') return new NewSolver(w, h, copy, neighbors, mines).solve();
    const s = new OldSolver(w, h, copy, neighbors, extended);
    s.totalMines = mines;
    return { steps: s.applySolvingRules().steps, probabilities: null };
}

const failures = [];

/** 1局プレイして勝敗・推測回数・推論時間を返す */
function play(kind, guess, w, h, mines, seed) {
    const rng = mulberry32(seed);
    const neighbors = neighborsOf(w, h);
    const extended = extendedOf(neighbors);
    const first = Math.floor(rng() * w * h);
    const cells = makeBoard(w, h, mines, first, rng, neighbors);
    reveal(cells, neighbors, first);
    let guesses = 0, solves = 0, solveMs = 0;
    const safeTotal = w * h - mines;

    for (let round = 0; round < 10000; round++) {
        const t0 = process.hrtime.bigint();
        const result = runSolver(kind, w, h, cells, neighbors, extended, mines);
        solveMs += Number(process.hrtime.bigint() - t0) / 1e6;
        solves++;

        for (const step of result.steps) {
            for (const i of step.cells) {
                if (step.type === 'reveal') {
                    if (cells[i].hasMine) { failures.push(`${kind} seed=${seed} ${w}x${h}: 「${step.log}」が地雷 ${i} を開いた`); return { win: false, guesses, solves, solveMs }; }
                    reveal(cells, neighbors, i);
                } else {
                    if (!cells[i].hasMine) { failures.push(`${kind} seed=${seed} ${w}x${h}: 「${step.log}」が安全なマス ${i} に旗を立てた`); return { win: false, guesses, solves, solveMs }; }
                    cells[i].isFlagged = true;
                }
            }
        }
        if (cells.filter((c) => c.isRevealed).length === safeTotal) return { win: true, guesses, solves, solveMs };

        // 詰まった: 推測する
        guesses++;
        const unknown = cells.filter((c) => !c.isRevealed && !c.isFlagged).map((c) => c.index);
        let pick;
        if (guess === 'minprob' && result.probabilities) {
            const p = new Map(result.probabilities.frontier.map((f) => [f.index, f.p]));
            let best = Infinity, cands = [];
            for (const i of unknown) {
                const pi = p.has(i) ? p.get(i) : (result.probabilities.sea ?? 0.5);
                if (pi < best - 1e-12) { best = pi; cands = [i]; } else if (Math.abs(pi - best) <= 1e-12) cands.push(i);
            }
            pick = cands[Math.floor(rng() * cands.length)];
        } else {
            pick = unknown[Math.floor(rng() * unknown.length)];
        }
        if (!reveal(cells, neighbors, pick)) return { win: false, guesses, solves, solveMs };
    }
    throw new Error('終わらない');
}

function stats(kind, guess, w, h, mines, n) {
    let wins = 0, guesses = 0, solves = 0, ms = 0;
    for (let s = 1; s <= n; s++) {
        const r = play(kind, guess, w, h, mines, s);
        wins += r.win ? 1 : 0; guesses += r.guesses; solves += r.solves; ms += r.solveMs;
    }
    return `${kind.padEnd(3)} ${guess.padEnd(7)} 勝率 ${(100 * wins / n).toFixed(1).padStart(5)}%  推測/局 ${(guesses / n).toFixed(2)}  推論1回 ${(ms / solves).toFixed(2)}ms`;
}

/** 詰まった局面で、全配置を数え上げた厳密な確率と比べる */
function exactCheck(w, h, mines, seed) {
    const rng = mulberry32(seed);
    const neighbors = neighborsOf(w, h);
    const first = Math.floor(rng() * w * h);
    const cells = makeBoard(w, h, mines, first, rng, neighbors);
    reveal(cells, neighbors, first);

    let result;
    for (let round = 0; round < 100; round++) {
        result = runSolver('new', w, h, cells, neighbors, null, mines);
        for (const step of result.steps) for (const i of step.cells) {
            if (step.type === 'reveal') reveal(cells, neighbors, i); else cells[i].isFlagged = true;
        }
        if (result.steps.length === 0) break;
    }
    if (!result.probabilities) return null; // 詰まらずに解けた

    const unknown = cells.filter((c) => !c.isRevealed && !c.isFlagged).map((c) => c.index);
    const remaining = mines - cells.filter((c) => c.isFlagged).length;
    if (unknown.length > 30) return null; // 全列挙が重すぎる局面は飛ばす

    const numbers = cells.filter((c) => c.isRevealed && c.neighborMines > 0);
    const isMine = new Uint8Array(cells.length);
    for (const c of cells) if (c.isFlagged) isMine[c.index] = 1;
    const consistent = () => numbers.every((c) => neighbors[c.index].reduce((a, n) => a + isMine[n], 0) === c.neighborMines);
    const mineCount = new Array(cells.length).fill(0);
    const chosen = [];
    let total = 0;
    (function rec(pos, left) {
        if (left === 0) {
            if (consistent()) { total++; for (const i of chosen) mineCount[i]++; }
            return;
        }
        if (unknown.length - pos < left) return;
        isMine[unknown[pos]] = 1; chosen.push(unknown[pos]);
        rec(pos + 1, left - 1);
        chosen.pop(); isMine[unknown[pos]] = 0;
        rec(pos + 1, left);
    })(0, remaining);
    if (total === 0) return null;

    const p = new Map(result.probabilities.frontier.map((f) => [f.index, f.p]));
    let maxErr = 0, checked = 0;
    for (const i of unknown) {
        const exact = mineCount[i] / total;
        if (exact === 0 || exact === 1) { failures.push(`seed=${seed}: マス ${i} は厳密には p=${exact} なのに確定していない`); continue; }
        const got = p.has(i) ? p.get(i) : result.probabilities.sea;
        if (got === null || got === undefined) { failures.push(`seed=${seed}: マス ${i} の確率が出ていない`); continue; }
        maxErr = Math.max(maxErr, Math.abs(got - exact));
        checked++;
    }
    return { maxErr, checked };
}

console.log('== 厳密な確率との比較 (6×6, 地雷5, 400局) ==');
let positions = 0, cellsChecked = 0, worst = 0;
for (let s = 1; s <= 400; s++) {
    const r = exactCheck(6, 6, 5, s);
    if (r) { positions++; cellsChecked += r.checked; worst = Math.max(worst, r.maxErr); }
}
console.log(`  詰まった局面 ${positions}、比較したマス ${cellsChecked}、最大誤差 ${worst.toExponential(2)}`);

console.log('\n== 成績 (各200局、同じ盤面) ==');
for (const [name, w, h, m] of [['初級 9×9/10', 9, 9, 10], ['中級 16×16/40', 16, 16, 40], ['上級 30×16/99', 30, 16, 99]]) {
    console.log(name);
    if (OldSolver) console.log('  ' + stats('old', 'random', w, h, m, 200));
    console.log('  ' + stats('new', 'random', w, h, m, 200));
    console.log('  ' + stats('new', 'minprob', w, h, m, 200));
}

console.log('\n== 100×100 / 2000 (5局) ==');
console.log('  ' + stats('new', 'minprob', 100, 100, 2000, 5));

console.log('\n== 健全性 ==');
if (failures.length) {
    console.log(`  失敗 ${failures.length} 件`);
    for (const f of failures.slice(0, 10)) console.log('  ' + f);
    process.exitCode = 1;
} else {
    console.log('  地雷を開く・安全なマスに旗を立てる・確定の見逃し、いずれも 0 件');
}
