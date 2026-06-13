// @ts-nocheck
/**
 * Semi-Automatic Minesweeper
 * JavaScript conversion of IOCCC 2020 endoh1 entry by Yusuke Endoh
 *
 * This program automatically applies logical inference rules to solve
 * the minesweeper puzzle. The player only needs to make initial guesses.
 */
class Minesweeper {
    constructor(width, height, mineCount) {
        this.width = width;
        this.height = height;
        this.totalMines = mineCount;
        this.cells = [];
        this.gameState = 'ready'; // ready, playing, won, lost
        this.startTime = null;
        this.timerInterval = null;
        this.firstClick = true;
        this.animationSpeed = 5; // milliseconds between each step
        this.visibleFastStepsPerFrame = 50;
        this.fastFrameStepCount = 0;
        this.isAnimating = false;
        this.reasoningLog = [];
        this.logCallback = null;
        this.clearCount = 0; // 開いたセルの数
        this.worker = null; // Web Worker
        this.useWorker = true; // Workerを使用するかどうか
        this.initGame();
        this.initWorker();
    }
    initWorker() {
        try {
            this.worker = new Worker('dist/minesweeper-worker.js');
        }
        catch (e) {
            console.warn('Web Worker not available, falling back to main thread');
            this.useWorker = false;
        }
    }
    initGame() {
        this.cells = [];
        this.reasoningLog = [];
        this.clearCount = 0;
        this.neighborsCache = []; // キャッシュを追加
        this.dirtySet = new Set(); // 変更があったセルのインデックスを記録
        this.extendedNeighborsCache = []; // 2段階先までのネイバーキャッシュ
        for (let i = 0; i < this.width * this.height; i++) {
            this.cells.push({
                hasMine: false,
                isRevealed: false,
                isFlagged: false,
                neighborMines: 0,
                index: i
            });
            // 隣接セルを事前計算してキャッシュ
            this.neighborsCache[i] = this.calculateNeighbors(i);
        }
        // 2段階先までのネイバーを事前計算
        this.precomputeExtendedNeighbors();
    }
    calculateNeighbors(index) {
        const neighbors = [];
        const x = index % this.width;
        const y = Math.floor(index / this.width);
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                if (dx === 0 && dy === 0)
                    continue;
                const nx = x + dx;
                const ny = y + dy;
                if (nx >= 0 && nx < this.width && ny >= 0 && ny < this.height) {
                    neighbors.push(ny * this.width + nx);
                }
            }
        }
        return neighbors;
    }
    precomputeExtendedNeighbors() {
        // 各セルについて、隣接セル+その隣接セルの開示済みセルを事前計算
        for (let i = 0; i < this.cells.length; i++) {
            const extendedSet = new Set();
            const neighbors = this.neighborsCache[i];
            for (let j = 0; j < neighbors.length; j++) {
                const n = neighbors[j];
                extendedSet.add(n);
                // 隣接セルの隣接セルも追加（2段階先まで）
                const secondNeighbors = this.neighborsCache[n];
                for (let k = 0; k < secondNeighbors.length; k++) {
                    extendedSet.add(secondNeighbors[k]);
                }
            }
            // 自分自身は除外
            extendedSet.delete(i);
            this.extendedNeighborsCache[i] = Array.from(extendedSet);
        }
    }
    addLog(message, ruleType = 'info') {
        const timestamp = new Date().toLocaleTimeString('ja-JP');
        this.reasoningLog.push({ message, ruleType, timestamp });
        if (this.logCallback) {
            this.logCallback(this.reasoningLog);
        }
    }
    indexToCoords(index) {
        const x = index % this.width;
        const y = Math.floor(index / this.width);
        return `(${x},${y})`;
    }
    placeMines(excludeIndex) {
        // Place mines randomly, excluding the first clicked cell
        let minesPlaced = 0;
        const availableIndices = [];
        for (let i = 0; i < this.cells.length; i++) {
            if (i !== excludeIndex) {
                availableIndices.push(i);
            }
        }
        // Fisher-Yates shuffle
        for (let i = availableIndices.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [availableIndices[i], availableIndices[j]] = [availableIndices[j], availableIndices[i]];
        }
        // Place mines
        for (let i = 0; i < this.totalMines && i < availableIndices.length; i++) {
            this.cells[availableIndices[i]].hasMine = true;
            minesPlaced++;
        }
        // Calculate neighbor mine counts
        this.calculateNeighborMines();
    }
    calculateNeighborMines() {
        for (let i = 0; i < this.cells.length; i++) {
            if (!this.cells[i].hasMine) {
                this.cells[i].neighborMines = this.countNeighborMines(i);
            }
        }
    }
    getNeighbors(index) {
        // キャッシュから取得
        return this.neighborsCache[index];
    }
    countNeighborMines(index) {
        const neighbors = this.neighborsCache[index];
        let count = 0;
        for (let i = 0; i < neighbors.length; i++) {
            if (this.cells[neighbors[i]].hasMine)
                count++;
        }
        return count;
    }
    revealCell(index) {
        if (this.gameState === 'won' || this.gameState === 'lost')
            return;
        if (index < 0 || index >= this.cells.length)
            return;
        const cell = this.cells[index];
        if (cell.isRevealed || cell.isFlagged)
            return;
        // First click setup
        if (this.firstClick) {
            this.placeMines(index);
            this.firstClick = false;
            this.gameState = 'playing';
            this.startTimer();
        }
        cell.isRevealed = true;
        this.clearCount++;
        this.dirtySet.add(index); // 変更を記録
        // 進捗に応じて背景色を更新
        this.updateProgress();
        // Hit a mine
        if (cell.hasMine) {
            this.gameState = 'lost';
            this.stopTimer();
            this.addLog('💥 地雷を踏んでしまいました...', 'info');
            this.revealAllMines();
            return false;
        }
        // Auto-reveal neighbors if no nearby mines - 再帰の代わりにキューで処理
        if (cell.neighborMines === 0) {
            const queue = [index];
            const processed = new Set([index]);
            while (queue.length > 0) {
                const currentIndex = queue.shift();
                const neighbors = this.neighborsCache[currentIndex];
                for (let i = 0; i < neighbors.length; i++) {
                    const n = neighbors[i];
                    if (processed.has(n))
                        continue;
                    const neighbor = this.cells[n];
                    if (neighbor.isRevealed || neighbor.isFlagged || neighbor.hasMine)
                        continue;
                    neighbor.isRevealed = true;
                    this.clearCount++;
                    this.dirtySet.add(n); // 変更を記録
                    this.updateProgress();
                    processed.add(n);
                    // 0の場合はキューに追加して展開を続ける
                    if (neighbor.neighborMines === 0) {
                        queue.push(n);
                    }
                }
            }
        }
        return true;
    }
    flagCell(index) {
        if (this.gameState !== 'playing')
            return;
        if (index < 0 || index >= this.cells.length)
            return;
        const cell = this.cells[index];
        if (cell.isRevealed)
            return;
        cell.isFlagged = !cell.isFlagged;
        this.dirtySet.add(index); // 変更を記録
    }
    // Semi-automatic solving logic - applies the 4 rules from the original
    async applySolvingRules(onUpdate, onReveal) {
        if (this.useWorker && this.worker) {
            return this.applySolvingRulesWithWorker(onUpdate, onReveal);
        }
        return this.applySolvingRulesMainThread(onUpdate, onReveal);
    }
    async applySolvingRulesWithWorker(onUpdate, onReveal) {
        return new Promise((resolve) => {
            // Workerにデータを送信
            this.worker.postMessage({
                width: this.width,
                height: this.height,
                cells: JSON.parse(JSON.stringify(this.cells)), // Deep copy
                neighborsCache: this.neighborsCache,
                extendedNeighborsCache: this.extendedNeighborsCache,
                totalMines: this.totalMines
            });
            // Workerからの結果を受信
            this.worker.onmessage = async (e) => {
                const { steps } = e.data;
                // ステップごとにアニメーション表示
                for (const step of steps) {
                    this.addLog(step.log, step.ruleType);
                    // 変更されたセルをdirtySetに追加
                    if (step.cells && Array.isArray(step.cells)) {
                        if (step.type === 'reveal') {
                            for (const index of step.cells) {
                                this.revealCell(index);
                                this.dirtySet.add(index);
                            }
                        }
                        else if (step.type === 'flag') {
                            for (const index of step.cells) {
                                this.cells[index].isFlagged = true;
                                this.dirtySet.add(index);
                            }
                        }
                        // onRevealコールバックを呼び出し
                        if (onReveal && step.type === 'reveal') {
                            onReveal(step.cells);
                        }
                    }
                    await this.afterSolvingStep(onUpdate);
                }
                await this.flushSolvingAnimation(onUpdate);
                resolve();
            };
        });
    }
    async applySolvingRulesMainThread(onUpdate, onReveal) {
        let changed = true;
        let iterations = 0;
        const maxIterations = 1000;
        while (changed && iterations < maxIterations) {
            changed = false;
            iterations++;
            for (let i = 0; i < this.cells.length; i++) {
                const cell = this.cells[i];
                if (!cell.isRevealed || cell.neighborMines === 0)
                    continue;
                const neighbors = this.neighborsCache[i];
                // 高速化: filterの代わりにループで直接カウント＆配列作成
                const flaggedNeighbors = [];
                const unrevealedNeighbors = [];
                for (let k = 0; k < neighbors.length; k++) {
                    const n = neighbors[k];
                    const neighbor = this.cells[n];
                    if (neighbor.isFlagged) {
                        flaggedNeighbors.push(n);
                    }
                    else if (!neighbor.isRevealed) {
                        unrevealedNeighbors.push(n);
                    }
                }
                // Rule 1: If number equals flagged count, reveal all unrevealed neighbors
                if (cell.neighborMines === flaggedNeighbors.length && unrevealedNeighbors.length > 0) {
                    // 座標変換を遅延評価(ログ出力時のみ実行)
                    const coords = this.indexToCoords(i);
                    const targetCoords = unrevealedNeighbors.map(n => this.indexToCoords(n)).join(', ');
                    this.addLog(`Rule 1: ${coords} の周りの安全なセルを開く: ${targetCoords}`, 'rule-1');
                    // バッチ処理: まとめて開いてから1回だけ描画
                    const revealedIndices = [];
                    for (const n of unrevealedNeighbors) {
                        if (this.revealCell(n)) {
                            changed = true;
                            revealedIndices.push(n);
                        }
                    }
                    if (changed) {
                        if (onReveal && revealedIndices.length > 0) {
                            onReveal(revealedIndices);
                        }
                        await this.afterSolvingStep(onUpdate);
                    }
                }
                // Rule 2: If number equals unrevealed + flagged count, flag all unrevealed
                if (cell.neighborMines === flaggedNeighbors.length + unrevealedNeighbors.length && unrevealedNeighbors.length > 0) {
                    const coords = this.indexToCoords(i);
                    const targetCoords = unrevealedNeighbors.map(n => this.indexToCoords(n)).join(', ');
                    this.addLog(`Rule 2: ${coords} の周りに地雷を配置: ${targetCoords}`, 'rule-2');
                    // バッチ処理: まとめて旗を立ててから1回だけ描画
                    for (const n of unrevealedNeighbors) {
                        this.cells[n].isFlagged = true;
                        this.dirtySet.add(n); // 変更を記録
                        changed = true;
                    }
                    if (changed) {
                        await this.afterSolvingStep(onUpdate);
                    }
                }
                // Rules 3 & 4: Compare two neighboring number cells
                if (changed)
                    continue; // Skip complex rules if simple rules worked
                // 最適化: 事前計算された拡張ネイバーキャッシュを使用
                const extendedNeighbors = this.extendedNeighborsCache[i];
                for (let k = 0; k < extendedNeighbors.length; k++) {
                    const j = extendedNeighbors[k];
                    // 開示済みで数字があるセルのみをチェック
                    if (!this.cells[j].isRevealed || this.cells[j].neighborMines === 0)
                        continue;
                    const result = await this.applyAdvancedRules(i, j, onUpdate, onReveal);
                    if (result) {
                        changed = true;
                        break;
                    }
                }
            }
        }
        // Final rule: If unrevealed cells equal remaining mines, flag all
        await this.applyFinalRule(onUpdate);
        await this.flushSolvingAnimation(onUpdate);
    }
    delay(ms) {
        if (ms <= 0)
            return Promise.resolve();
        // 常にsetTimeoutを使用して正確な遅延を実現
        // 注: ブラウザの制約により、実際の最小遅延は約4ms程度
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    async afterSolvingStep(onUpdate) {
        if (!onUpdate)
            return;
        if (this.animationSpeed <= 0) {
            this.fastFrameStepCount++;
            if (this.fastFrameStepCount < this.visibleFastStepsPerFrame) {
                return;
            }
            this.fastFrameStepCount = 0;
            onUpdate();
            await new Promise(resolve => requestAnimationFrame(resolve));
            return;
        }
        this.fastFrameStepCount = 0;
        onUpdate();
        await this.delay(this.animationSpeed);
    }
    async flushSolvingAnimation(onUpdate) {
        if (!onUpdate)
            return;
        if (this.animationSpeed > 0 || this.fastFrameStepCount === 0)
            return;
        this.fastFrameStepCount = 0;
        onUpdate();
        await new Promise(resolve => requestAnimationFrame(resolve));
    }
    async applyAdvancedRules(indexA, indexB, onUpdate, onReveal) {
        const cellA = this.cells[indexA];
        const cellB = this.cells[indexB];
        const neighborsA = this.neighborsCache[indexA];
        const neighborsB = this.neighborsCache[indexB];
        // 高速化: Setを使って隣接セルを効率的に管理
        const neighborsBSet = new Set(neighborsB);
        // フィルター処理を1ループで実行
        const flaggedA = [];
        const unrevealedA = [];
        const uniqueToA = [];
        for (let i = 0; i < neighborsA.length; i++) {
            const n = neighborsA[i];
            const neighbor = this.cells[n];
            if (neighbor.isFlagged) {
                flaggedA.push(n);
            }
            else if (!neighbor.isRevealed) {
                unrevealedA.push(n);
                if (!neighborsBSet.has(n)) {
                    uniqueToA.push(n);
                }
            }
        }
        // BについてもUnique計算が必要な場合のみ処理
        let flaggedBCount = 0;
        let uniqueToB = [];
        const neighborsASet = new Set(neighborsA);
        for (let i = 0; i < neighborsB.length; i++) {
            const n = neighborsB[i];
            const neighbor = this.cells[n];
            if (neighbor.isFlagged) {
                flaggedBCount++;
            }
            else if (!neighbor.isRevealed && !neighborsASet.has(n)) {
                uniqueToB.push(n);
            }
        }
        if (uniqueToA.length === 0 && uniqueToB.length === 0)
            return false;
        const remainingA = cellA.neighborMines - flaggedA.length;
        const remainingB = cellB.neighborMines - flaggedBCount;
        // Rule 3: If A's remaining equals B's remaining minus unique to B, reveal unique to A
        if (uniqueToA.length > 0 && remainingA === remainingB - uniqueToB.length) {
            const coordsA = this.indexToCoords(indexA);
            const coordsB = this.indexToCoords(indexB);
            const targetCoords = uniqueToA.map(n => this.indexToCoords(n)).join(', ');
            this.addLog(`Rule 3: ${coordsA} と ${coordsB} の関係から安全なセルを推論: ${targetCoords}`, 'rule-3');
            // バッチ処理: まとめて開いてから1回だけ描画
            for (const n of uniqueToA) {
                this.revealCell(n);
            }
            if (onReveal && uniqueToA.length > 0) {
                onReveal(uniqueToA);
            }
            await this.afterSolvingStep(onUpdate);
            return true;
        }
        // Rule 4: If B's remaining equals A's remaining minus unique to A, flag unique to A
        if (uniqueToA.length > 0 && remainingB === remainingA - uniqueToA.length) {
            const coordsA = this.indexToCoords(indexA);
            const coordsB = this.indexToCoords(indexB);
            const targetCoords = uniqueToA.map(n => this.indexToCoords(n)).join(', ');
            this.addLog(`Rule 4: ${coordsA} と ${coordsB} の関係から地雷を推論: ${targetCoords}`, 'rule-4');
            // バッチ処理: まとめて旗を立ててから1回だけ描画
            for (const n of uniqueToA) {
                this.cells[n].isFlagged = true;
                this.dirtySet.add(n); // 変更を記録
            }
            await this.afterSolvingStep(onUpdate);
            return true;
        }
        return false;
    }
    async applyFinalRule(onUpdate) {
        // 高速化: 1ループで両方をカウント
        const unrevealedCells = [];
        let flaggedCount = 0;
        for (let i = 0; i < this.cells.length; i++) {
            const cell = this.cells[i];
            if (cell.isFlagged) {
                flaggedCount++;
            }
            else if (!cell.isRevealed) {
                unrevealedCells.push(cell);
            }
        }
        const remainingMines = this.totalMines - flaggedCount;
        if (unrevealedCells.length === remainingMines && remainingMines > 0) {
            const targetCoords = unrevealedCells.map(c => this.indexToCoords(c.index)).join(', ');
            this.addLog(`最終ルール: 残りの未探索セル全てに地雷を配置: ${targetCoords}`, 'rule-4');
            // バッチ処理: まとめて旗を立ててから1回だけ描画
            for (const cell of unrevealedCells) {
                cell.isFlagged = true;
                this.dirtySet.add(cell.index); // 変更を記録
            }
            await this.afterSolvingStep(onUpdate);
        }
    }
    checkWin() {
        const allNonMinesRevealed = this.cells.every(cell => cell.hasMine || cell.isRevealed);
        if (allNonMinesRevealed && this.gameState === 'playing') {
            this.gameState = 'won';
            this.stopTimer();
            this.addLog('🎉 クリア！おめでとうございます！', 'info');
            // Flag all remaining mines
            this.cells.forEach(cell => {
                if (cell.hasMine && !cell.isFlagged) {
                    cell.isFlagged = true;
                    this.dirtySet.add(cell.index); // 変更を記録
                }
            });
            return true;
        }
        return false;
    }
    revealAllMines() {
        this.cells.forEach(cell => {
            if (cell.hasMine) {
                cell.isRevealed = true;
                this.dirtySet.add(cell.index); // 変更を記録
            }
        });
    }
    startTimer() {
        this.startTime = Date.now();
        this.timerInterval = setInterval(() => {
            this.updateTimer();
        }, 100);
    }
    stopTimer() {
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
        }
    }
    updateTimer() {
        if (this.startTime) {
            const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
            const display = Math.min(elapsed, 999);
            document.getElementById('timer').textContent = display.toString().padStart(3, '0');
        }
    }
    getRemainingMines() {
        // 高速化: filterの代わりにループでカウント
        let flaggedCount = 0;
        for (let i = 0; i < this.cells.length; i++) {
            if (this.cells[i].isFlagged)
                flaggedCount++;
        }
        return Math.max(0, this.totalMines - flaggedCount);
    }
    updateProgress() {
        // 開いたセルの数 ÷ 爆弾のない全セルの数 × 100
        const progress = (this.clearCount / (this.width * this.height - this.totalMines)) * 100;
        const body = document.body;
        if (progress >= 100) {
            body.className = 'is-morning';
        }
        else if (progress >= 87.5) {
            body.className = 'is-earlyMorning';
        }
        else if (progress >= 75) {
            body.className = 'is-sunrise';
        }
        else if (progress >= 62.5) {
            body.className = 'is-dayBreak';
        }
        else if (progress >= 50) {
            body.className = 'is-lateNight';
        }
        else if (progress >= 37.5) {
            body.className = 'is-midNight';
        }
        else if (progress >= 25) {
            body.className = 'is-deepNight';
        }
        else if (progress >= 12.5) {
            body.className = 'is-silentNight';
        }
        else if (progress >= 1) {
            body.className = 'is-night';
        }
        else {
            body.className = '';
        }
    }
}
// Game UI Controller
class GameUI {
    constructor() {
        this.game = null;
        this.boardElement = document.getElementById('gameBoard');
        this.newGameBtn = document.getElementById('newGameBtn');
        this.logElement = document.getElementById('reasoningLog');
        this.logScrollPending = false; // ログスクロールの重複防止フラグ
        // プログレスバーとコンボカウンター
        this.progressBar = document.getElementById('progressBar');
        this.progressText = document.getElementById('progressText');
        this.comboCounter = document.getElementById('comboCounter');
        this.comboText = document.getElementById('comboText');
        this.currentCombo = 0;
        this.maxCombo = 0;
        // サウンド設定
        this.soundEnabled = false;
        this.initAudio();
        this.setupEventListeners();
        this.newGame(16, 16, 40);
    }
    initAudio() {
        // Web Audio API でサウンドを生成
        this.audioContext = null;
        try {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        catch (e) {
            console.warn('Web Audio API not supported');
            this.soundEnabled = false;
        }
        // 連鎖音用のカウンター
        this.chainCounter = 0;
        this.chainResetTimer = null;
        // 曲のメロディー（カノン）
        this.melodyNotes = [
            // パッヘルベルのカノン（最初の部分）
            { note: 'D4', duration: 1.0 },
            { note: 'A3', duration: 1.0 },
            { note: 'B3', duration: 1.0 },
            { note: 'F#3', duration: 1.0 },
            { note: 'G3', duration: 1.0 },
            { note: 'D3', duration: 1.0 },
            { note: 'G3', duration: 1.0 },
            { note: 'A3', duration: 1.0 },
            // 繰り返し
            { note: 'D4', duration: 0.5 },
            { note: 'C#4', duration: 0.5 },
            { note: 'D4', duration: 0.5 },
            { note: 'A3', duration: 0.5 },
            { note: 'B3', duration: 0.5 },
            { note: 'A3', duration: 0.5 },
            { note: 'B3', duration: 0.5 },
            { note: 'F#3', duration: 0.5 },
        ];
        // 音符から周波数への変換テーブル
        this.noteFrequencies = {
            'C3': 130.81, 'C#3': 138.59, 'D3': 146.83, 'D#3': 155.56,
            'E3': 164.81, 'F3': 174.61, 'F#3': 185.00, 'G3': 196.00,
            'G#3': 207.65, 'A3': 220.00, 'A#3': 233.08, 'B3': 246.94,
            'C4': 261.63, 'C#4': 277.18, 'D4': 293.66, 'D#4': 311.13,
            'E4': 329.63, 'F4': 349.23, 'F#4': 369.99, 'G4': 392.00,
            'G#4': 415.30, 'A4': 440.00, 'A#4': 466.16, 'B4': 493.88,
            'C5': 523.25, 'C#5': 554.37, 'D5': 587.33, 'D#5': 622.25,
            'E5': 659.25, 'F5': 698.46, 'F#5': 739.99, 'G5': 783.99,
        };
        this.melodyIndex = 0;
    }
    playSound(type, chainIndex = 0) {
        if (!this.soundEnabled || !this.audioContext)
            return;
        const now = this.audioContext.currentTime;
        const oscillator = this.audioContext.createOscillator();
        const gainNode = this.audioContext.createGain();
        oscillator.connect(gainNode);
        gainNode.connect(this.audioContext.destination);
        switch (type) {
            case 'reveal': // セルを開く音（ユーザークリック）
                oscillator.frequency.setValueAtTime(800, now);
                oscillator.frequency.exponentialRampToValueAtTime(400, now + 0.1);
                gainNode.gain.setValueAtTime(0.1, now);
                gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.1);
                oscillator.start(now);
                oscillator.stop(now + 0.1);
                break;
            case 'chain': // 連鎖音（ピアノ風の音色でメロディーを奏でる）
                // メロディーの現在の音符を取得
                const currentNote = this.melodyNotes[this.melodyIndex];
                const frequency = this.noteFrequencies[currentNote.note];
                // ピアノ風の音色を作る（基音 + 倍音）
                // 基音
                const osc1 = this.audioContext.createOscillator();
                const gain1 = this.audioContext.createGain();
                osc1.connect(gain1);
                gain1.connect(this.audioContext.destination);
                osc1.type = 'triangle';
                osc1.frequency.setValueAtTime(frequency, now);
                // 2倍音（オクターブ上）
                const osc2 = this.audioContext.createOscillator();
                const gain2 = this.audioContext.createGain();
                osc2.connect(gain2);
                gain2.connect(this.audioContext.destination);
                osc2.type = 'sine';
                osc2.frequency.setValueAtTime(frequency * 2, now);
                // 3倍音
                const osc3 = this.audioContext.createOscillator();
                const gain3 = this.audioContext.createGain();
                osc3.connect(gain3);
                gain3.connect(this.audioContext.destination);
                osc3.type = 'sine';
                osc3.frequency.setValueAtTime(frequency * 3, now);
                // ピアノのアタック（素早く立ち上がってゆっくり減衰）
                const duration = 0.5;
                // 基音のエンベロープ
                gain1.gain.setValueAtTime(0, now);
                gain1.gain.linearRampToValueAtTime(0.3, now + 0.01);
                gain1.gain.exponentialRampToValueAtTime(0.001, now + duration);
                // 2倍音のエンベロープ（少し弱め）
                gain2.gain.setValueAtTime(0, now);
                gain2.gain.linearRampToValueAtTime(0.15, now + 0.01);
                gain2.gain.exponentialRampToValueAtTime(0.001, now + duration * 0.7);
                // 3倍音のエンベロープ（さらに弱め）
                gain3.gain.setValueAtTime(0, now);
                gain3.gain.linearRampToValueAtTime(0.08, now + 0.01);
                gain3.gain.exponentialRampToValueAtTime(0.001, now + duration * 0.5);
                osc1.start(now);
                osc1.stop(now + duration);
                osc2.start(now);
                osc2.stop(now + duration);
                osc3.start(now);
                osc3.stop(now + duration);
                // 次の音符へ進む
                this.melodyIndex = (this.melodyIndex + 1) % this.melodyNotes.length;
                return; // 複数のオシレーターを使うのでここで終了
            case 'flag': // 旗を立てる音
                oscillator.frequency.setValueAtTime(600, now);
                oscillator.frequency.setValueAtTime(900, now + 0.05);
                gainNode.gain.setValueAtTime(0.15, now);
                gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.1);
                oscillator.start(now);
                oscillator.stop(now + 0.1);
                break;
            case 'win': // クリア音（華やかなアルペジオ）
                const winNotes = [523, 659, 784, 1047, 1319, 1568];
                winNotes.forEach((freq, i) => {
                    const osc = this.audioContext.createOscillator();
                    const gain = this.audioContext.createGain();
                    osc.connect(gain);
                    gain.connect(this.audioContext.destination);
                    osc.frequency.setValueAtTime(freq, now + i * 0.08);
                    gain.gain.setValueAtTime(0.15, now + i * 0.08);
                    gain.gain.exponentialRampToValueAtTime(0.01, now + i * 0.08 + 0.5);
                    osc.start(now + i * 0.08);
                    osc.stop(now + i * 0.08 + 0.5);
                });
                return; // 複数のオシレーターを使うのでここで終了
            case 'lose': // 爆発音
                const noise = this.audioContext.createBufferSource();
                const buffer = this.audioContext.createBuffer(1, this.audioContext.sampleRate * 0.3, this.audioContext.sampleRate);
                const data = buffer.getChannelData(0);
                for (let i = 0; i < data.length; i++) {
                    data[i] = Math.random() * 2 - 1;
                }
                noise.buffer = buffer;
                const noiseGain = this.audioContext.createGain();
                noiseGain.gain.setValueAtTime(0.3, now);
                noiseGain.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
                noise.connect(noiseGain);
                noiseGain.connect(this.audioContext.destination);
                noise.start(now);
                break;
        }
    }
    setupEventListeners() {
        this.newGameBtn.addEventListener('click', () => {
            const width = parseInt(document.getElementById('width').value);
            const height = parseInt(document.getElementById('height').value);
            const mines = parseInt(document.getElementById('mines').value);
            this.newGame(width, height, mines);
        });
        // ウィンドウサイズ変更時に盤面を再描画
        let resizeTimeout;
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(() => {
                if (this.game) {
                    this.renderBoard();
                }
            }, 250);
        });
        // Preset buttons
        document.querySelectorAll('.preset-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const map = e.target.dataset.map;
                switch (map) {
                    case 'beginner':
                        this.newGame(9, 9, 10);
                        break;
                    case 'intermediate':
                        this.newGame(16, 16, 40);
                        break;
                    case 'expert':
                        this.newGame(30, 16, 99);
                        break;
                    case 'large':
                        this.newGame(50, 50, 400);
                        break;
                    case 'huge':
                        this.newGame(100, 100, 2000);
                        break;
                }
            });
        });
        // Speed control
        const speedSlider = document.getElementById('speedSlider');
        const speedInput = document.getElementById('speedInput');
        const fastestSpeedBtn = document.getElementById('fastestSpeedBtn');
        const fastSpeedBtn = document.getElementById('fastSpeedBtn');
        const standardSpeedBtn = document.getElementById('standardSpeedBtn');
        const setSpeed = (speed) => {
            speed = Math.max(0, Math.min(100, speed));
            if (speedSlider)
                speedSlider.value = speed;
            if (speedInput)
                speedInput.value = speed;
            if (this.game) {
                this.game.animationSpeed = speed;
                this.game.fastFrameStepCount = 0;
            }
        };
        // スライダーの変更を数値入力に反映
        if (speedSlider && speedInput) {
            speedSlider.addEventListener('input', (e) => {
                const speed = parseFloat(e.target.value);
                setSpeed(speed);
            });
            // 数値入力の変更をスライダーに反映
            speedInput.addEventListener('input', (e) => {
                let speed = parseFloat(e.target.value);
                // 範囲チェック
                if (speed < 0)
                    speed = 0;
                if (speed > 100)
                    speed = 100;
                setSpeed(speed);
            });
            // Enterキーで確定
            speedInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    speedInput.blur();
                }
            });
        }
        if (fastestSpeedBtn) {
            fastestSpeedBtn.addEventListener('click', () => setSpeed(0));
        }
        if (fastSpeedBtn) {
            fastSpeedBtn.addEventListener('click', () => setSpeed(1));
        }
        if (standardSpeedBtn) {
            standardSpeedBtn.addEventListener('click', () => setSpeed(100));
        }
    }
    newGame(width, height, mines) {
        // Validate inputs
        width = Math.max(5, Math.min(100, width));
        height = Math.max(5, Math.min(100, height));
        mines = Math.max(1, Math.min(width * height - 1, mines));
        document.getElementById('width').value = width;
        document.getElementById('height').value = height;
        document.getElementById('mines').value = mines;
        // 背景色をリセット
        document.body.className = '';
        this.game = new Minesweeper(width, height, mines);
        this.game.logCallback = (logs) => this.updateLog(logs);
        // スライダーの現在値を新しいゲームインスタンスに適用
        const speedSlider = document.getElementById('speedSlider');
        if (speedSlider) {
            this.game.animationSpeed = parseFloat(speedSlider.value);
        }
        this.renderBoard();
        this.lastDisplayedLogIndex = 0; // ログインデックスをリセット
        this.updateLog([]);
        // プログレスバーとコンボカウンターをリセット
        this.currentCombo = 0;
        this.maxCombo = 0;
        this.updateProgressBar();
        this.updateComboCounter();
    }
    updateLog(logs) {
        if (!this.logElement)
            return;
        // 最後に表示したログのインデックスを記録
        if (!this.lastDisplayedLogIndex) {
            this.lastDisplayedLogIndex = 0;
        }
        // 新しいログのみを追加
        for (let i = this.lastDisplayedLogIndex; i < logs.length; i++) {
            const log = logs[i];
            const logEntry = document.createElement('div');
            logEntry.className = `log-entry ${log.ruleType}`;
            const timestamp = document.createElement('span');
            timestamp.className = 'timestamp';
            timestamp.textContent = log.timestamp;
            logEntry.appendChild(timestamp);
            logEntry.appendChild(document.createTextNode(' ' + log.message));
            this.logElement.appendChild(logEntry);
        }
        // 表示したログのインデックスを更新
        this.lastDisplayedLogIndex = logs.length;
        // ログが50を超えた場合は最初の要素を削除
        while (this.logElement.children.length > 50) {
            this.logElement.removeChild(this.logElement.firstChild);
        }
        // Auto-scroll to bottom (throttle)
        if (!this.logScrollPending) {
            this.logScrollPending = true;
            requestAnimationFrame(() => {
                this.logElement.scrollTop = this.logElement.scrollHeight;
                this.logScrollPending = false;
            });
        }
    }
    renderBoard() {
        this.boardElement.innerHTML = '';
        // イベントリスナーの委任: 既存のリスナーを削除してから新しく設定
        if (this.boardClickHandler) {
            this.boardElement.removeEventListener('click', this.boardClickHandler);
        }
        if (this.boardContextMenuHandler) {
            this.boardElement.removeEventListener('contextmenu', this.boardContextMenuHandler);
        }
        // 画面サイズに基づいてセルサイズを計算
        const gameArea = document.querySelector('.game-area');
        const availableWidth = gameArea ? gameArea.clientWidth - 50 : window.innerWidth - 400;
        const availableHeight = window.innerHeight - 450;
        let cellSize = 30;
        const maxCellSizeByWidth = Math.floor(availableWidth / this.game.width);
        const maxCellSizeByHeight = Math.floor(availableHeight / this.game.height);
        cellSize = Math.min(30, maxCellSizeByWidth, maxCellSizeByHeight);
        cellSize = Math.max(15, cellSize);
        this.boardElement.style.gridTemplateColumns = `repeat(${this.game.width}, ${cellSize}px)`;
        this.boardElement.style.gridTemplateRows = `repeat(${this.game.height}, ${cellSize}px)`;
        this.boardElement.style.fontSize = `${Math.max(8, cellSize * 0.6)}px`;
        // DocumentFragmentを使用して一度に追加
        const fragment = document.createDocumentFragment();
        for (let i = 0; i < this.game.cells.length; i++) {
            const cellElement = document.createElement('div');
            cellElement.className = 'cell';
            cellElement.dataset.index = i;
            cellElement.style.width = `${cellSize}px`;
            cellElement.style.height = `${cellSize}px`;
            fragment.appendChild(cellElement);
        }
        this.boardElement.appendChild(fragment);
        this.cellElements = this.boardElement.children;
        // イベントリスナーの委任
        this.boardClickHandler = (e) => {
            const cell = e.target.closest('.cell');
            if (cell) {
                const index = parseInt(cell.dataset.index);
                this.handleCellClick(index);
            }
        };
        this.boardContextMenuHandler = (e) => {
            const cell = e.target.closest('.cell');
            if (cell) {
                e.preventDefault();
                const index = parseInt(cell.dataset.index);
                this.handleCellRightClick(index);
            }
        };
        this.boardElement.addEventListener('click', this.boardClickHandler);
        this.boardElement.addEventListener('contextmenu', this.boardContextMenuHandler);
        // 初期描画のため、全セルをdirtyとしてマーク
        for (let i = 0; i < this.game.cells.length; i++) {
            this.game.dirtySet.add(i);
        }
        this.updateBoard();
    }
    async handleCellClick(index) {
        if (this.game.gameState === 'won' || this.game.gameState === 'lost')
            return;
        if (this.game.isAnimating)
            return; // Prevent clicking during animation
        const cell = this.game.cells[index];
        if (cell.isFlagged)
            return;
        const coords = this.game.indexToCoords(index);
        this.game.addLog(`プレイヤーが ${coords} をクリック`, 'info');
        // トレイルエフェクトとサウンド
        const cellElement = this.boardElement.querySelector(`[data-index="${index}"]`);
        if (cellElement && !cell.hasMine) {
            this.createCellFlash(cellElement, 'reveal');
            this.playSound('reveal');
        }
        // 最初にクリックしたセルを記録
        this.lastRevealedCell = cellElement;
        this.game.revealCell(index);
        this.updateBoard();
        // 地雷を踏んだ場合
        if (this.game.gameState === 'lost') {
            if (cellElement) {
                this.createExplosionEffect(cellElement);
            }
            this.playSound('lose');
        }
        // 連鎖カウンターをリセット
        this.chainCounter = 0;
        // Apply automatic solving rules with animation
        if (this.game.gameState === 'playing') {
            this.game.isAnimating = true;
            await this.game.applySolvingRules(() => {
                this.updateBoard();
                this.updateProgressBar();
                this.updateComboCounter();
            }, (revealedIndices) => {
                if (this.game.animationSpeed <= 0) {
                    this.currentCombo += revealedIndices.length;
                    if (this.currentCombo > this.maxCombo) {
                        this.maxCombo = this.currentCombo;
                    }
                    return;
                }
                // 推論でセルが開かれた時のコールバック
                revealedIndices.forEach((idx) => {
                    const el = this.boardElement.querySelector(`[data-index="${idx}"]`);
                    if (el) {
                        // トレイル（線）を描画
                        if (this.lastRevealedCell) {
                            this.createTrail(this.lastRevealedCell, el);
                        }
                        this.createCellFlash(el, 'chain');
                        this.lastRevealedCell = el;
                    }
                    this.playSound('chain', this.chainCounter);
                    this.chainCounter++;
                    // コンボカウンターを更新
                    this.currentCombo++;
                    if (this.currentCombo > this.maxCombo) {
                        this.maxCombo = this.currentCombo;
                    }
                    this.updateComboCounter();
                });
            });
            this.game.isAnimating = false;
            // 連鎖が終了したらコンボをリセット
            if (this.currentCombo > 0) {
                setTimeout(() => {
                    this.currentCombo = 0;
                    this.updateComboCounter();
                }, 1000);
            }
            const won = this.game.checkWin();
            if (won) {
                this.playSound('win');
                this.createWinEffect();
            }
        }
        this.updateBoard();
        this.updateProgressBar();
        this.updateComboCounter();
    }
    handleCellRightClick(index) {
        this.game.flagCell(index);
        // 旗を立てた時のエフェクト
        const cellElement = this.boardElement.querySelector(`[data-index="${index}"]`);
        const cell = this.game.cells[index];
        if (cellElement && cell.isFlagged) {
            this.createCellFlash(cellElement, 'flag');
            this.playSound('flag');
        }
        this.updateBoard();
        this.updateProgressBar();
    }
    updateProgressBar() {
        if (!this.progressBar || !this.progressText)
            return;
        const totalCells = this.game.width * this.game.height;
        const revealedCount = this.game.clearCount;
        const mineCount = this.game.totalMines;
        const nonMineCells = totalCells - mineCount;
        const progress = (revealedCount / nonMineCells) * 100;
        this.progressBar.style.width = Math.min(100, progress) + '%';
        this.progressText.textContent = `${revealedCount} / ${nonMineCells} (${Math.floor(progress)}%)`;
    }
    updateComboCounter() {
        if (!this.comboCounter || !this.comboText)
            return;
        this.comboText.textContent = `${this.currentCombo}`;
        // コンボ数に応じて色を変更
        if (this.currentCombo === 0) {
            this.comboCounter.style.opacity = '0.5';
        }
        else if (this.currentCombo < 5) {
            this.comboCounter.style.opacity = '1';
            this.comboCounter.style.color = '#4caf50';
        }
        else if (this.currentCombo < 10) {
            this.comboCounter.style.opacity = '1';
            this.comboCounter.style.color = '#2196f3';
        }
        else if (this.currentCombo < 20) {
            this.comboCounter.style.opacity = '1';
            this.comboCounter.style.color = '#ff9800';
        }
        else {
            this.comboCounter.style.opacity = '1';
            this.comboCounter.style.color = '#f44336';
        }
        // 最大コンボを表示
        const maxComboElement = document.getElementById('maxCombo');
        if (maxComboElement) {
            maxComboElement.textContent = `最大: ${this.maxCombo}`;
        }
    }
    updateBoard() {
        const cells = this.cellElements || this.boardElement.children;
        // 変更があったセルのみ更新
        if (this.game.dirtySet.size > 0) {
            for (const index of this.game.dirtySet) {
                const cellElement = cells[index];
                if (!cellElement)
                    continue;
                const cell = this.game.cells[index];
                // 新しいクラス名とコンテンツを計算
                let newClassName = 'cell';
                let newContent = '';
                if (cell.isRevealed) {
                    newClassName = 'cell revealed';
                    if (cell.hasMine) {
                        newClassName += ' mine';
                        newContent = '*';
                    }
                    else if (cell.neighborMines > 0) {
                        newClassName += ` number-${cell.neighborMines}`;
                        newContent = cell.neighborMines.toString();
                    }
                }
                else if (cell.isFlagged) {
                    newClassName = 'cell flagged';
                    newContent = '!';
                }
                // クラス名が変わる場合のみ更新
                if (cellElement.className !== newClassName) {
                    cellElement.className = newClassName;
                }
                // テキストが変わる場合のみ更新
                if (cellElement.textContent !== newContent) {
                    cellElement.textContent = newContent;
                }
            }
            // dirtySetをクリア
            this.game.dirtySet.clear();
        }
    }
    createTrail(fromElement, toElement) {
        const fromRect = fromElement.getBoundingClientRect();
        const toRect = toElement.getBoundingClientRect();
        const fromX = fromRect.left + fromRect.width / 2;
        const fromY = fromRect.top + fromRect.height / 2;
        const toX = toRect.left + toRect.width / 2;
        const toY = toRect.top + toRect.height / 2;
        const distance = Math.sqrt(Math.pow(toX - fromX, 2) + Math.pow(toY - fromY, 2));
        const angle = Math.atan2(toY - fromY, toX - fromX) * 180 / Math.PI;
        const trail = document.createElement('div');
        trail.className = 'trail';
        trail.style.cssText = `
            position: fixed;
            left: ${fromX}px;
            top: ${fromY}px;
            width: 0px;
            height: 4px;
            background: linear-gradient(90deg,
                rgba(33, 150, 243, 0.9) 0%,
                rgba(66, 165, 245, 0.8) 50%,
                rgba(100, 181, 246, 0.7) 100%);
            transform-origin: left center;
            transform: rotate(${angle}deg);
            pointer-events: none;
            z-index: 999;
            box-shadow: 0 0 15px rgba(33, 150, 243, 0.8);
        `;
        document.body.appendChild(trail);
        this.animateTrail(trail, distance);
    }
    animateTrail(trail, targetWidth) {
        const startTime = performance.now();
        const duration = 0.3;
        const animate = (currentTime) => {
            const elapsed = (currentTime - startTime) / 1000;
            const progress = elapsed / duration;
            if (progress >= 1) {
                // フェードアウト開始
                this.fadeOutTrail(trail);
                return;
            }
            const width = targetWidth * progress;
            trail.style.width = width + 'px';
            requestAnimationFrame(animate);
        };
        requestAnimationFrame(animate);
    }
    fadeOutTrail(trail) {
        const startTime = performance.now();
        const duration = 0.4;
        const animate = (currentTime) => {
            const elapsed = (currentTime - startTime) / 1000;
            const progress = elapsed / duration;
            if (progress >= 1) {
                trail.remove();
                return;
            }
            trail.style.opacity = 1 - progress;
            requestAnimationFrame(animate);
        };
        requestAnimationFrame(animate);
    }
    createCellFlash(element, type) {
        let color, duration;
        switch (type) {
            case 'reveal':
                color = 'rgba(76, 175, 80, 0.5)';
                duration = 0.3;
                break;
            case 'chain':
                color = 'rgba(139, 195, 74, 0.6)';
                duration = 0.25;
                break;
            case 'flag':
                color = 'rgba(255, 152, 0, 0.7)';
                duration = 0.4;
                break;
            default:
                return;
        }
        const flash = document.createElement('div');
        const rect = element.getBoundingClientRect();
        flash.className = 'cell-flash';
        flash.style.cssText = `
            position: fixed;
            left: ${rect.left}px;
            top: ${rect.top}px;
            width: ${rect.width}px;
            height: ${rect.height}px;
            background: ${color};
            pointer-events: none;
            z-index: 1000;
            box-shadow: 0 0 15px ${color};
        `;
        document.body.appendChild(flash);
        this.animateCellFlash(flash, duration);
    }
    animateCellFlash(flash, duration) {
        const startTime = performance.now();
        const animate = (currentTime) => {
            const elapsed = (currentTime - startTime) / 1000;
            const progress = elapsed / duration;
            if (progress >= 1) {
                flash.remove();
                return;
            }
            flash.style.opacity = 1 - progress;
            requestAnimationFrame(animate);
        };
        requestAnimationFrame(animate);
    }
    createExplosionEffect(element) {
        const rect = element.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        // 爆発の波紋
        for (let i = 0; i < 3; i++) {
            setTimeout(() => {
                const wave = document.createElement('div');
                wave.style.cssText = `
                    position: fixed;
                    left: ${centerX}px;
                    top: ${centerY}px;
                    width: 0px;
                    height: 0px;
                    border-radius: 50%;
                    border: 4px solid rgba(244, 67, 54, ${0.8 - i * 0.2});
                    pointer-events: none;
                    z-index: 1000;
                    transform: translate(-50%, -50%);
                `;
                document.body.appendChild(wave);
                const startTime = performance.now();
                const animate = (currentTime) => {
                    const elapsed = (currentTime - startTime) / 1000;
                    const progress = elapsed / 0.6;
                    if (progress >= 1) {
                        wave.remove();
                        return;
                    }
                    const size = 150 * progress;
                    wave.style.width = size + 'px';
                    wave.style.height = size + 'px';
                    wave.style.opacity = 1 - progress;
                    requestAnimationFrame(animate);
                };
                requestAnimationFrame(animate);
            }, i * 100);
        }
    }
    createWinEffect() {
        // 画面全体に紙吹雪エフェクト
        for (let i = 0; i < 50; i++) {
            setTimeout(() => {
                const particle = document.createElement('div');
                const colors = ['#ffd700', '#ff69b4', '#00bfff', '#7fff00', '#ff1493'];
                const color = colors[Math.floor(Math.random() * colors.length)];
                particle.className = 'confetti';
                particle.style.cssText = `
                    position: fixed;
                    left: ${Math.random() * window.innerWidth}px;
                    top: -20px;
                    width: ${5 + Math.random() * 5}px;
                    height: ${10 + Math.random() * 10}px;
                    background: ${color};
                    pointer-events: none;
                    z-index: 1000;
                    transform: rotate(${Math.random() * 360}deg);
                `;
                document.body.appendChild(particle);
                const fallDuration = 3 + Math.random() * 2;
                const startTime = performance.now();
                const animate = (currentTime) => {
                    const elapsed = (currentTime - startTime) / 1000;
                    const progress = elapsed / fallDuration;
                    if (progress >= 1) {
                        particle.remove();
                        return;
                    }
                    const y = progress * window.innerHeight;
                    const x = parseFloat(particle.style.left) + Math.sin(elapsed * 3) * 50;
                    const rotation = (elapsed * 360) % 360;
                    particle.style.top = y + 'px';
                    particle.style.left = x + 'px';
                    particle.style.transform = `rotate(${rotation}deg)`;
                    particle.style.opacity = 1 - progress * 0.5;
                    requestAnimationFrame(animate);
                };
                requestAnimationFrame(animate);
            }, i * 50);
        }
    }
}
// Initialize game when page loads
document.addEventListener('DOMContentLoaded', () => {
    new GameUI();
});
