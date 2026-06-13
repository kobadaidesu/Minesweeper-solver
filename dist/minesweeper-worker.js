// @ts-nocheck
/**
 * Minesweeper Web Worker
 * Solves the board using deduction rules only (no mine truth access).
 */
class MinesweeperSolver {
    constructor(width, height, cells, neighborsCache, extendedNeighborsCache) {
        this.width = width;
        this.height = height;
        this.cells = cells;
        this.neighborsCache = neighborsCache;
        this.extendedNeighborsCache = extendedNeighborsCache;
    }
    indexToCoords(index) {
        const x = index % this.width;
        const y = Math.floor(index / this.width);
        return `(${x},${y})`;
    }
    revealCell(index) {
        const cell = this.cells[index];
        if (cell.isRevealed || cell.isFlagged)
            return false;
        cell.isRevealed = true;
        // Auto-reveal neighbors if no nearby mines
        if (cell.neighborMines === 0) {
            const queue = [index];
            let queueIndex = 0;
            const processed = new Set([index]);
            while (queueIndex < queue.length) {
                const currentIndex = queue[queueIndex++];
                const neighbors = this.neighborsCache[currentIndex];
                for (let i = 0; i < neighbors.length; i++) {
                    const n = neighbors[i];
                    if (processed.has(n))
                        continue;
                    const neighbor = this.cells[n];
                    if (neighbor.isRevealed || neighbor.isFlagged || neighbor.hasMine)
                        continue;
                    neighbor.isRevealed = true;
                    processed.add(n);
                    if (neighbor.neighborMines === 0) {
                        queue.push(n);
                    }
                }
            }
        }
        return true;
    }
    getNeighborInfo(index) {
        const neighbors = this.neighborsCache[index];
        const flaggedNeighbors = [];
        const unrevealedNeighbors = [];
        for (let i = 0; i < neighbors.length; i++) {
            const n = neighbors[i];
            const neighbor = this.cells[n];
            if (neighbor.isFlagged) {
                flaggedNeighbors.push(n);
            }
            else if (!neighbor.isRevealed) {
                unrevealedNeighbors.push(n);
            }
        }
        return { flaggedNeighbors, unrevealedNeighbors };
    }
    applyRule1(index, neighborInfo, steps) {
        const cell = this.cells[index];
        const { flaggedNeighbors, unrevealedNeighbors } = neighborInfo;
        if (cell.neighborMines !== flaggedNeighbors.length || unrevealedNeighbors.length === 0)
            return false;
        const coords = this.indexToCoords(index);
        const targetCoords = unrevealedNeighbors.map(n => this.indexToCoords(n)).join(', ');
        let didChange = false;
        for (const n of unrevealedNeighbors) {
            if (this.revealCell(n)) {
                didChange = true;
            }
        }
        if (didChange) {
            steps.push({
                type: 'reveal',
                cells: unrevealedNeighbors,
                log: `Rule 1: ${coords} -> reveal safe neighbors: ${targetCoords}`,
                ruleType: 'rule-1'
            });
        }
        return didChange;
    }
    applyRule2(index, neighborInfo, steps) {
        const cell = this.cells[index];
        const { flaggedNeighbors, unrevealedNeighbors } = neighborInfo;
        if (cell.neighborMines !== flaggedNeighbors.length + unrevealedNeighbors.length || unrevealedNeighbors.length === 0) {
            return false;
        }
        const coords = this.indexToCoords(index);
        const targetCoords = unrevealedNeighbors.map(n => this.indexToCoords(n)).join(', ');
        let didChange = false;
        for (const n of unrevealedNeighbors) {
            this.cells[n].isFlagged = true;
            didChange = true;
        }
        if (didChange) {
            steps.push({
                type: 'flag',
                cells: unrevealedNeighbors,
                log: `Rule 2: ${coords} -> flag all remaining: ${targetCoords}`,
                ruleType: 'rule-2'
            });
        }
        return didChange;
    }
    isRevealedNumber(index) {
        const cell = this.cells[index];
        return cell.isRevealed && cell.neighborMines > 0;
    }
    tryAdvancedRules(index) {
        const extendedNeighbors = this.extendedNeighborsCache[index];
        for (let k = 0; k < extendedNeighbors.length; k++) {
            const j = extendedNeighbors[k];
            if (!this.isRevealedNumber(j))
                continue;
            const result = this.applyAdvancedRules(index, j);
            if (result) {
                return result;
            }
        }
        return null;
    }
    applySolvingRules() {
        let changed = true;
        let iterations = 0;
        const maxIterations = 1000;
        const steps = [];
        while (changed && iterations < maxIterations) {
            changed = false;
            iterations++;
            for (let i = 0; i < this.cells.length; i++) {
                const cell = this.cells[i];
                if (!cell.isRevealed || cell.neighborMines === 0)
                    continue;
                const neighborInfo = this.getNeighborInfo(i);
                if (this.applyRule1(i, neighborInfo, steps)) {
                    changed = true;
                }
                if (this.applyRule2(i, neighborInfo, steps)) {
                    changed = true;
                }
                // Rules 3 & 4: subset/overlap deduction using extended neighbors.
                if (changed)
                    continue;
                const advancedResult = this.tryAdvancedRules(i);
                if (advancedResult) {
                    steps.push(advancedResult);
                    changed = true;
                }
            }
        }
        // Final rule
        const finalRuleResult = this.applyFinalRule();
        if (finalRuleResult) {
            steps.push(finalRuleResult);
        }
        return { cells: this.cells, steps };
    }
    applyAdvancedRules(indexA, indexB) {
        const cellA = this.cells[indexA];
        const cellB = this.cells[indexB];
        const neighborsA = this.neighborsCache[indexA];
        const neighborsB = this.neighborsCache[indexB];
        const neighborsBSet = new Set(neighborsB);
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
            return null;
        const remainingA = cellA.neighborMines - flaggedA.length;
        const remainingB = cellB.neighborMines - flaggedBCount;
        // Rule 3
        if (uniqueToA.length > 0 && remainingA === remainingB - uniqueToB.length) {
            const coordsA = this.indexToCoords(indexA);
            const coordsB = this.indexToCoords(indexB);
            const targetCoords = uniqueToA.map(n => this.indexToCoords(n)).join(', ');
            for (const n of uniqueToA) {
                this.revealCell(n);
            }
            return {
                type: 'reveal',
                cells: uniqueToA,
                log: `Rule 3: ${coordsA} vs ${coordsB} -> reveal: ${targetCoords}`,
                ruleType: 'rule-3'
            };
        }
        // Rule 4
        if (uniqueToA.length > 0 && remainingB === remainingA - uniqueToA.length) {
            const coordsA = this.indexToCoords(indexA);
            const coordsB = this.indexToCoords(indexB);
            const targetCoords = uniqueToA.map(n => this.indexToCoords(n)).join(', ');
            for (const n of uniqueToA) {
                this.cells[n].isFlagged = true;
            }
            return {
                type: 'flag',
                cells: uniqueToA,
                log: `Rule 4: ${coordsA} vs ${coordsB} -> flag: ${targetCoords}`,
                ruleType: 'rule-4'
            };
        }
        return null;
    }
    applyFinalRule() {
        const unrevealedIndices = [];
        let flaggedCount = 0;
        for (let i = 0; i < this.cells.length; i++) {
            const cell = this.cells[i];
            if (cell.isFlagged) {
                flaggedCount++;
            }
            else if (!cell.isRevealed) {
                unrevealedIndices.push(i);
            }
        }
        if (!Number.isFinite(this.totalMines))
            return null;
        const remainingMines = this.totalMines - flaggedCount;
        if (unrevealedIndices.length === remainingMines && remainingMines > 0) {
            const targetCoords = unrevealedIndices.map(n => this.indexToCoords(n)).join(', ');
            for (const n of unrevealedIndices) {
                this.cells[n].isFlagged = true;
            }
            return {
                type: 'flag',
                cells: unrevealedIndices,
                log: `Final rule: all remaining cells are mines -> flag: ${targetCoords}`,
                ruleType: 'rule-4'
            };
        }
        return null;
    }
}
// Worker message handler
self.onmessage = function (e) {
    const { width, height, cells, neighborsCache, extendedNeighborsCache, totalMines } = e.data;
    const solver = new MinesweeperSolver(width, height, cells, neighborsCache, extendedNeighborsCache);
    solver.totalMines = totalMines; // Required for final rule.
    const result = solver.applySolvingRules();
    self.postMessage(result);
};
