// xangi-google-tasks bridge のクライアントと接続設定の保存。
//
// 接続先は xangi の device ingress（例: http://<host>:18888/api/devices/xangi-google-tasks）。
// URL と token は companion（スマホ）画面で入力し、WebView の localStorage と
// Even アプリのストレージ（EvenAppBridge.setLocalStorage）の両方に保存する。
// WebView の localStorage は Even アプリ再起動で消えることがあるため、起動時に
// hydrateConfig で Even ストレージから書き戻す（xangi-even-g2 と同じ方式）。
// ビルド時の VITE_BRIDGE_URL / VITE_BRIDGE_TOKEN は保存値がない時の初期値になる。

const STORAGE_KEY = 'xangi-gtasks-g2-config-v1'
// 1 リクエストの待ち上限（ミリ秒）。サーバー側の gog タイムアウト 25 秒より少し長くする。
const REQUEST_TIMEOUT_MS = 30_000

export interface EvenStorage {
  getLocalStorage(key: string): Promise<string>
  setLocalStorage(key: string, value: string): Promise<boolean>
}

export interface BridgeConfig {
  bridgeUrl: string
  token: string
}

export interface TaskList {
  id: string
  title: string
}

export interface Task {
  id: string
  title: string
  status: 'needsAction' | 'completed'
  /** "YYYY-MM-DD" または null。 */
  due: string | null
  notes: string
  parent: string | null
  /** 0 = トップレベル、1 = 子タスク。 */
  depth: number
}

export function getConfig(): BridgeConfig {
  const stored = readStored()
  return {
    bridgeUrl: normalizeUrl(stored.bridgeUrl || ((import.meta.env.VITE_BRIDGE_URL as string) || '')),
    token: stored.token || ((import.meta.env.VITE_BRIDGE_TOKEN as string) || ''),
  }
}

export function configured(): boolean {
  return getConfig().bridgeUrl.length > 0
}

/** 設定を WebView と Even ストレージの両方に保存する。 */
export async function saveConfig(config: BridgeConfig, storage: EvenStorage | null): Promise<void> {
  const value = JSON.stringify({ bridgeUrl: normalizeUrl(config.bridgeUrl), token: config.token.trim() })
  window.localStorage.setItem(STORAGE_KEY, value)
  await storage?.setLocalStorage(STORAGE_KEY, value).catch(() => false)
}

export async function clearConfig(storage: EvenStorage | null): Promise<void> {
  window.localStorage.removeItem(STORAGE_KEY)
  await storage?.setLocalStorage(STORAGE_KEY, '').catch(() => false)
}

/** Even ストレージに保存済みの設定を WebView の localStorage へ戻す。 */
export async function hydrateConfig(storage: EvenStorage): Promise<void> {
  try {
    const raw = await storage.getLocalStorage(STORAGE_KEY)
    if (raw) window.localStorage.setItem(STORAGE_KEY, raw)
  } catch (error) {
    console.warn('Failed to hydrate config from Even storage', error)
  }
}

function readStored(): BridgeConfig {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}') as Partial<BridgeConfig>
    return {
      bridgeUrl: typeof parsed.bridgeUrl === 'string' ? parsed.bridgeUrl : '',
      token: typeof parsed.token === 'string' ? parsed.token : '',
    }
  } catch {
    return { bridgeUrl: '', token: '' }
  }
}

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

/**
 * bridge へ要求を送り JSON を返す。
 * @throws Error サーバーが {"error": "..."} を返した場合はその文言、それ以外は HTTP 状態。
 */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { bridgeUrl, token } = getConfig()
  if (!bridgeUrl) throw new Error('Bridge URL 未設定')
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) }
  if (token) headers.Authorization = `Bearer ${token}`
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(`${bridgeUrl}${path}`, { ...init, headers, signal: controller.signal })
    const data = (await response.json().catch(() => ({}))) as T & { error?: string }
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
    return data
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw new Error('応答がタイムアウトしました')
    throw error
  } finally {
    window.clearTimeout(timer)
  }
}

function postJson<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function fetchLists(): Promise<TaskList[]> {
  return (await request<{ lists: TaskList[] }>('/lists')).lists
}

export async function fetchTasks(listId: string, includeCompleted: boolean): Promise<Task[]> {
  const query = new URLSearchParams({ list: listId, completed: includeCompleted ? '1' : '0' })
  return (await request<{ tasks: Task[] }>(`/tasks?${query}`)).tasks
}

export async function addTask(listId: string, title: string, due: string | null = null): Promise<Task> {
  return (await postJson<{ task: Task }>('/tasks/add', { list: listId, title, due })).task
}

export async function setCompleted(listId: string, taskId: string, completed: boolean): Promise<Task> {
  return (await postJson<{ task: Task }>('/tasks/complete', { list: listId, id: taskId, completed })).task
}

export async function setDue(listId: string, taskId: string, due: string | null): Promise<Task> {
  return (await postJson<{ task: Task }>('/tasks/due', { list: listId, id: taskId, due })).task
}

export async function deleteTask(listId: string, taskId: string): Promise<void> {
  await postJson('/tasks/delete', { list: listId, id: taskId })
}

/** G2 マイクの PCM（16kHz mono s16le）を送り、文字起こし結果を返す。 */
export async function transcribe(pcm: Uint8Array): Promise<string> {
  const data = await request<{ text?: string }>('/stt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: pcm as BodyInit,
  })
  return (data.text ?? '').trim()
}
