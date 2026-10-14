// 推論エンジン。盤面の状態(cells)だけを見て、確定できる手(steps)と、
// 確定できないときの各マスの地雷確率を返す。DOMには触らないので、
// Web Worker からもメインスレッド(Workerが使えない環境)からも同じものを使う。
//
// 推論は安い順に3段階で、上の段で進めるうちは下の段には降りない:
//   1. 単独ルール(Rule 1/2)   … 1つの数字だけで決まる。作業キューで、変化したマスの周りだけ見直す
//   2. ペアルール(Rule 3/4)   … 未確定マスを共有する2つの数字の差から決める
//   3. 組み合わせ推論(Rule 5) … フロンティア(数字に接する未確定マス)の地雷配置を全列挙し、
//                               全パターンで共通して安全/地雷になるマスを決める。残り地雷数も制約に入れる。
//                               それでも決まらなければ、各マスの地雷確率を出して止まる
//
// 旗はプレイヤーの判断も含めて「地雷である」と信じて扱う(元の実装と同じ)。
/** 1回の推論で全列挙に使ってよい探索ノード数の合計。超えた成分は諦めて確率も出さない(数十msの目安) */
const SOLVER_MAX_NODES = 2000000;
/** ログに並べる座標の上限。最終ルールなどで数千マスを列挙するとログが読めなくなる */
const SOLVER_LOG_COORDS_LIMIT = 12;
class MinesweeperSolver {
    constructor(width, height, cells, neighbors, totalMines) {
        this.steps = [];
        this.queue = [];
        this.nodesUsed = 0;
        this.lnFactorial = null;
        this.width = width;
        this.height = height;
        this.cells = cells;
        this.neighbors = neighbors;
        this.totalMines = totalMines;
        this.queued = new Uint8Array(cells.length);
    }
    solve() {
        for (let i = 0; i < this.cells.length; i++) {
            if (this.isNumber(i))
                this.enqueue(i);
        }
        // 各段は「何か確定したら true」。確定したら安い段からやり直す。
        // 1手ごとに未確定マスが減るので必ず終わる。
        while (true) {
            this.runBasicRules();
            if (this.runPairRules())
                continue;
            if (this.runCountRule())
                continue;
            const result = this.runCombinatorial();
            if (result.progress)
                continue;
            return { steps: this.steps, probabilities: result.probabilities };
        }
    }
    // ---- 盤面の読み書き ----
    indexToCoords(index) {
        return `(${index % this.width},${Math.floor(index / this.width)})`;
    }
    coordsList(list) {
        const shown = list.slice(0, SOLVER_LOG_COORDS_LIMIT).map((i) => this.indexToCoords(i)).join(', ');
        const rest = list.length - SOLVER_LOG_COORDS_LIMIT;
        return rest > 0 ? `${shown} …他${rest}件` : shown;
    }
    isNumber(index) {
        const cell = this.cells[index];
        return cell.isRevealed && cell.neighborMines > 0;
    }
    isUnknown(index) {
        const cell = this.cells[index];
        return !cell.isRevealed && !cell.isFlagged;
    }
    /** 数字マスの「未確定の隣」と「残り地雷数(数字 − 旗)」 */
    constraintAt(index) {
        const unknowns = [];
        let flagged = 0;
        for (const n of this.neighbors[index]) {
            const cell = this.cells[n];
            if (cell.isFlagged)
                flagged++;
            else if (!cell.isRevealed)
                unknowns.push(n);
        }
        return { unknowns, need: this.cells[index].neighborMines - flagged };
    }
    enqueue(index) {
        if (this.queued[index])
            return;
        this.queued[index] = 1;
        this.queue.push(index);
    }
    /** マスが変わったら、そのマス自身と周りの数字マスを見直す */
    enqueueAround(changed) {
        if (this.isNumber(changed))
            this.enqueue(changed);
        for (const n of this.neighbors[changed]) {
            if (this.isNumber(n))
                this.enqueue(n);
        }
    }
    /** 開く。0なら周りも連鎖して開く。開いた全マスを返す */
    reveal(index) {
        const cell = this.cells[index];
        if (cell.isRevealed || cell.isFlagged)
            return [];
        cell.isRevealed = true;
        const opened = [index];
        if (cell.neighborMines !== 0)
            return opened;
        const stack = [index];
        while (stack.length > 0) {
            const current = stack.pop();
            for (const n of this.neighbors[current]) {
                const neighbor = this.cells[n];
                // hasMine は安全装置。0のマスの隣に地雷は無いので、正しい盤面では効かない
                if (neighbor.isRevealed || neighbor.isFlagged || neighbor.hasMine)
                    continue;
                neighbor.isRevealed = true;
                opened.push(n);
                if (neighbor.neighborMines === 0)
                    stack.push(n);
            }
        }
        return opened;
    }
    applyReveal(targets, log, ruleType) {
        const requested = targets.filter((i) => this.isUnknown(i));
        if (requested.length === 0)
            return false;
        for (const i of requested) {
            for (const opened of this.reveal(i))
                this.enqueueAround(opened);
        }
        this.steps.push({ type: 'reveal', cells: requested, log, ruleType });
        return true;
    }
    applyFlag(targets, log, ruleType) {
        const requested = targets.filter((i) => this.isUnknown(i));
        if (requested.length === 0)
            return false;
        for (const i of requested) {
            this.cells[i].isFlagged = true;
            this.enqueueAround(i);
        }
        this.steps.push({ type: 'flag', cells: requested, log, ruleType });
        return true;
    }
    // ---- 段階1: 単独ルール ----
    runBasicRules() {
        while (this.queue.length > 0) {
            const i = this.queue.pop();
            this.queued[i] = 0;
            if (!this.isNumber(i))
                continue;
            const { unknowns, need } = this.constraintAt(i);
            if (unknowns.length === 0)
                continue;
            const here = this.indexToCoords(i);
            if (need === 0) {
                this.applyReveal(unknowns, `Rule 1: ${here} の周りの安全なセルを開く: ${this.coordsList(unknowns)}`, 'rule-1');
            }
            else if (need === unknowns.length) {
                this.applyFlag(unknowns, `Rule 2: ${here} の周りに地雷を配置: ${this.coordsList(unknowns)}`, 'rule-2');
            }
        }
    }
    // ---- 段階2: ペアルール ----
    runPairRules() {
        let changed = false;
        for (let a = 0; a < this.cells.length; a++) {
            if (!this.isNumber(a))
                continue;
            // 1つ当たったら a の情報が古くなるので、同じ a をもう一度見直す
            let hit;
            do {
                hit = false;
                const ca = this.constraintAt(a);
                if (ca.unknowns.length === 0)
                    break;
                // a と未確定マスを共有する数字マスだけが相手になる
                const partners = new Set();
                for (const u of ca.unknowns) {
                    for (const n of this.neighbors[u]) {
                        if (n !== a && this.isNumber(n))
                            partners.add(n);
                    }
                }
                for (const b of partners) {
                    if (this.applyPairRule(a, b, ca.unknowns, ca.need)) {
                        hit = true;
                        changed = true;
                        break;
                    }
                }
            } while (hit);
        }
        return changed;
    }
    /**
     * A の未確定 = S ∪ onlyA、B の未確定 = S ∪ onlyB とすると
     *   needA − needB = mines(onlyA) − mines(onlyB)
     * mines(onlyA) ≤ |onlyA|、mines(onlyB) ≥ 0 なので、差が |onlyA| に達していたら
     * onlyA は全部地雷、onlyB は全部安全。逆向きも同様。
     * (onlyA が空なら「A ⊂ B で need が同じ → B だけの部分は安全」という包含ルールになる)
     */
    applyPairRule(a, b, unknownsA, needA) {
        const { unknowns: unknownsB, need: needB } = this.constraintAt(b);
        if (unknownsB.length === 0)
            return false;
        // 隣接マスは最大8個なので、Set を作るより includes のほうが速い
        const onlyA = unknownsA.filter((u) => !unknownsB.includes(u));
        const onlyB = unknownsB.filter((u) => !unknownsA.includes(u));
        if (onlyA.length === 0 && onlyB.length === 0)
            return false;
        const diff = needA - needB;
        if (diff === onlyA.length)
            return this.applyPairResult(a, b, onlyA, onlyB);
        if (-diff === onlyB.length)
            return this.applyPairResult(b, a, onlyB, onlyA);
        return false;
    }
    applyPairResult(a, b, mines, safe) {
        const pair = `${this.indexToCoords(a)} と ${this.indexToCoords(b)}`;
        let changed = false;
        if (safe.length > 0) {
            changed = this.applyReveal(safe, `Rule 3: ${pair} の関係から安全なセルを推論: ${this.coordsList(safe)}`, 'rule-3') || changed;
        }
        if (mines.length > 0) {
            changed = this.applyFlag(mines, `Rule 4: ${pair} の関係から地雷を推論: ${this.coordsList(mines)}`, 'rule-4') || changed;
        }
        return changed;
    }
    // ---- 残り地雷数だけで決まるルール ----
    runCountRule() {
        if (!Number.isFinite(this.totalMines))
            return false;
        const unknowns = [];
        let flags = 0;
        for (let i = 0; i < this.cells.length; i++) {
            const cell = this.cells[i];
            if (cell.isFlagged)
                flags++;
            else if (!cell.isRevealed)
                unknowns.push(i);
        }
        if (unknowns.length === 0)
            return false;
        const remaining = this.totalMines - flags;
        if (remaining === 0) {
            return this.applyReveal(unknowns, `最終ルール: 地雷は全て旗が立ったので、残りを開く: ${this.coordsList(unknowns)}`, 'rule-3');
        }
        if (remaining === unknowns.length) {
            return this.applyFlag(unknowns, `最終ルール: 残りの未探索セル全てに地雷を配置: ${this.coordsList(unknowns)}`, 'rule-4');
        }
        return false;
    }
    // ---- 段階3: 組み合わせ推論 ----
    runCombinatorial() {
        const constraints = [];
        const inFrontier = new Uint8Array(this.cells.length);
        for (let i = 0; i < this.cells.length; i++) {
            if (!this.isNumber(i))
                continue;
            const { unknowns, need } = this.constraintAt(i);
            if (unknowns.length === 0)
                continue;
            constraints.push({ cells: unknowns, need });
            for (const u of unknowns)
                inFrontier[u] = 1;
        }
        if (constraints.length === 0)
            return { progress: false, probabilities: null };
        const seaCells = [];
        let flags = 0;
        for (let i = 0; i < this.cells.length; i++) {
            const cell = this.cells[i];
            if (cell.isFlagged)
                flags++;
            else if (!cell.isRevealed && !inFrontier[i])
                seaCells.push(i);
        }
        const remaining = Number.isFinite(this.totalMines) ? this.totalMines - flags : null;
        const components = this.splitComponents(constraints);
        const counts = components.map((c) => this.enumerate(c));
        const allSolved = counts.every((c) => c !== null);
        // 残り地雷数と海の大きさが分かれば、「地雷 k 個のパターン」の起こりやすさで重み付けできる。
        // 列挙を諦めた成分があると分布が出せないので、その場合は成分ごとの局所的な数え上げだけで判断する
        const weights = remaining !== null && allSolved
            ? this.globalWeights(counts, remaining, seaCells.length)
            : null;
        const safe = [];
        const mines = [];
        const frontier = [];
        counts.forEach((comp, ci) => {
            if (!comp)
                return;
            const w = weights ? weights.perComponent[ci] : null;
            for (let v = 0; v < comp.vars.length; v++) {
                let total = 0;
                let mine = 0;
                let totalW = 0;
                let mineW = 0;
                for (let k = 0; k < comp.totalByK.length; k++) {
                    if (w && !w.feasible[k])
                        continue;
                    const t = comp.totalByK[k];
                    const m = comp.mineByK[v][k];
                    total += t;
                    mine += m;
                    if (w) {
                        totalW += t * w.weight[k];
                        mineW += m * w.weight[k];
                    }
                }
                // 1パターンも成り立たないのは旗の置き間違い。何も言えないので飛ばす
                if (total === 0)
                    continue;
                const index = comp.vars[v];
                if (mine === 0)
                    safe.push(index);
                else if (mine === total)
                    mines.push(index);
                else
                    frontier.push({ index, p: w && totalW > 0 ? mineW / totalW : mine / total });
            }
        });
        let sea = null;
        if (weights && seaCells.length > 0) {
            if (weights.seaMinesMax === 0)
                safe.push(...seaCells);
            else if (weights.seaMinesMin === seaCells.length)
                mines.push(...seaCells);
            else
                sea = weights.seaProbability;
        }
        if (safe.length > 0 || mines.length > 0) {
            const scope = `フロンティア${constraints.length}か所の地雷配置を全て試した結果`;
            this.applyReveal(safe, `Rule 5: ${scope}、安全が確定: ${this.coordsList(safe)}`, 'rule-5');
            this.applyFlag(mines, `Rule 5: ${scope}、地雷が確定: ${this.coordsList(mines)}`, 'rule-5');
            return { progress: true, probabilities: null };
        }
        return { progress: false, probabilities: { frontier, sea } };
    }
    /** 未確定マスを共有する制約どうしをつないで、独立に扱える成分に分ける */
    splitComponents(constraints) {
        const parent = new Map();
        const find = (x) => {
            let root = x;
            while (parent.get(root) !== root)
                root = parent.get(root);
            while (parent.get(x) !== root) {
                const next = parent.get(x);
                parent.set(x, root);
                x = next;
            }
            return root;
        };
        const union = (a, b) => {
            parent.set(find(a), find(b));
        };
        for (const c of constraints) {
            for (const cell of c.cells) {
                if (!parent.has(cell))
                    parent.set(cell, cell);
            }
            for (let i = 1; i < c.cells.length; i++)
                union(c.cells[0], c.cells[i]);
        }
        const groups = new Map();
        const seen = new Set();
        for (const c of constraints) {
            const root = find(c.cells[0]);
            let group = groups.get(root);
            if (!group) {
                group = { vars: [], cons: [] };
                groups.set(root, group);
            }
            // 変数は制約に出てきた順に並べる。同じ制約の変数が隣り合うので、列挙の枝刈りが早く効く
            for (const cell of c.cells) {
                if (!seen.has(cell)) {
                    seen.add(cell);
                    group.vars.push(cell);
                }
            }
            group.cons.push(c);
        }
        return [...groups.values()];
    }
    /**
     * 成分の地雷配置をバックトラックで全列挙し、地雷数 k ごとにパターン数を数える。
     * 各制約について「もう地雷が多すぎる」「残りのマスを全部地雷にしても足りない」の
     * どちらかになった時点で枝を切る。探索ノードの予算を超えたら null。
     */
    enumerate(component) {
        const { vars, cons } = component;
        const n = vars.length;
        const local = new Map();
        vars.forEach((cell, v) => local.set(cell, v));
        const need = cons.map((c) => c.need);
        const size = cons.map((c) => c.cells.length);
        const varCons = vars.map(() => []);
        cons.forEach((c, ci) => {
            for (const cell of c.cells)
                varCons[local.get(cell)].push(ci);
        });
        const assignedMines = new Int32Array(cons.length);
        const assignedCount = new Int32Array(cons.length);
        const totalByK = new Array(n + 1).fill(0);
        const mineByK = vars.map(() => new Array(n + 1).fill(0));
        const minesOnPath = [];
        const budget = SOLVER_MAX_NODES - this.nodesUsed;
        let nodes = 0;
        let aborted = false;
        const canAssign = (v, mine) => {
            for (const ci of varCons[v]) {
                const m = assignedMines[ci] + mine;
                if (m > need[ci])
                    return false;
                if (need[ci] - m > size[ci] - assignedCount[ci] - 1)
                    return false;
            }
            return true;
        };
        const assign = (v, mine) => {
            for (const ci of varCons[v]) {
                assignedMines[ci] += mine;
                assignedCount[ci]++;
            }
        };
        const unassign = (v, mine) => {
            for (const ci of varCons[v]) {
                assignedMines[ci] -= mine;
                assignedCount[ci]--;
            }
        };
        const dfs = (pos) => {
            if (aborted)
                return;
            if (++nodes > budget) {
                aborted = true;
                return;
            }
            if (pos === n) {
                const k = minesOnPath.length;
                totalByK[k]++;
                for (const v of minesOnPath)
                    mineByK[v][k]++;
                return;
            }
            if (canAssign(pos, 1)) {
                assign(pos, 1);
                minesOnPath.push(pos);
                dfs(pos + 1);
                minesOnPath.pop();
                unassign(pos, 1);
            }
            if (canAssign(pos, 0)) {
                assign(pos, 0);
                dfs(pos + 1);
                unassign(pos, 0);
            }
        };
        dfs(0);
        this.nodesUsed += nodes;
        if (aborted)
            return null;
        return { vars, totalByK, mineByK };
    }
    /**
     * 残り地雷数 R と海(どの数字にも接していない未確定マス)の大きさから、各成分の
     * 「地雷 k 個のパターン」の重みを求める。
     *
     * 成分 c が k 個、他の成分が合わせて j 個なら、海には R − k − j 個入る。その置き方は
     * C(海, R − k − j) 通りなので、重み(k) = Σ_j other(j) × C(海, R − k − j)。
     * パターン数も二項係数も桁が大きくなるので、分布は合計1に正規化し、二項係数は対数で扱う。
     */
    globalWeights(counts, remaining, seaSize) {
        const normalize = (dist) => {
            const sum = dist.reduce((a, b) => a + b, 0);
            return dist.map((x) => x / sum);
        };
        const convolve = (a, b) => {
            const out = new Array(a.length + b.length - 1).fill(0);
            for (let i = 0; i < a.length; i++) {
                if (a[i] === 0)
                    continue;
                for (let j = 0; j < b.length; j++)
                    out[i + j] += a[i] * b[j];
            }
            return out;
        };
        const convolveBool = (a, b) => {
            const out = new Array(a.length + b.length - 1).fill(false);
            for (let i = 0; i < a.length; i++) {
                if (!a[i])
                    continue;
                for (let j = 0; j < b.length; j++)
                    if (b[j])
                        out[i + j] = true;
            }
            return out;
        };
        const dists = counts.map((c) => normalize(c.totalByK));
        const feas = counts.map((c) => c.totalByK.map((t) => t > 0));
        const m = dists.length;
        const prefix = [[1]];
        const prefixFeas = [[true]];
        for (let i = 0; i < m; i++) {
            prefix.push(convolve(prefix[i], dists[i]));
            prefixFeas.push(convolveBool(prefixFeas[i], feas[i]));
        }
        const suffix = new Array(m + 1);
        const suffixFeas = new Array(m + 1);
        suffix[m] = [1];
        suffixFeas[m] = [true];
        for (let i = m - 1; i >= 0; i--) {
            suffix[i] = convolve(dists[i], suffix[i + 1]);
            suffixFeas[i] = convolveBool(feas[i], suffixFeas[i + 1]);
        }
        const seaFits = (s) => s >= 0 && s <= seaSize;
        const lnSea = (s) => this.lnChoose(seaSize, s);
        // 全体の分布から、海に入る地雷数の範囲と期待値(= 海の1マスあたりの確率)を出す
        const totalDist = prefix[m];
        const totalFeas = prefixFeas[m];
        let seaMinesMin = Infinity;
        let seaMinesMax = -Infinity;
        const lnTerms = [];
        const seaCounts = [];
        for (let t = 0; t < totalDist.length; t++) {
            const s = remaining - t;
            if (!seaFits(s))
                continue;
            if (totalFeas[t]) {
                seaMinesMin = Math.min(seaMinesMin, s);
                seaMinesMax = Math.max(seaMinesMax, s);
            }
            if (totalDist[t] > 0) {
                lnTerms.push(Math.log(totalDist[t]) + lnSea(s));
                seaCounts.push(s);
            }
        }
        let seaProbability = 0;
        if (seaSize > 0 && lnTerms.length > 0) {
            const maxLn = Math.max(...lnTerms);
            let num = 0;
            let den = 0;
            lnTerms.forEach((ln, i) => {
                const w = Math.exp(ln - maxLn);
                den += w;
                num += w * seaCounts[i];
            });
            seaProbability = num / den / seaSize;
        }
        const perComponent = counts.map((comp, ci) => {
            const other = convolve(prefix[ci], suffix[ci + 1]);
            const otherFeas = convolveBool(prefixFeas[ci], suffixFeas[ci + 1]);
            const kCount = comp.totalByK.length;
            const lnWeight = new Array(kCount).fill(-Infinity);
            const feasible = new Array(kCount).fill(false);
            for (let k = 0; k < kCount; k++) {
                for (let j = 0; j < other.length; j++) {
                    const s = remaining - k - j;
                    if (!seaFits(s))
                        continue;
                    if (otherFeas[j])
                        feasible[k] = true;
                    if (other[j] > 0) {
                        lnWeight[k] = logAddExp(lnWeight[k], Math.log(other[j]) + lnSea(s));
                    }
                }
            }
            // 重みは成分内の相対値だけ意味があるので、最大を1にそろえて桁あふれを避ける
            const maxLn = Math.max(...lnWeight);
            const weight = lnWeight.map((ln) => (ln === -Infinity ? 0 : Math.exp(ln - maxLn)));
            return { weight, feasible };
        });
        return { perComponent, seaMinesMin, seaMinesMax, seaProbability };
    }
    /** ln C(n, k)。海は最大1万マスなので、階乗の対数を一度だけ表にしておく */
    lnChoose(n, k) {
        if (k < 0 || k > n)
            return -Infinity;
        if (!this.lnFactorial || this.lnFactorial.length <= n) {
            const table = new Float64Array(n + 1);
            for (let i = 1; i <= n; i++)
                table[i] = table[i - 1] + Math.log(i);
            this.lnFactorial = table;
        }
        const f = this.lnFactorial;
        return f[n] - f[k] - f[n - k];
    }
}
/** ln(e^a + e^b) を桁あふれなしで */
function logAddExp(a, b) {
    if (a === -Infinity)
        return b;
    if (b === -Infinity)
        return a;
    const hi = Math.max(a, b);
    return hi + Math.log(Math.exp(a - hi) + Math.exp(b - hi));
}
