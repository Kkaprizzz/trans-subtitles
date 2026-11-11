// Запуск electron-vite без ELECTRON_RUN_AS_NODE (IDE-терминалы иногда его выставляют,
// и тогда Electron стартует как обычный Node и падает).
import { spawn } from 'node:child_process'

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn('electron-vite', process.argv.slice(2), {
  stdio: 'inherit',
  env,
  shell: process.platform === 'win32'
})
child.on('exit', (code) => process.exit(code ?? 0))
