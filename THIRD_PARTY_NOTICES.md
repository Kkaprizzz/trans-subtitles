# Сторонние компоненты

Код приложения распространяется по лицензии MIT (см. `LICENSE`). В сборку и в работу приложения входят
чужие компоненты со своими лицензиями.

| Компонент | Для чего | Лицензия |
|---|---|---|
| [Electron](https://www.electronjs.org/) | оболочка приложения и рендер кадров | MIT |
| [FFmpeg](https://ffmpeg.org/) в виде пакета [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) | извлечение звука, кодирование оверлея | **GPL-3.0-or-later** (сборка с libx264) |
| ffprobe-static | чтение свойств файла | MIT (бинарник ffprobe из состава FFmpeg) |
| [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) | запуск GigaAM | Apache-2.0 |
| [GigaAM v3](https://huggingface.co/ai-sage/GigaAM-v3) | распознавание русской речи | MIT |
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp) и модели [Whisper](https://github.com/openai/whisper) | распознавание речи | MIT |
| electron-updater, electron-builder | автообновление и сборка | MIT |
| React | интерфейс | MIT |
| Montserrat, Commissioner, IBM Plex Sans, Arsenal, Spectral, Prata (через @fontsource) | шрифты субтитров | SIL Open Font License 1.1 |

## О FFmpeg

Приложение запускает FFmpeg отдельным процессом и не изменяет его. Исходный код и условия лицензии GPL
доступны на сайте FFmpeg и в репозитории пакета `ffmpeg-static`. Модели GigaAM и Whisper скачиваются при первом
использовании с Hugging Face и в репозиторий не входят.
