// G2 に表示するテキストを組み立てる純粋関数群。
//
// main.ts（SDK・イベント処理）から呼ばれる。DOM や SDK に依存しないため
// node --test で検証できる（tests/view.test.ts）。
// G2 の表示は 576x288px・1 行 27px（@evenrealities/pretext の値）なので、
// 余白 4px を除いて 10 行 = 見出し 1 行 + 項目 8 行 + 操作ヒント 1 行で組む。

import { getTextWidth } from '@evenrealities/pretext'
import type { Task, TaskList } from './api'

export const DISPLAY_WIDTH = 576
const CONTAINER_PADDING = 4
export const LINE_WIDTH = DISPLAY_WIDTH - CONTAINER_PADDING * 2
export const VISIBLE_ROWS = 8
// 操作の凡例に使う記号。G2 のファームウェアフォントに字形があるものだけを選ぶ
// （@evenrealities/pretext の getAdvW が 0 を返す ☑ ✓ ⏎ ⇅ などは表示できない）。
// ◎ は「2 回」、○━ は「押し続ける」を形で表す。塗りつぶしの ● は G2 上で
// 点灯面積が大きく眩しいため、輪郭だけの ○ を使う。
export const GESTURE = {
  scroll: '↕',
  tap: '○',
  doubleTap: '◎',
  hold: '○━',
} as const

/** 「記号+動作」を並べた凡例行を作る。例: legend([['tap', '開く'], ['doubleTap', '戻る']]) */
export function legend(items: Array<[keyof typeof GESTURE, string]>): string {
  return items.map(([gesture, label]) => `${GESTURE[gesture]}${label}`).join(' ')
}

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土']
// 期日の選択肢に出す日数（今日から 30 日後まで）。それ以上先はスマホで設定する想定。
export const DUE_PICKER_DAYS = 30

// テキストコンテナに送れる本文の上限（UTF-8 バイト）。evenhub-simulator v0.7.1 の
// changelog「add text container bytes limit to 999」でファームウェアに合わせたとされる値。
export const TEXT_CONTAINER_MAX_BYTES = 999

/**
 * 本文を TEXT_CONTAINER_MAX_BYTES 以内に収める。超える場合は文字単位で切って "…" を付ける。
 * 日本語は 1 文字 3 バイトなので、長い音声入力の確認画面などで上限を超えうる。
 */
export function clampBytes(text: string, maxBytes = TEXT_CONTAINER_MAX_BYTES): string {
  const encoder = new TextEncoder()
  if (encoder.encode(text).length <= maxBytes) return text
  const ellipsisBytes = encoder.encode('…').length
  let used = 0
  let out = ''
  for (const ch of text) {
    const size = encoder.encode(ch).length
    if (used + size + ellipsisBytes > maxBytes) break
    out += ch
    used += size
  }
  return `${out}…`
}

/** ローカル時刻（G2 を使う端末のタイムゾーン）の日付を "YYYY-MM-DD" で返す。 */
export function dateKey(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  next.setDate(next.getDate() + days)
  return next
}

/** "YYYY-MM-DD" を "11/28(土)" にする。 */
export function shortDate(key: string): string {
  const [y, m, d] = key.split('-').map(Number)
  const weekday = WEEKDAYS[new Date(y, m - 1, d).getDay()]
  return `${m}/${d}(${weekday})`
}

/**
 * 一覧用の短い期日表示。期限切れは先頭に "!" を付けて目立たせる。
 * @returns 期日なしは空文字。例: "今日" / "明日" / "!11/25" / "11/30"
 */
export function dueLabel(due: string | null, today: Date): string {
  if (!due) return ''
  const todayKey = dateKey(today)
  if (due === todayKey) return '今日'
  if (due === dateKey(addDays(today, 1))) return '明日'
  const [, m, d] = due.split('-').map(Number)
  // "YYYY-MM-DD" は辞書順比較で日付順になる。
  return `${due < todayKey ? '!' : ''}${m}/${d}`
}

/** 表示幅 maxWidth(px) に収まるよう末尾を "…" で切る。 */
export function fitWidth(text: string, maxWidth: number): string {
  if (getTextWidth(text) <= maxWidth) return text
  const chars = Array.from(text)
  let low = 0
  let high = chars.length
  // 収まる最長の文字数を二分探索する（1 行ずつ getTextWidth を呼ぶと長文で遅いため）。
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (getTextWidth(`${chars.slice(0, mid).join('')}…`) <= maxWidth) low = mid
    else high = mid - 1
  }
  return `${chars.slice(0, low).join('')}…`
}

/** 選択位置が見える 8 行分の開始位置を返す（選択行をなるべく上から 3 行目に置く）。 */
export function windowStart(index: number, total: number, rows = VISIBLE_ROWS): number {
  return Math.max(0, Math.min(index - 2, total - rows))
}

function header(clock: string, title: string, position: string): string {
  return fitWidth(`${clock} ${title}${position ? ` ${position}` : ''}`, LINE_WIDTH)
}

function rows(items: string[], index: number, count = VISIBLE_ROWS): string[] {
  const start = windowStart(index, items.length, count)
  return items.slice(start, start + count).map((item, offset) => {
    const marker = start + offset === index ? '>' : ' '
    return fitWidth(`${marker}${item}`, LINE_WIDTH)
  })
}

/** リスト一覧画面。 */
export function formatLists(lists: TaskList[], index: number, clock: string): string {
  if (!lists.length) return `${header(clock, 'Google Tasks', '')}\nリストがありません\n\n${legend([['tap', '再読込'], ['doubleTap', '終了']])}`
  return [
    header(clock, 'Google Tasks', `${index + 1}/${lists.length}`),
    ...rows(lists.map(list => list.title || '(無題)'), index),
    legend([['scroll', '選択'], ['tap', '開く'], ['doubleTap', '終了']]),
  ].join('\n')
}

/**
 * タスク一覧画面の行（タスク + 末尾の完了済み切替行）を作る。
 * 末尾行は「完了済みを表示/隠す」で、tasksRowCount() の最後の index に当たる。
 */
export function taskRowText(task: Task, today: Date): string {
  const check = task.status === 'completed' ? '[x]' : '[ ]'
  const indent = task.depth > 0 ? '  ' : ''
  // 完了済みの期限切れは対応不要なので "!" を外す。
  const due = task.status === 'completed' ? dueLabel(task.due, today).replace(/^!/, '') : dueLabel(task.due, today)
  // 期日を行末に必ず残すため、タイトル側だけを切り詰める。
  const dueWidth = due ? getTextWidth(` ${due}`) : 0
  const title = fitWidth(task.title || '(無題)', LINE_WIDTH - getTextWidth(`>${check} ${indent}`) - dueWidth)
  return `${check} ${indent}${title}${due ? ` ${due}` : ''}`
}

export function tasksRowCount(tasks: Task[]): number {
  return tasks.length + 1
}

export function formatTasks(
  listTitle: string,
  tasks: Task[],
  index: number,
  showCompleted: boolean,
  clock: string,
  today: Date,
): string {
  const openCount = tasks.filter(task => task.status !== 'completed').length
  const items = [
    ...tasks.map(task => taskRowText(task, today)),
    showCompleted ? '-- 完了済みを隠す --' : '-- 完了済みを表示 --',
  ]
  const body = tasks.length ? rows(items, index) : ['タスクはありません', ...rows(items.slice(-1), index - tasks.length)]
  return [
    header(clock, listTitle || '(無題)', `${openCount}件`),
    ...body,
    legend([['scroll', '選択'], ['tap', '操作'], ['doubleTap', '戻る'], ['hold', '音声追加']]),
  ].join('\n')
}

export type MenuAction = 'toggle' | 'due' | 'delete' | 'back'

export function menuActions(): MenuAction[] {
  return ['toggle', 'due', 'delete', 'back']
}

/** タスク操作メニュー。上部にタスク名・期日・メモの冒頭を出す。 */
export function formatMenu(task: Task, index: number, clock: string, today: Date): string {
  const labels: Record<MenuAction, string> = {
    toggle: task.status === 'completed' ? '未完了に戻す' : '完了にする',
    due: '期日を変更',
    delete: '削除',
    back: '戻る',
  }
  const due = task.due ? `期日 ${shortDate(task.due)}${dueLabel(task.due, today).startsWith('!') ? ' 期限切れ' : ''}` : '期日なし'
  const notes = task.notes ? fitWidth(task.notes.replace(/\s+/g, ' '), LINE_WIDTH) : ''
  return [
    header(clock, '操作', ''),
    fitWidth(task.title || '(無題)', LINE_WIDTH),
    due,
    ...(notes ? [notes] : []),
    ...rows(menuActions().map(action => labels[action]), index),
    legend([['scroll', '選択'], ['tap', '実行'], ['doubleTap', '戻る']]),
  ].join('\n')
}

export interface DueOption {
  label: string
  /** "YYYY-MM-DD"。null は期日なし。 */
  value: string | null
}

/** 期日の選択肢（期日なし、今日〜DUE_PICKER_DAYS 日後）。 */
export function dueOptions(today: Date): DueOption[] {
  const options: DueOption[] = [{ label: '期日なし', value: null }]
  for (let offset = 0; offset <= DUE_PICKER_DAYS; offset++) {
    const key = dateKey(addDays(today, offset))
    const prefix = offset === 0 ? '今日 ' : offset === 1 ? '明日 ' : ''
    options.push({ label: `${prefix}${shortDate(key)}`, value: key })
  }
  return options
}

/** 期日ピッカーの初期位置。現在の期日が範囲内ならそこ、範囲外・未設定なら「今日」。 */
export function initialDueIndex(options: DueOption[], current: string | null): number {
  const found = options.findIndex(option => option.value === current)
  if (current && found >= 0) return found
  return 1
}

export function formatDuePicker(task: Task, options: DueOption[], index: number, clock: string): string {
  return [
    header(clock, '期日', ''),
    fitWidth(task.title || '(無題)', LINE_WIDTH),
    // タイトル行を出す分、選択肢は 7 行にする。
    ...rows(options.map(option => option.label), index, VISIBLE_ROWS - 1),
    legend([['scroll', '選択'], ['tap', '決定'], ['doubleTap', 'キャンセル']]),
  ].join('\n')
}

export function formatConfirmDelete(task: Task, clock: string): string {
  return [
    header(clock, '削除の確認', ''),
    fitWidth(task.title || '(無題)', LINE_WIDTH),
    '',
    'このタスクを削除しますか？',
    '削除すると元に戻せません。',
    '',
    legend([['tap', '削除'], ['doubleTap', 'キャンセル']]),
  ].join('\n')
}

export function formatConfirmAdd(listTitle: string, text: string, clock: string): string {
  return [
    header(clock, `追加先: ${listTitle}`, ''),
    '',
    text,
    '',
    legend([['tap', '追加'], ['doubleTap', '破棄']]),
  ].join('\n')
}

/** 長押し録音中の表示。frame でドットを動かし、録音中であることを示す。 */
export function formatRecording(listTitle: string, frame: number, clock: string): string {
  return [header(clock, `追加先: ${listTitle}`, ''), '', `Listening ${'.'.repeat((frame % 3) + 1)}`, '', '指を離すと確認へ'].join('\n')
}
