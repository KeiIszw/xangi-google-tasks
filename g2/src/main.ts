// Google Tasks for G2 のエントリポイント。
//
// Even アプリの WebView で動き、G2 のテキストコンテナ 1 枚に画面を描画する。
// リング操作（上下スクロール・タップ・ダブルタップ・長押し）を画面ごとの操作に割り当て、
// xangi-google-tasks bridge（api.ts）経由で Google Tasks を読み書きする。
//
// 画面遷移:
//   lists ──タップ──> tasks ──タップ──> menu ──> due / confirmDelete
//                      └─長押し──> recording ──離す──> confirmAdd
//   ダブルタップで 1 つ前の画面へ戻る（lists ではアプリ終了）。
//
// Even アプリのメニューから companion 画面として開かれた時（launchSource が appMenu）は
// G2 には描画せず、スマホ側の設定フォームだけを出す。

import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'
import * as api from './api'
import type { Task, TaskList } from './api'
import { mirror, mountCompanion, setStatus } from './companion'
import {
  clampBytes,
  dueOptions,
  formatConfirmAdd,
  formatConfirmDelete,
  formatDuePicker,
  formatLists,
  formatMenu,
  formatRecording,
  formatTasks,
  initialDueIndex,
  legend,
  menuActions,
  tasksRowCount,
  type DueOption,
} from './view'

const BUILD_LABEL = 'v0.1.2'
// 操作が無い時に G2 の表示を消すまでの時間。常時表示は視界の邪魔になり電池も減るため。
const AUTO_HIDE_MS = 30_000
// 長押し録音中のドットアニメーション間隔。
const LISTENING_ANIMATION_MS = 400
// ダブルタップ直後やスクロール直後に届く単発タップ／ダブルタップを誤操作として捨てる時間。
// xangi for G2 の実機調整値（GESTURE_COLLISION_GUARD_MS）に合わせた。
const GESTURE_GUARD_MS = 700
// 描画要求をまとめる間隔。連続スクロールで textContainerUpgrade を詰まらせないため。
const RENDER_DEBOUNCE_MS = 120

type Screen = 'lists' | 'tasks' | 'menu' | 'due' | 'confirmDelete' | 'recording' | 'confirmAdd' | 'busy' | 'message'

const bridge = await waitForEvenAppBridge()
const launchSource = await waitForLaunchSource(bridge)
await api.hydrateConfig(bridge)
mountCompanion(bridge, BUILD_LABEL)

/** 起動元（G2 の app 一覧か、スマホのメニューか）を待つ。来なければ 'unknown'。 */
function waitForLaunchSource(
  source: { onLaunchSource(callback: (value: string) => void): () => void },
  timeoutMs = 800,
): Promise<string> {
  return new Promise(resolve => {
    let done = false
    const unsubscribe = source.onLaunchSource(value => {
      if (done) return
      done = true
      unsubscribe()
      resolve(value)
    })
    window.setTimeout(() => {
      if (done) return
      done = true
      unsubscribe()
      resolve('unknown')
    }, timeoutMs)
  })
}

if (launchSource === 'appMenu') {
  setStatus('ready', 'SETTINGS')
  mirror(api.configured() ? '設定済みです。変更する場合は上のフォームで保存してください。' : 'Bridge URL と Token を入力して保存してください。')
} else {
  await runGlassesApp()
}

async function runGlassesApp(): Promise<void> {
  // ---- 状態 -------------------------------------------------------------------
  let screen: Screen = 'busy'
  let lists: TaskList[] = []
  let listIndex = 0
  let currentList: TaskList | null = null
  let tasks: Task[] = []
  let taskIndex = 0
  let showCompleted = false
  let menuIndex = 0
  let dueChoices: DueOption[] = []
  let dueIndex = 0
  let pendingText = ''
  let messageText = ''
  let messageReturn: () => void = () => void showLists()
  let pcmChunks: Uint8Array[] = []
  let pcmLength = 0
  let audioStart: Promise<unknown> | null = null
  let animationFrame = 0
  let animationTimer: number | null = null
  let ignoreClickUntil = 0
  let lastScrollAt = 0

  // ---- 描画 -------------------------------------------------------------------
  const initial = api.configured() ? '読込中…' : 'Bridge URL 未設定\nスマホの Even アプリでこのアプリを開き、\n接続先を保存してください。'
  const created = await bridge.createStartUpPageContainer(
    new CreateStartUpPageContainer({
      containerTotalNum: 1,
      textObject: [
        new TextContainerProperty({
          xPosition: 0,
          yPosition: 0,
          width: 576,
          height: 288,
          borderWidth: 0,
          borderColor: 5,
          paddingLength: 4,
          containerID: 1,
          containerName: 'main',
          content: initial,
          isEventCapture: 1,
        }),
      ],
    }),
  )
  if (created !== 0) setStatus('error', `createStartUpPageContainer failed: ${created}`)

  let lastRendered = initial
  let pending = initial
  let renderTimer: number | null = null
  let displayVisible = true
  let hideTimer: number | null = null

  function flush(): void {
    if (renderTimer !== null) return
    renderTimer = window.setTimeout(async () => {
      renderTimer = null
      const content = displayVisible ? pending : ' '
      if (content === lastRendered) return
      lastRendered = content
      await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: 1, containerName: 'main', content }))
    }, RENDER_DEBOUNCE_MS)
  }

  function show(text: string): void {
    pending = clampBytes(text)
    mirror(text)
    displayVisible = true
    flush()
    scheduleAutoHide()
  }

  /** 操作待ちの画面でだけ自動消灯する。録音中・通信中は消さない。 */
  function scheduleAutoHide(): void {
    if (hideTimer !== null) window.clearTimeout(hideTimer)
    if (screen === 'recording' || screen === 'busy') return
    hideTimer = window.setTimeout(() => {
      displayVisible = false
      flush()
    }, AUTO_HIDE_MS)
  }

  /** 消灯中なら点灯して true を返す。点灯のための操作は画面操作として扱わない。 */
  function wake(): boolean {
    if (displayVisible) return false
    displayVisible = true
    flush()
    scheduleAutoHide()
    return true
  }

  function clock(): string {
    return new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })
  }

  function renderScreen(): void {
    const now = new Date()
    if (screen === 'lists') show(formatLists(lists, listIndex, clock()))
    else if (screen === 'tasks') show(formatTasks(currentList?.title ?? '', tasks, taskIndex, showCompleted, clock(), now))
    else if (screen === 'menu' && selectedTask()) show(formatMenu(selectedTask()!, menuIndex, clock(), now))
    else if (screen === 'due' && selectedTask()) show(formatDuePicker(selectedTask()!, dueChoices, dueIndex, clock()))
    else if (screen === 'confirmDelete' && selectedTask()) show(formatConfirmDelete(selectedTask()!, clock()))
    else if (screen === 'confirmAdd') show(formatConfirmAdd(currentList?.title ?? '', pendingText, clock()))
    else if (screen === 'recording') show(formatRecording(currentList?.title ?? '', animationFrame, clock()))
    else if (screen === 'message') show(`${messageText}\n\n${legend([['tap', '戻る']])}`)
  }

  // 時計表示を更新する（消灯中は flush が空白を描くだけ）。
  window.setInterval(() => {
    if (screen !== 'busy' && displayVisible) renderScreen()
  }, 30_000)

  function busy(text: string): void {
    screen = 'busy'
    setStatus('busy')
    show(text)
  }

  function fail(error: unknown, back: () => void): void {
    screen = 'message'
    setStatus('error')
    messageText = `エラー: ${(error as Error)?.message ?? error}`
    messageReturn = back
    renderScreen()
  }

  function selectedTask(): Task | null {
    return taskIndex < tasks.length ? tasks[taskIndex] : null
  }

  // ---- 画面遷移 ---------------------------------------------------------------
  async function showLists(): Promise<void> {
    busy('リスト読込中…')
    try {
      lists = await api.fetchLists()
      listIndex = Math.min(listIndex, Math.max(0, lists.length - 1))
      screen = 'lists'
      setStatus('ready')
      renderScreen()
    } catch (error) {
      fail(error, () => void showLists())
    }
  }

  /**
   * 現在のリストのタスクを読み直して一覧を出す。
   * @param keepTaskId 読み直し後に選択を合わせたいタスク ID（操作後に位置を保つため）。
   */
  async function showTasks(keepTaskId: string | null = null): Promise<void> {
    if (!currentList) return void showLists()
    busy(`${currentList.title} 読込中…`)
    try {
      tasks = await api.fetchTasks(currentList.id, showCompleted)
      const kept = keepTaskId ? tasks.findIndex(task => task.id === keepTaskId) : -1
      taskIndex = kept >= 0 ? kept : Math.min(taskIndex, tasksRowCount(tasks) - 1)
      screen = 'tasks'
      setStatus('ready')
      renderScreen()
    } catch (error) {
      fail(error, () => void showTasks(keepTaskId))
    }
  }

  /**
   * 更新系の操作を実行し、終わったら一覧を読み直す。
   * @param action 文字列（タスク ID）を返した場合は、その ID を keepTaskId より優先して選択する。
   */
  async function mutate(label: string, action: () => Promise<unknown>, keepTaskId: string | null): Promise<void> {
    busy(label)
    try {
      const result = await action()
      await showTasks(typeof result === 'string' ? result : keepTaskId)
    } catch (error) {
      fail(error, () => void showTasks(keepTaskId))
    }
  }

  // ---- 録音（長押し中だけ） -------------------------------------------------------
  function startRecording(): void {
    if (screen !== 'tasks' || !currentList) return
    pcmChunks = []
    pcmLength = 0
    screen = 'recording'
    setStatus('recording')
    animationFrame = 0
    renderScreen()
    animationTimer = window.setInterval(() => {
      animationFrame++
      renderScreen()
    }, LISTENING_ANIMATION_MS)
    audioStart = bridge.audioControl(true)
  }

  async function finishRecording(): Promise<void> {
    if (screen !== 'recording') return
    if (animationTimer !== null) window.clearInterval(animationTimer)
    animationTimer = null
    busy('聞き取り中…')
    // 開始要求が終わる前に停止すると G2 側でマイクが開いたまま残ることがあるため、開始の完了を待つ。
    if (audioStart) await audioStart.catch(() => undefined)
    audioStart = null
    await bridge.audioControl(false)
    const pcm = new Uint8Array(pcmLength)
    let offset = 0
    for (const chunk of pcmChunks) {
      pcm.set(chunk, offset)
      offset += chunk.length
    }
    pcmChunks = []
    pcmLength = 0
    try {
      const text = await api.transcribe(pcm)
      if (!text) {
        screen = 'message'
        setStatus('ready')
        messageText = 'うまく聞き取れませんでした。\nもう一度長押しで話してください。'
        messageReturn = () => void showTasks()
        renderScreen()
        return
      }
      pendingText = text
      screen = 'confirmAdd'
      setStatus('ready')
      renderScreen()
    } catch (error) {
      fail(error, () => void showTasks())
    }
  }

  // ---- 操作の割り当て -------------------------------------------------------------
  function moveSelection(delta: number): void {
    const wrap = (value: number, count: number) => (count ? (value + delta + count) % count : 0)
    if (screen === 'lists') listIndex = wrap(listIndex, lists.length)
    else if (screen === 'tasks') taskIndex = wrap(taskIndex, tasksRowCount(tasks))
    else if (screen === 'menu') menuIndex = wrap(menuIndex, menuActions().length)
    // 期日は端で止める（「期日なし」と 30 日後が隣り合うと誤選択しやすいため）。
    else if (screen === 'due') dueIndex = Math.max(0, Math.min(dueChoices.length - 1, dueIndex + delta))
    else return
    renderScreen()
  }

  function onTap(): void {
    if (screen === 'lists') {
      if (!lists.length) return void showLists()
      currentList = lists[listIndex]
      taskIndex = 0
      void showTasks()
    } else if (screen === 'tasks') {
      if (taskIndex >= tasks.length) {
        showCompleted = !showCompleted
        // 表示件数が大きく変わるため、選択は先頭に戻す。
        taskIndex = 0
        void showTasks()
        return
      }
      menuIndex = 0
      screen = 'menu'
      renderScreen()
    } else if (screen === 'menu') {
      onMenuAction()
    } else if (screen === 'due') {
      const task = selectedTask()
      if (!task || !currentList) return
      const listId = currentList.id
      const due = dueChoices[dueIndex]?.value ?? null
      void mutate('期日を変更中…', () => api.setDue(listId, task.id, due), task.id)
    } else if (screen === 'confirmDelete') {
      const task = selectedTask()
      if (!task || !currentList) return
      const listId = currentList.id
      void mutate('削除中…', () => api.deleteTask(listId, task.id), null)
    } else if (screen === 'confirmAdd') {
      if (!currentList) return
      const listId = currentList.id
      const title = pendingText
      pendingText = ''
      // 追加したタスクの ID を返し、一覧に戻った時にそのタスクを選択状態にする。
      void mutate('追加中…', async () => (await api.addTask(listId, title)).id, null)
    } else if (screen === 'message') {
      messageReturn()
    }
  }

  function onMenuAction(): void {
    const task = selectedTask()
    if (!task || !currentList) return
    const listId = currentList.id
    const action = menuActions()[menuIndex]
    if (action === 'toggle') {
      const completed = task.status !== 'completed'
      void mutate(completed ? '完了にしています…' : '未完了に戻しています…', () => api.setCompleted(listId, task.id, completed), task.id)
    } else if (action === 'due') {
      dueChoices = dueOptions(new Date())
      dueIndex = initialDueIndex(dueChoices, task.due)
      screen = 'due'
      renderScreen()
    } else if (action === 'delete') {
      screen = 'confirmDelete'
      renderScreen()
    } else {
      screen = 'tasks'
      renderScreen()
    }
  }

  function onDoubleTap(): void {
    if (screen === 'lists') {
      bridge.shutDownPageContainer(1)
    } else if (screen === 'tasks') {
      screen = 'lists'
      renderScreen()
    } else if (screen === 'menu' || screen === 'confirmAdd') {
      pendingText = ''
      screen = 'tasks'
      renderScreen()
    } else if (screen === 'due' || screen === 'confirmDelete') {
      screen = 'menu'
      renderScreen()
    } else if (screen === 'message') {
      messageReturn()
    }
  }

  // ---- イベント振り分け -------------------------------------------------------------
  /** SDK のイベント種別を数値で返す。種別が省略されたイベントは CLICK（値 0）として届く。 */
  function eventType(envelope: { eventType?: OsEventTypeList | string | number } | undefined): number {
    if (!envelope) return -1
    return OsEventTypeList.fromJson(envelope.eventType ?? OsEventTypeList.CLICK_EVENT) ?? -1
  }

  const unsubscribe = bridge.onEvenHubEvent(event => {
    const pcm = event.audioEvent?.audioPcm
    if (pcm && pcm.length) {
      if (screen === 'recording') {
        pcmChunks.push(pcm)
        pcmLength += pcm.length
      }
      return
    }
    const types = [eventType(event.sysEvent), eventType(event.textEvent), eventType(event.listEvent)]
    const is = (type: OsEventTypeList) => types.includes(type)

    if (is(OsEventTypeList.SYSTEM_EXIT_EVENT) || is(OsEventTypeList.ABNORMAL_EXIT_EVENT)) {
      cleanup()
      return
    }
    // 長押しの離しは消灯中でも必ず処理する（録音を止め損ねないため）。
    if (is(OsEventTypeList.LONG_PRESS_RELEASE_EVENT)) {
      void finishRecording()
      return
    }
    if (is(OsEventTypeList.LONG_PRESS_EVENT)) {
      if (wake() && screen !== 'tasks') return
      startRecording()
      return
    }
    if (is(OsEventTypeList.SCROLL_TOP_EVENT) || is(OsEventTypeList.SCROLL_BOTTOM_EVENT)) {
      lastScrollAt = Date.now()
      if (wake()) return
      moveSelection(is(OsEventTypeList.SCROLL_TOP_EVENT) ? -1 : 1)
      return
    }
    if (is(OsEventTypeList.DOUBLE_CLICK_EVENT)) {
      const now = Date.now()
      ignoreClickUntil = now + GESTURE_GUARD_MS
      if (wake()) return
      // スクロール操作の直後に誤って届いたダブルタップで画面を戻さない。
      if (now - lastScrollAt < GESTURE_GUARD_MS) return
      onDoubleTap()
      return
    }
    if (is(OsEventTypeList.CLICK_EVENT)) {
      if (Date.now() < ignoreClickUntil) return
      if (wake()) return
      if (screen === 'busy' || screen === 'recording') return
      onTap()
    }
  })

  let cleanedUp = false
  function cleanup(): void {
    if (cleanedUp) return
    cleanedUp = true
    if (animationTimer !== null) window.clearInterval(animationTimer)
    if (hideTimer !== null) window.clearTimeout(hideTimer)
    void bridge.audioControl(false)
    unsubscribe()
  }
  window.addEventListener('beforeunload', cleanup)

  // ---- 起動 -------------------------------------------------------------------
  if (api.configured()) {
    await bridge.audioControl(false)
    await showLists()
  } else {
    setStatus('error', 'Bridge URL 未設定')
    screen = 'message'
    messageText = initial
    messageReturn = () => window.location.reload()
  }
}
