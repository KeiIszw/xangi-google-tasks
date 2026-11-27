# xangi-google-tasks

[English](README.en.md)

Even Realities G2 で Google Tasks を閲覧・操作するためのアプリと、その接続先になる xangi Managed Extension です。

## できること（G2）

- タスクリストの一覧とタスク一覧の閲覧（期日、期限切れの `!`、子タスクの字下げを表示）
- タスクの完了／未完了の切り替え
- 期日の変更（期日なし、今日〜30日後）。期日は日付だけを扱います（Google Tasks API が時刻を保持しないため）
- タスクの削除（確認画面あり）
- リングの長押し中に話してタスクを追加（指を離すと確認画面）
- 完了済み（直近30日）の表示切り替え

タイトルやメモの編集は Google Tasks の公式アプリで行う想定です。

## 操作

- 上下スクロール: 選択
- タップ: 開く／決定
- ダブルタップ: 戻る（リスト一覧ではアプリ終了）
- 長押し（タスク一覧で）: 音声でタスクを追加

## 構成

```
G2 アプリ (g2/) ──HTTP──> xangi :18888 /api/devices/xangi-google-tasks/*
                               └─> server/runtime.py /device/*
                                      ├─ gog CLI ──> Google Tasks API
                                      └─ Groq Whisper（音声追加の文字起こし）
```

Google の OAuth トークンは xangi を動かすマシンの gog キーリングに置いたままにし、G2 やスマホには渡しません。

セットアップは [XANGI_SETUP.md](XANGI_SETUP.md) を参照してください。

## 開発

```sh
cd server && python3 -m unittest -v        # サーバーの単体テスト
cd g2 && npm ci && npm test && npm run build
```

`evenhub-simulator --automation-port 9898 http://localhost:5173` で、上下・タップ・ダブルタップの操作と画面キャプチャを自動化できます（長押しは未対応）。
