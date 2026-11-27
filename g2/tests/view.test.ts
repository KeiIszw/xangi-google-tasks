// view.ts の表示組み立てのテスト。実行: npm test
import assert from 'node:assert/strict'
import test from 'node:test'
import { getTextWidth } from '@evenrealities/pretext'
import {
  LINE_WIDTH,
  clampBytes,
  VISIBLE_ROWS,
  dueLabel,
  dueOptions,
  fitWidth,
  formatDuePicker,
  formatMenu,
  formatTasks,
  initialDueIndex,
  taskRowText,
  windowStart,
} from '../src/view.ts'
import type { Task } from '../src/api.ts'

// 2026-11-27(金) を「今日」として固定する。
const TODAY = new Date(2026, 10, 27, 14, 0)

function task(overrides: Partial<Task> = {}): Task {
  return { id: 't', title: '牛乳を買う', status: 'needsAction', due: null, notes: '', parent: null, depth: 0, ...overrides }
}

test('due labels are relative to today and mark overdue', () => {
  assert.equal(dueLabel(null, TODAY), '')
  assert.equal(dueLabel('2026-11-27', TODAY), '今日')
  assert.equal(dueLabel('2026-11-28', TODAY), '明日')
  assert.equal(dueLabel('2026-11-25', TODAY), '!11/25')
  assert.equal(dueLabel('2026-12-03', TODAY), '12/3')
})

test('long titles are truncated but keep the due label on the line', () => {
  const row = taskRowText(task({ title: 'とても長いタスク名'.repeat(10), due: '2026-11-28' }), TODAY)
  assert.ok(row.endsWith(' 明日'))
  assert.ok(row.includes('…'))
  assert.ok(getTextWidth(`>${row}`) <= LINE_WIDTH)
})

test('fitWidth leaves short text untouched', () => {
  assert.equal(fitWidth('short', LINE_WIDTH), 'short')
})

test('selection window keeps the cursor visible', () => {
  for (let index = 0; index < 20; index++) {
    const start = windowStart(index, 20)
    assert.ok(index >= start && index < start + VISIBLE_ROWS)
  }
  assert.equal(windowStart(3, 5), 0)
})

test('task screen fits in 10 lines and shows the completed toggle row', () => {
  const tasks = Array.from({ length: 15 }, (_, i) => task({ id: String(i), title: `タスク${i}` }))
  const text = formatTasks('Tasks', tasks, 15, false, '14:00', TODAY)
  const lines = text.split('\n')
  assert.equal(lines.length, 10)
  assert.ok(lines.some(line => line.startsWith('>-- 完了済みを表示')))
  assert.ok(lines[0].includes('15件'))
  assert.equal(lines[9], '↕選択 ○操作 ◎戻る ○━音声追加')
})

test('empty list still offers the completed toggle', () => {
  const text = formatTasks('Shopping', [], 0, false, '14:00', TODAY)
  assert.match(text, /タスクはありません/)
  assert.match(text, />-- 完了済みを表示 --/)
})

test('menu reflects completion state', () => {
  assert.match(formatMenu(task(), 0, '14:00', TODAY), />完了にする/)
  assert.match(formatMenu(task({ status: 'completed' }), 0, '14:00', TODAY), />未完了に戻す/)
  assert.match(formatMenu(task({ due: '2026-11-20' }), 0, '14:00', TODAY), /期限切れ/)
})

test('due picker starts at the current due date or today', () => {
  const options = dueOptions(TODAY)
  assert.equal(options[0].value, null)
  assert.equal(options[1].value, '2026-11-27')
  assert.match(options[1].label, /^今日 11\/27\(金\)/)
  assert.equal(options.length, 32)
  assert.equal(options[initialDueIndex(options, '2026-11-30')].value, '2026-11-30')
  assert.equal(initialDueIndex(options, null), 1)
  assert.equal(initialDueIndex(options, '2027-05-01'), 1)
  // 最後の選択肢でもカーソル行が表示に残る。
  const picker = formatDuePicker(task(), options, options.length - 1, '14:00')
  assert.ok(picker.split('\n').some(line => line.startsWith('>')))
  assert.ok(picker.split('\n').length <= 10)
})

test('text is clamped to the text container byte limit', () => {
  const long = 'あ'.repeat(500)
  const clamped = clampBytes(long)
  assert.ok(new TextEncoder().encode(clamped).length <= 999)
  assert.ok(clamped.endsWith('…'))
  assert.equal(clampBytes('short'), 'short')
})

test('completed tasks do not show the overdue mark', () => {
  assert.ok(taskRowText(task({ status: 'completed', due: '2026-11-25' }), TODAY).endsWith(' 11/25'))
})

test('legend symbols exist in the G2 firmware fonts', async () => {
  const { getAdvW } = await import('@evenrealities/pretext')
  const { GESTURE } = await import('../src/view.ts')
  for (const symbol of Object.values(GESTURE)) {
    for (const ch of symbol) assert.ok(getAdvW(ch.codePointAt(0)!) > 0, `${ch} has no glyph`)
  }
})
