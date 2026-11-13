# Gemini Web to OpenAI Bridge

Локальный мост, который отдаёт модели Gemini из подписки **Google AI Pro** через OpenAI-совместимый API на `http://127.0.0.1:8010/v1`. Работает поверх веб-сессии gemini.google.com (библиотека `gemini_webapi`).

---

## Вход в аккаунт: один раз, без F12

Мост владеет отдельным профилем Chrome и читает сессию через Chrome DevTools Protocol.

1. Запустите `login.cmd`.
2. В открывшемся окне Chrome войдите в свой аккаунт Google.
3. Всё. Скрипт дождётся входа и сообщит, что мост авторизован.

Копировать `__Secure-1PSID` / `__Secure-1PSIDTS` вручную не нужно. Дальше мост:
- сохраняет ротированные Google куки в `.env` каждые 30 секунд;
- каждые 5 минут сверяется с браузером и подхватывает свежую сессию;
- при сбое авторизации сам перечитывает куки из браузера и переподключается.

Кнопка «Забрать сессию из браузера» на дашборде делает то же самое вручную (`POST /auth/refresh`).

> Профиль моста (`.chrome-profile/`) и `.env` содержат живую сессию Google и исключены из git.
> Если вход в аккаунт сброшен Google, `login.cmd` нужно запустить повторно — это единственный ручной шаг.

---

## Модели

Список соответствует тому, что реально отдаёт аккаунт (`GET /health` → `active_models`).

| ID в мосте | Модель аккаунта | Thinking | Назначение |
|---|---|---|---|
| `gemini-orchestrator` | выбирается автоматически | по маршруту | модель по умолчанию |
| `gemini-carbon` | `gemini-carbon` | да | глубокие рассуждения, архитектура |
| `gemini-pro` | `gemini-pro` | да | сложные задачи |
| `gemini-4-hydrogen-high` | `gemini-4-hydrogen` | да | кодинг с рассуждениями |
| `gemini-4-hydrogen` | `gemini-4-hydrogen` | нет | быстрый агентный кодинг |
| `gemini-flash-lite` | `gemini-flash-lite` | нет | заголовки, короткие ответы |

Маршрутизация `gemini-orchestrator`:
- запросы с инструментами и ответы на результаты инструментов → Hydrogen без Thinking (не тормозить агентный цикл);
- `reasoning_effort` = `high`/`medium` или запрос на детальный план/архитектуру → Carbon с Thinking;
- генерация заголовка чата → Flash-Lite;
- остальное → Hydrogen без Thinking.

Модификатор `@think=true` / `@think=false` в имени модели перекрывает флаг Thinking.

---

## Контекст и вызовы инструментов

- История передаётся целиком: без окна в 14 сообщений, без обрезки выводов инструментов, без вырезания фраз из ответов ассистента.
- Проверенный потолок промпта — **700 000 символов** (замерено сквозным тестом с контрольной меткой в самом начале). При превышении отбрасываются самые старые ходы целиком, а не рвутся посередине. Порог меняется через `MAX_PROMPT_CHARS`.
- Вызовы инструментов передаются модели как JSON-описание и разбираются из блоков ```tool_call. Нативного function calling у веб-сессии Gemini нет — это ограничение протокола, а не моста.
- Мост не досочиняет вызовы инструментов за модель: если модель не вызвала инструмент, в ответе будет текст.
- Запросы выполняются параллельно, без глобальной очереди.

---

## Мультимодальность

Изображения, видео, аудио и документы определяются по magic bytes и MIME, а не по расширению: JPEG, PNG, WEBP, GIF, BMP, MP4, MOV, WebM, MKV, MP3, WAV, FLAC, OGG, PDF. Поддерживаются `data:`-URI, локальные пути Windows (`file:///C:/...`, `C:\...`) и HTTP-ссылки.

---

## Мониторинг квот

- Дашборд: `http://127.0.0.1:8010/dashboard`
- CLI: `python quota.py`
- JSON: `GET /v1/quota`
- ProviderStudio показывает живой бейдж квоты и ссылку на дашборд.

---

## Управление

| Действие | Команда |
|---|---|
| Вход в Google | `login.cmd` |
| Запуск в фоне | `start-hidden.vbs` |
| Запуск с логами | `start.cmd` |
| Остановка | `stop.cmd` |
| Автозагрузка Windows | `install-autostart.cmd` / `uninstall-autostart.cmd` |
| Открыть дашборд | `open-dashboard.cmd` |
| Статус | `status.cmd` |

`stop.cmd` завершает только процесс моста (сверяет командную строку), а не «whatever слушает порт».

---

## Конфигурация

`.env` (не коммитится):

```
GEMINI_SECURE_1PSID=...
GEMINI_SECURE_1PSIDTS=...
PORT=8010
HOST=127.0.0.1
```

Переменные окружения имеют приоритет над `.env`. Дополнительно: `MAX_PROMPT_CHARS` (по умолчанию 700000), `CDP_PORT` (по умолчанию 9223).

---

## Подключение в OpenCode (`~/.config/opencode/opencode.jsonc`)

```jsonc
{
  "provider": {
    "gemini-web-bridge-google-ai-pro": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Gemini Web Bridge (Google AI Pro)",
      "options": {
        "baseURL": "http://127.0.0.1:8010/v1",
        "apiKey": "none"
      },
      "models": {
        "gemini-orchestrator": {
          "name": "Gemini Orchestrator (Auto)",
          "limit": { "context": 1048576, "output": 65536 },
          "attachment": true,
          "reasoning": true,
          "tool_call": true
        },
        "gemini-carbon": {
          "name": "Gemini Carbon (Глубокие рассуждения)",
          "limit": { "context": 1048576, "output": 65536 },
          "attachment": true,
          "reasoning": true,
          "tool_call": true
        },
        "gemini-pro": {
          "name": "Gemini Pro (Сложные задачи)",
          "limit": { "context": 1048576, "output": 65536 },
          "attachment": true,
          "reasoning": true,
          "tool_call": true
        },
        "gemini-4-hydrogen": {
          "name": "Gemini 4 Hydrogen (Повседневный кодинг)",
          "limit": { "context": 1048576, "output": 65536 },
          "attachment": true,
          "tool_call": true
        },
        "gemini-flash-lite": {
          "name": "Gemini Flash Lite (Быстрые ответы)",
          "limit": { "context": 1048576, "output": 65536 },
          "attachment": true,
          "tool_call": true
        }
      }
    }
  },
  "model": "gemini-web-bridge-google-ai-pro/gemini-orchestrator"
}
```

---

## Отличия от Antigravity

Мост использует веб-сессию Gemini, а не внутренний API Antigravity. Практические следствия:

- вызовы инструментов идут через текстовый протокол, а не нативный function calling;
- агентный цикл и инструменты принадлежат вашему клиенту (OpenCode), а не Antigravity;
- квота общая с подпиской Google AI Pro и считается в тех же кредитах.