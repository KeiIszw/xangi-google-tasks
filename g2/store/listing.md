# Even Hub 掲載文（Google Tasks for G2）

アプリ名（app.json `name`、20文字以内・"Even" を含めない）: Google Tasks for G2

## キャッチコピー

- ja: Google Tasks をリング操作と声で
- en: Your Google Tasks, on your glasses

## 説明（ja）

Google Tasks のタスクを G2 で確認・操作できるアプリです。

- リストとタスクを一覧表示。期日（今日・明日・日付）と期限切れを一目で確認
- タップでタスクを完了／未完了に切り替え
- 期日を「期日なし」または今日〜30日後から変更
- リングを長押ししながら話すと、その場でタスクを追加（確認画面つき）
- 完了済みタスク（直近30日）の表示切り替え

操作（画面下の記号）: ↕ 上下スクロールで選択、○ タップで決定、◎ ダブルタップで戻る、○━ 長押しで音声追加。

※ 利用には、Google Tasks に接続する自分用のブリッジサーバー（xangi-google-tasks）が必要です。Google のアカウント情報はブリッジ側にだけ保存され、アプリやスマホには保存されません。

## Description (en)

View and manage your Google Tasks on G2.

- Browse task lists and tasks with due dates (today, tomorrow, dates) and overdue markers
- Tap to mark tasks completed or not completed
- Set the due date to none or any day within the next 30 days
- Hold the ring and speak to add a task, with a confirmation step
- Show or hide tasks completed in the last 30 days

Controls: scroll to select, tap to confirm, double tap to go back, long press to add by voice.

Requires your own bridge server (xangi-google-tasks) connected to Google Tasks. Google credentials stay on the bridge and are never stored in the app or on your phone.

## 権限の説明（app.json と同じ内容）

- g2-microphone: G2 microphone audio is used to add a task by voice while the ring is held.
- network: The app connects to your xangi-google-tasks bridge to read and edit Google Tasks.

## リリースノート v0.1.2

- ja: 操作記号のタップ・長押しを白丸（○）に変更。
- en: Tap and hold hints now use a hollow circle.

## リリースノート v0.1.1

- ja: 操作の凡例を記号表示に変更し、件数表示を「N件」に変更。
- en: Gesture hints now use symbols; task counts are shown as "N items".

## リリースノート v0.1.0

- ja: 初版。タスクの閲覧、完了切り替え、期日変更、削除、音声での追加に対応。
- en: First release. View tasks, toggle completion, change due dates, delete, and add tasks by voice.
