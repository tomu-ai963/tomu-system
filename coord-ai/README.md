# Coord AI

手持ちの服・小物の写真をアップロードし、シチュエーションを指定するとAIがコーディネートをアドバイスするWebアプリ。  
とむSYSTEM Standard プラン以上で利用可能。

## ファイル構成

```
coord-ai/
├── index.html          # フロントエンド（HTML/CSS/JS 完結）
├── worker-addition.js  # Cloudflare Worker 追加コード
└── README.md           # このファイル
```

---

## GitHub Pages へのデプロイ

```bash
git add coord-ai/index.html
git commit -m "feat: add Coord AI"
git push origin main
```

公開URL: `https://tomu-ai963.github.io/tomu-system/coord-ai/`

---

## Worker へのマージ手順

### 1. 既存 Worker コードを取得

ローカルの `src/index.js`（または wrangler.toml で指定した main ファイル）を確認する。

### 2. コードをマージ

Worker の fetch ハンドラ内（他のルート分岐と同じ場所）に追加：

```javascript
// ルーティング追加（既存の if ブロックと同列に）
if (url.pathname === '/coord-ai') return handleCoordAI(request, env);
```

さらにファイル末尾に `worker-addition.js` の内容（`handleCoordAI` 関数と `COORD_AI_CORS_HEADERS`）をコピー。

### 3. wrangler でデプロイ

```bash
wrangler deploy
```

※ `wrangler.toml` に `name = "orange-sound-354b"` が設定されていること

---

## 動作確認

### Worker エンドポイントの確認

```bash
curl -s -X POST \
  -H "Content-Type: application/json" \
  -d '{
    "images": [{"category":"tops","data":"<base64>","mediaType":"image/jpeg"}],
    "situation": "友人とランチ",
    "season": "春",
    "weather": "晴れ"
  }' \
  https://orange-sound-354b.inverted-triangle-leef.workers.dev/coord-ai
```

正常なら `{"advice": "..."}` が返る。

### フロントエンドの確認

1. `https://tomu-ai963.github.io/tomu-system/coord-ai/` を開く
2. Standard 以上のプランのアカウントでログイン
3. 服の写真を1枚以上アップロード
4. シチュエーションを選択または入力
5. 「コーディネートを相談する」をタップ → アドバイスが表示されれば成功

---

## API 仕様

**エンドポイント:** `POST /coord-ai`

**リクエスト:**
```json
{
  "images": [
    {
      "category": "tops",
      "data": "<base64（プレフィックスなし）>",
      "mediaType": "image/jpeg"
    }
  ],
  "situation": "デート（ちょっとおしゃれ）",
  "season": "春",
  "weather": "晴れ"
}
```

**レスポンス:**
```json
{
  "advice": "マークダウン形式のアドバイステキスト"
}
```
