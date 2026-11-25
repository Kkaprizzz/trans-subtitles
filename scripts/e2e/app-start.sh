#!/bin/bash
# Запуск приложения для проверки через CDP (порт 9333) в своей группе процессов.
#   scripts/e2e/app-start.sh <папка профиля>   — профиль отдельный, рабочий не трогаем
# Переменные окружения (TS_OPEN, TS_RENDER_OUT, TS_AI_KEY…) пробрасываются в приложение.
# Состояние (номер группы, лог) — в $E2E_DIR (по умолчанию /tmp/ts-e2e).
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
E2E_DIR="${E2E_DIR:-/tmp/ts-e2e}"
mkdir -p "$E2E_DIR"
[ -z "$1" ] && { echo "нужна папка профиля"; exit 2; }
cd "$ROOT" || exit 1
setsid bash -c "echo \$\$ > '$E2E_DIR/app.pgid'; exec env -u ELECTRON_RUN_AS_NODE npx electron . --remote-debugging-port=9333 --user-data-dir='$1'" > "$E2E_DIR/app.log" 2>&1 < /dev/null &
for i in $(seq 1 40); do curl -s http://127.0.0.1:9333/json >/dev/null 2>&1 && break; sleep 0.5; done
sleep 2
echo "запущено, группа $(cat "$E2E_DIR/app.pgid")"
