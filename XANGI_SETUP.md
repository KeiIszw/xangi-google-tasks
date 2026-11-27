# セットアップ（xangi 向け）

## 前提

- xangi の device ingress が有効で、G2 を使うスマホから xangi の Web ポート（既定 18888）に Tailscale で届くこと
- `gog` が Tasks の権限付きで認証済みであること（`gog auth list` の services に `tasks`）
- 音声追加を使う場合は Groq の API キー
- 動作確認した xangi: 2026-11-27 時点の `local/patches`（device ingress 対応版）

## 1. サーバー設定

```sh
cp server/.env.example server/.env
chmod 600 server/.env
```

`server/.env` に次を設定します。

- `GTASKS_DEVICE_TOKEN`: G2 アプリ用の Bearer。`python3 -c "import secrets;print(secrets.token_urlsafe(32))"` で生成
- `GOG_ACCOUNT`, `GOG_KEYRING_PASSWORD`: gog の対象アカウントと file キーリングのパスワード
- `GOG_BIN`: gog が PATH にない場合のパス
- `GROQ_API_KEY`: 音声追加用

## 2. 拡張の登録と起動

```sh
xangi extension link ./xangi-extension.json
xangi extension start xangi-google-tasks
xangi extension doctor xangi-google-tasks
```

`doctor` の health で `ready: true`、`deviceTokenConfigured` / `gogFound` / `gogKeyringConfigured` / `sttConfigured` が true であることを確認します。

疎通確認:

```sh
curl -H "Authorization: Bearer $GTASKS_DEVICE_TOKEN" \
  http://<host>:18888/api/devices/xangi-google-tasks/lists
```

## 3. G2 アプリ（EHPK）

```sh
cd g2
npm ci
BRIDGE_URL=http://<host>:18888/api/devices/xangi-google-tasks BRIDGE_TOKEN=<token> \
  npm run pack:configured -- --output ./google-tasks-g2.ehpk
```

`app.json` の `package_id` は Even Hub 上で一意にする必要があります。EHPK には token が埋め込まれるため、他人に渡さないでください。

スマホの Even アプリでこのアプリを開くと、接続先 URL と token を変更できます。保存した値は EHPK の埋め込み値より優先されます。

## データと保存先

- タスクのデータは Google Tasks にだけあり、この拡張は保存しません
- 設定は `server/.env`（このリポジトリ内、git 管理外）
- 削除したタスクは Google Tasks のゴミ箱に入らず、元に戻せません
