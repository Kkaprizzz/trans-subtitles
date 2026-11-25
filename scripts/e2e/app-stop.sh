#!/bin/bash
# Остановка приложения, запущенного app-start.sh. Шаблон поиска собран из двух половин:
# если он целиком окажется в тексте вызывающей команды, pgrep -f найдёт и убьёт саму команду.
E2E_DIR="${E2E_DIR:-/tmp/ts-e2e}"
PAT="dist/elec""tron .*remote-debugging-port=9333"
[ -f "$E2E_DIR/app.pgid" ] && kill -- -"$(cat "$E2E_DIR/app.pgid")" 2>/dev/null
for pid in $(pgrep -f "$PAT"); do kill "$pid" 2>/dev/null; done
sleep 1
pgrep -f "$PAT" >/dev/null && echo "ещё жив" || echo "остановлено"
