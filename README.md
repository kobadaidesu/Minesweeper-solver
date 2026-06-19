# Semi-Automatic Minesweeper

TypeScriptブラウザ版 + RustネイティブGUI版(Rustは試しにAIにコードを書いてもらったものです) 

## 概要

マインスイーパーの盤面を論理推論で補助する、半自動プレイ向けの実装です。

プレイヤーがセルを開くと、確実に安全なセルや地雷だと判断できるセルを自動で処理します。ブラウザで遊べるTypeScript版と、デスクトップで動くRustネイティブGUI版を同梱しています。

## 特徴

- 4つの自動推論ルールで安全なセルや地雷セルを自動判定
- プレイヤーは推論が止まった場所で直感的にセルを選ぶだけ
- TypeScriptブラウザ版とRustネイティブGUI版を同梱
- 初級・中級・上級・大・超大のプリセット
- カスタムボードサイズ対応
- 推論速度調整と高速可視化

## 使い方

### ブラウザ版

1. 依存をインストール

```bash
npm install
```

2. TypeScriptからブラウザ用JavaScriptを生成

```bash
npm run build:web
```

3. `index.html`をブラウザで開く

型チェックのみ実行する場合:

```bash
npm run check:web
```

### RustネイティブGUI版

Rustツールチェーンをインストールした環境で以下を実行します。

```bash
cargo run
```

ロジックテストを実行する場合:

```bash
cargo test
```

## 操作方法

- 左クリック: セルを探索
- 右クリック: 旗を立てる/外す
- 新しいゲーム: 入力した幅・高さ・地雷数でリセット
- プリセットボタン: 定番サイズに切り替え
- 解答速度: 推論アニメーション速度を調整
- 最速: 高速可視化モード
- 高速: 1msステップ
- 標準: 100msステップ

## 自動推論ルール

### Rule 1: 基本的な開示

数字セルの周りの旗の数が、そのセルの数字と等しい場合、残りの未探索セルを自動的に開きます。

### Rule 2: 基本的なフラグ

数字セルの周りの「未探索セル + 旗」の数が、そのセルの数字と等しい場合、未探索セルすべてに旗を立てます。

### Rule 3: 高度な推論（開示）

2つの数字セルA、Bを比較し、A = B - (Bのみに隣接する未探索セル数) の場合、Aのみに隣接する未探索セルを開きます。

### Rule 4: 高度な推論（フラグ）

2つの数字セルA、Bを比較し、B = A - (Aのみに隣接する未探索セル数) の場合、Aのみに隣接する未探索セルに旗を立てます。

### Final Rule

残り未探索セル数が残り地雷数と一致した場合、残り未探索セルすべてに旗を立てます。

## ファイル構成

```text
.
├── Cargo.toml
├── Cargo.lock
├── package.json
├── package-lock.json
├── tsconfig.json
├── index.html
├── style.css
├── dist/
│   ├── minesweeper.js
│   └── minesweeper-worker.js
├── ts/
│   ├── minesweeper.ts
│   └── minesweeper-worker.ts
└── src/
    ├── game.rs
    └── main.rs
```

## TypeScript版

- `ts/`配下を編集し、`npm run build:web`で`dist/`へ生成します。
- `index.html`は`dist/minesweeper.js`を読み込みます。
- 解答速度`0ms`では50ステップごとに描画し、可視化を残しながら高速進行します。
- 高速時は重い演出を間引き、DOM更新をまとめてラグを抑えています。

## Rust版

- `src/game.rs`: ゲームロジック、推論ルール、単体テスト
- `src/main.rs`: `egui/eframe`ネイティブGUI
- Rust版では開示・旗・地雷に軽いライティング演出があります。
