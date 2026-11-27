// G2 アプリの Vite 設定。evenhub-simulator や実機の QR 開発用に LAN から開けるよう host を公開する。
import { defineConfig } from 'vite'

export default defineConfig({
  server: { host: true, port: 5173 },
  build: { target: 'esnext' },
})
