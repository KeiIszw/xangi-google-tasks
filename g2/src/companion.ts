// スマホ（Even アプリの companion 画面）側の UI。
//
// 接続設定（Bridge URL / token）の入力・保存と、G2 に出している内容のミラー表示を行う。
// タイトル編集などの細かい操作は Google Tasks の公式アプリで行う前提のため、ここには置かない。

import { clearConfig, getConfig, saveConfig, type EvenStorage } from './api'

export type Status = 'connecting' | 'ready' | 'recording' | 'busy' | 'error'

const STATUS_LABEL: Record<Status, string> = {
  connecting: 'CONNECTING',
  ready: 'READY',
  recording: '● REC',
  busy: 'WORKING',
  error: 'ERROR',
}

let statusEl: HTMLDivElement | null = null
let bodyEl: HTMLPreElement | null = null

/** companion 画面を描画し、設定フォームを結び付ける。保存・クリア後は再読込して反映する。 */
export function mountCompanion(storage: EvenStorage | null, buildLabel: string): void {
  const config = getConfig()
  const app = document.querySelector<HTMLDivElement>('#app')!
  app.innerHTML = `
    <main class="panel">
      <header>
        <h1>Google Tasks for G2 <span class="version">${buildLabel}</span></h1>
        <div id="status" class="status status-connecting">CONNECTING</div>
      </header>
      <form id="settings" class="settings">
        <label><span>Bridge URL</span>
          <input id="bridge-url" type="url" inputmode="url" autocomplete="url"
            placeholder="http://<host>:18888/api/devices/xangi-google-tasks" /></label>
        <label><span>Token</span>
          <input id="bridge-token" type="password" autocomplete="off" /></label>
        <div class="actions">
          <button type="submit">保存</button>
          <button type="button" id="clear" class="secondary">クリア</button>
        </div>
        <div id="summary" class="summary"></div>
      </form>
      <pre id="body" class="body" aria-live="polite"></pre>
      <footer>↕ 上下スクロール ／ ○ タップ ／ ◎ ダブルタップ ／ ○━ 長押し</footer>
    </main>`
  statusEl = app.querySelector('#status')
  bodyEl = app.querySelector('#body')
  const urlInput = app.querySelector<HTMLInputElement>('#bridge-url')!
  const tokenInput = app.querySelector<HTMLInputElement>('#bridge-token')!
  const summary = app.querySelector<HTMLDivElement>('#summary')!
  urlInput.value = config.bridgeUrl
  tokenInput.value = config.token
  summary.textContent = config.bridgeUrl ? `${config.bridgeUrl}${config.token ? ' / tokenあり' : ''}` : '未設定'

  app.querySelector<HTMLFormElement>('#settings')!.addEventListener('submit', async event => {
    event.preventDefault()
    await saveConfig({ bridgeUrl: urlInput.value, token: tokenInput.value }, storage)
    window.location.reload()
  })
  app.querySelector<HTMLButtonElement>('#clear')!.addEventListener('click', async () => {
    await clearConfig(storage)
    window.location.reload()
  })
  injectStyles()
}

export function setStatus(kind: Status, text?: string): void {
  if (!statusEl) return
  statusEl.className = `status status-${kind}`
  statusEl.textContent = text ?? STATUS_LABEL[kind]
}

/** G2 に出しているのと同じ本文を companion 画面に写す。 */
export function mirror(text: string): void {
  if (bodyEl) bodyEl.textContent = text
}

function injectStyles(): void {
  // 配色は xangi for G2 の companion 画面（Even の dark テーマ）にそろえる。
  const css = `
    :root { color-scheme: dark; }
    html, body { margin: 0; min-height: 100%; background: #232323; color: #E5E5E5;
      font: 16px/1.4 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      touch-action: manipulation; -webkit-text-size-adjust: 100%; overscroll-behavior: none; }
    .panel { display: flex; flex-direction: column; gap: 16px; max-width: 640px;
      margin: 0 auto; padding: 24px; box-sizing: border-box; }
    header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    h1 { font-size: 18px; margin: 0; }
    .version { color: #9B9B9B; font-size: 12px; font-weight: 500; }
    .status { font-size: 12px; padding: 4px 10px; border-radius: 999px; border: 1px solid #3E3E3E; }
    .status-ready { color: #3CFA44; border-color: #3CFA44; }
    .status-recording, .status-error { color: #FF453A; border-color: #FF453A; }
    .status-busy { color: #FFD60A; border-color: #FFD60A; }
    .settings { display: grid; gap: 10px; background: #2A2A2A; border: 1px solid #3E3E3E;
      border-radius: 8px; padding: 14px; }
    label { display: grid; gap: 6px; font-size: 12px; color: #CFCFCF; }
    input { box-sizing: border-box; width: 100%; border: 1px solid #4A4A4A; border-radius: 6px;
      padding: 10px 12px; background: #202020; color: #F5F5F5; font: inherit; }
    .actions { display: flex; gap: 8px; }
    button { min-height: 36px; border: 1px solid #3CFA44; border-radius: 6px; padding: 0 14px;
      background: #3CFA44; color: #111; font: inherit; font-weight: 600; }
    button.secondary { background: transparent; color: #DADADA; border-color: #555; }
    .summary { color: #8E8E8E; font-size: 12px; overflow-wrap: anywhere; }
    .body { margin: 0; background: #2E2E2E; border: 1px solid #3E3E3E; border-radius: 12px;
      padding: 16px; min-height: 200px; white-space: pre-wrap; word-break: break-word;
      font: 16px/1.5 ui-monospace, Menlo, monospace; }
    footer { font-size: 12px; color: #7B7B7B; text-align: center; }`
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
}
