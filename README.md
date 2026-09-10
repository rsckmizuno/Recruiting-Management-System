# 派遣募集ボード（テスト環境版）

取引先がログインして募集を登録し、弊社営業が全社の募集を横断して確認・スキルシート提出・やりとりできるシステムです。

- サーバー: Node.js + Express
- DB: SQLite（ファイル1つ。`data/haken.db`）
- 認証: ログインID / パスワード（scryptハッシュ）＋ Cookieセッション（12時間）
- リアルタイム: SSE（登録・提案・メッセージが即時に相手画面へ反映）
- フロント: 単一HTML（ビルド不要）

## 起動方法

```bash
npm install
npm start          # http://localhost:3000
```

初回起動時にサンプルデータが自動投入されます。

| ログインID | パスワード | 所属 |
|---|---|---|
| sales01 | pass | 弊社 営業（全取引先を閲覧・提案・管理） |
| sakura | pass | さくら総合病院（取引先） |
| himawari | pass | ひまわり介護センター（取引先） |
| midori | pass | みどりクリニック（取引先） |

サンプルの初期パスワードは環境変数 `SEED_PASSWORD` で変更できます（初回起動前に設定）。

```bash
npm run reset      # 全データ削除→サンプル再投入
npm run dev        # ファイル変更で自動再起動
```

Docker の場合:

```bash
docker build -t haken-board .
docker run -p 3000:3000 -v $(pwd)/data:/app/data haken-board
```

## 権限

| 操作 | 弊社（agency） | 取引先（client） |
|---|---|---|
| 募集の閲覧 | 全社（取引先で絞り込み可） | 自社のみ |
| 募集の登録・編集・終了 | 終了/再開のみ | 自社分のみ |
| スキルシート提出（提案） | ○ | × |
| 提案の採用/見送り判断 | × | 自社の募集のみ |
| メッセージ | ○ | 自社の募集のみ |
| 取引先・アカウント・スタッフ管理 | ○ | × |

取引先が他社の募集IDを直接指定しても 404 を返します（存在自体を伏せる）。

## 画面

- **募集一覧**: 急募・募集中/終了・提案確認待ち・新着メッセージをバッジ表示。職種・状態・キーワードで絞り込み。
- **募集詳細**: 募集条件、提案されたスキルシート、メッセージスレッド。
- **取引先・スタッフ管理**（弊社のみ）: 取引先の追加とログインID発行、派遣スタッフ（スキルシート）の登録。
- **アカウント**: パスワード変更。

## API 一覧

```
POST /api/login {login_id,password}     POST /api/logout     GET /api/me
POST /api/me/password {current,next}
GET  /api/events                         SSE（リアルタイム通知）

GET  /api/jobs[?client_id=]              募集一覧（権限で自動スコープ）
GET  /api/jobs/:id                       募集詳細＋提案＋メッセージ
POST /api/jobs                           募集登録（取引先）
PATCH /api/jobs/:id                      編集・終了/再開
POST /api/jobs/:id/proposals {staff_id,comment}   スキルシート提出（弊社）
PATCH /api/proposals/:id {status}        accepted / declined / reviewing（取引先）
POST /api/jobs/:id/messages {body}       メッセージ送信

GET/POST /api/clients                    取引先一覧・追加（アカウント同時発行）（弊社）
POST /api/clients/:id/users              取引先アカウント追加（弊社）
POST /api/users/:id/reset-password       パスワード再設定（弊社）
GET/POST /api/staff, PATCH /api/staff/:id  スタッフ管理（弊社）
GET  /api/health
```

## テスト環境で公開する際の注意

- HTTPS で公開する場合は `COOKIE_SECURE=1` を設定してください。
- 逆プロキシ（nginx 等）を使う場合、`/api/events` はバッファリングを無効にしてください（nginx: `proxy_buffering off;`）。
- `data/` ディレクトリをバックアップ対象にしてください（DB本体）。
- ログイン失敗は IP＋ID ごとに10回で15分ロックされます。

## 本番化に向けて未対応の項目

- スキルシートのファイル添付（PDF等）
- メール／LINE通知
- 募集の編集画面（APIは対応済み、UIは未実装）
- 監査ログ、CSV出力
- SQLite → PostgreSQL 等への移行（アクセスが増える場合）
