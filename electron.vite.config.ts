import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'

// версия в заставке (index.html: %VITE_APP_VERSION%)
process.env['VITE_APP_VERSION'] = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          'asr-worker': resolve('src/main/asr-worker.ts'),
          'face-worker': resolve('src/main/face-worker.ts')
        },
        // нативный аддон: подгружается из node_modules в рантайме
        external: ['sherpa-onnx-node', 'onnxruntime-web']
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          render: resolve('src/renderer/render.html')
        }
      }
    }
  }
})
