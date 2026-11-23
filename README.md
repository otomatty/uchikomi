# UCHIKOMI

**寿司打の出題を、あなた専用の練習帳に。**

高級10,000円コース・正確重視の個人練習に向けた、非公式のChrome拡張です。目標は2026年12月25日、30,000円。設定から変更できます。

## インストール

### GitHub Actions のビルドを使う

1. このリポジトリの **Actions → 成功した CI → `uchikomi-extension`** から ZIP をダウンロードし、展開します。
2. Chrome で `chrome://extensions` を開き、「デベロッパーモード」をオンにします。
3. 「パッケージ化されていない拡張機能を読み込む」で、展開した **`manifest.json` のあるフォルダー** を選択します。
4. Chrome の拡張機能メニューから UCHIKOMI をピン留めします。

### ソースからビルドする

```bash
git clone --branch codex/automatic-ocr-training https://github.com/otomatty/uchikomi.git
cd uchikomi
npm ci
npm run build
```

上の Chrome の手順で **`dist`** フォルダーを選択します。PR の変更を試す場合は、ビルド前に対象のブランチへ切り替えてください。API キーは不要です。Chrome 116 以上を対象としています。

## 最初の1回

1. UCHIKOMI で **「寿司打を開く」** を押します。
2. 寿司打で拡張アイコンを押し、サイドパネルの **「記録をはじめる」** を押します。
3. ふりがな・日本語・ローマ字を表示した状態でゲームを始めます。**お題枠と3行を自動検出**するため、ドラッグで範囲を選ぶ必要はありません。
4. プレイ後に **「記録を終了」**。結果画面のスコアを入力します。
5. 「要確認」の語句があれば直し、**「10語を復習」** へ進みます。

ウィンドウサイズやページ内の表示位置が変わった場合も、自動で検出し直します。メニューなど、お題枠がない間は次のお題を待ちます。

## 使い方

- **今日**：記録の開始・停止、目標までの距離、集中して練習する組み合わせ。
- **キーワード**：実際に収集した語句の一覧、検索、`kk`・`sy`などの絞り込み、読み取りの修正。
- **復習**：対象の組み合わせを含む確認済み語句だけを出題。短い手持ちリストは、同じ語句を繰り返します。Spaceで開始、Escで一時停止。画面を離れたときも一時停止します。
- **成長**：自己ベスト、直近5回の中央値、スコア推移、文字の組み合わせごとの入力間隔の変化。
- **設定**：目標・スコア基準・1セットの語数、JSONバックアップの書き出しと復元。

スコアは「お得になった金額」を初期設定にしています。「食べた金額の合計」とは別々に集計します。開始時の18,000円は目安として表示され、実測の記録としては保存されません。

## 読み取りについて

タブの画面から、寿司打の白い角丸枠と暗い背景を検出し、その中の **上段のふりがな・中央の日本語・下段のローマ字** を読み取ります。画面全体に対する固定座標には依存しません。ページの余白やヘッダーを含むスクリーンショットでも、実際のお題枠の位置から範囲を求めます。ゲームの内部変数は取得しません。

OCR の起動直後、極端に小さい文字、隠れたお題、短すぎる出題は取りこぼす場合があります。見つからない場合は、お題全体と3行が見える状態にしてください。通常の自動検出で対応できない場合に限り、手動調整を使えます。不確かな語句は「要確認」に回し、読みとローマ字の整合性や入力区間が確認できないデータを苦手ランキングに含めません。

**公式の寿司打本番画面での一連の操作は未検証です。** 提供された2枚の画面画像による自動範囲検出・OCRの検証と、実際の Chrome での画面共有・打鍵との対応付けの検証は別です。確認できた範囲と結果は `VALIDATION.md` に記載しています。初回は短いプレイで、記録された語句と実際の出題が一致することを確認してください。

ゲーム中の正誤はローカルのローマ字照合による推定です。スコアは結果画面から入力します。復習画面の計測は拡張自身の出題と照合します。複数のローマ字入力に対応していますが、寿司打の全入力方式との完全一致は未検証です。

## データと権限

- 保存先は、このChromeプロファイルの端末内です。アカウント、サーバー、AI APIは使いません。
- 日本語／英語OCR、モデル、UIコードはすべて同梱。認識のための外部送信はありません。
- 記録開始後の寿司打タブだけを画面取得します。音声は取得しません。
- 打鍵は記録中にゲームcanvasへフォーカスがあるときだけ観測し、終了時に一時バッファを破棄します。ほかのサイトや入力欄は対象外です。
- 保存する画像は、お題とふりがな・ローマ字の領域です。検出用の画面全体はメモリ上で処理し、永続保存しません。
- 権限は `activeTab`、`tabCapture`、`offscreen`、`sidePanel`、`storage`、`scripting` と寿司打のHTTPSホストに限定しています。
- 拡張を削除すると記録も失われます。必要に応じて「設定 → 書き出す」でバックアップしてください。
- 個人用の非公式補助ツールです。寿司打の名称・ゲーム・出題内容は各権利者に帰属します。公式の利用条件の確認先は https://sushida.net/ です。

## 開発

リポジトリ直下で実行します。Actions からビルド済み拡張を使う場合、この手順は不要です。

```bash
npm ci
npm run build
npm test
npm run test:ocr
npm run test:auto-ocr
```

Node.js 22.12 以上を推奨します。`npm run build` が `dist` に読み込み可能な拡張を生成します。Bunを使う場合は `bun install`、`bun run build` でも同じスクリプトを実行できます。再現ビルドには同梱のpackage-lock.jsonと `npm ci` を使用してください。

- UI：React / TypeScript
- ビルド：Vite / esbuild
- 画面取得：Chrome Manifest V3 / tabCapture / Offscreen Document
- 文字認識：Tesseract.js 7、同梱の日本語・英語LSTMモデル
- 記録：IndexedDB、画面間更新にBroadcastChannel

`npm run dev` でUI開発サーバーを起動できます。通常のWebページではChrome拡張の画面記録機能を利用できません。`preview.html` は画面を確認するための単体HTMLで、データは実際の拡張とは別に保存されます。

### テストの範囲

ローマ字照合、入力ミスと時間の集計、苦手分析、出題選択、データ保存・編集・復元、自動範囲検出、入力イベント、および同梱モデルの独立した OCR フィクスチャを検証しています。詳しい結果は `VALIDATION.md` を参照してください。

`node tests/browser-check.mjs` は、通常のChromiumを起動できる環境で実行する拡張結合テストです。ローカルの独立したテスト画面を使い、公式サイト上での記録を確認するテストではありません。納品環境ではChromium起動が制限されているため、ブラウザの結合テストは未完了です。


### 手元のスクリーンショットを検証する

PNG 画像を指定すると、実装と同じ範囲検出・前処理・同梱モデルで3行を読み取れます。

```bash
npm run test:auto-ocr -- /path/to/screenshot.png
```

期待する文字列や拡大率を指定する場合は、次の JSON を用意して `npm run test:auto-ocr -- --cases /path/to/cases.json` で実行します。画像の相対パスは JSON ファイルの場所を基準に解決します。

```json
[
  {
    "file": "screenshot.png",
    "expected": {
      "reading": "ぺあるっく",
      "japanese": "ペアルック",
      "roman": "pearukku"
    },
    "scales": [1, 0.75, 1.25]
  }
]
```

引数なしの `test:auto-ocr` は独自の文字画像から合成したテスト画面を使用します。外部画像はアップロードされず、リポジトリにもコピーしません。結果は Git 管理対象外の `qa/auto-ocr-report.json` に保存します。実ゲームの画像・出題一覧は同梱しません。

## 参考となる公式文書

- Chrome tabCapture：https://developer.chrome.com/docs/extensions/reference/api/tabCapture
- Chromeの画面取得：https://developer.chrome.com/docs/extensions/how-to/web-platform/screen-capture
- Chrome Side Panel：https://developer.chrome.com/docs/extensions/reference/api/sidePanel
- Chrome Offscreen：https://developer.chrome.com/docs/extensions/reference/api/offscreen
- Tesseract.js：https://github.com/naptha/tesseract.js
