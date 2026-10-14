// 推論を別スレッドで走らせるための入口。中身は solver.ts(メインスレッドと共通)。
// 盤面のコピーを受け取り、確定した手の列と、止まったときの地雷確率を返す。

importScripts('solver.js');

self.onmessage = function (e) {
    const { width, height, cells, neighborsCache, totalMines } = e.data;
    const solver = new MinesweeperSolver(width, height, cells, neighborsCache, totalMines);
    self.postMessage(solver.solve());
};
