// 接続先を埋め込んだ EHPK を作るスクリプト。
//
// 使い方:
//   BRIDGE_URL=http://<host>:18888/api/devices/xangi-google-tasks BRIDGE_TOKEN=... \
//     npm run pack:configured -- --output ./google-tasks-g2.ehpk
//
// 処理:
//   1. app.json の network whitelist に BRIDGE_URL の origin を足した一時 manifest を作る
//      （Even アプリは whitelist 外への通信を許可しないため）。
//   2. VITE_BRIDGE_URL / VITE_BRIDGE_TOKEN を初期値として埋め込んで build する。
//   3. evenhub pack で .ehpk を出力する。
// 生成物には token が含まれるため、他人に渡さないこと。
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import appManifest from '../app.json' with { type: 'json' }
import sdkPackage from '../node_modules/@evenrealities/even_hub_sdk/package.json' with { type: 'json' }

function argValue(name, fallback) {
  const args = process.argv.slice(2)
  const inline = args.find(arg => arg.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1)
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { stdio: 'inherit', env })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

const bridgeUrl = argValue('--bridge-url', process.env.BRIDGE_URL)
const bridgeToken = argValue('--bridge-token', process.env.BRIDGE_TOKEN || '')
const output = resolve(argValue('--output', './google-tasks-g2.ehpk'))
if (!bridgeUrl) {
  console.error('BRIDGE_URL or --bridge-url is required')
  process.exit(1)
}
const origin = new URL(bridgeUrl).origin

const manifest = structuredClone(appManifest)
for (const permission of manifest.permissions ?? []) {
  if (permission.name !== 'network') continue
  permission.whitelist = Array.from(new Set([...(permission.whitelist ?? []), origin]))
}
const manifestPath = join(mkdtempSync(join(tmpdir(), 'gtasks-g2-pack-')), 'app.configured.json')
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

run('npm', ['run', 'build'], { ...process.env, VITE_BRIDGE_URL: bridgeUrl, VITE_BRIDGE_TOKEN: bridgeToken })
// --sdk-ver を渡さないと evenhub pack は npm 最新の SDK を前提に min_app_version を
// 引き上げる。実際に組み込んだ SDK の版を渡して、app.json の値と食い違わないようにする。
run('npx', ['evenhub', 'pack', manifestPath, './dist', '--sdk-ver', sdkPackage.version, '--output', output])
console.log(`manifest: ${manifestPath}`)
