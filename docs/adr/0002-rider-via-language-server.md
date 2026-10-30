# Rider через LSP-сервер на TS-ядре и платформенный LSP API

**Статус:** proposed (этап 0 плана Rider; выбор Node — открыт)

Плагин нужен и для Rider. Вся логика автокомплита, hover и перехода к определению уже живёт в чистом TS-ядре `src/core` (без `vscode`, граница закреплена eslint), а `src/host` — тонкий адаптер. Решаем не переписывать ядро ни на Kotlin (PSI), ни на C# (бэкенд ReSharper), а обернуть его в stdio language server (`src/server/server.ts`, бандл `dist/server.js`) и подключить к Rider тонким Kotlin-плагином (`rider-plugin/`) через **встроенный LSP API платформы** (`com.intellij.modules.lsp`), не через LSP4IJ.

## Что проверил спайк

- **LSP API есть в Rider и бесплатен.** В установленном Rider 2025.3.4 (build 253) модули `intellij.platform.lsp` / `com.intellij.modules.lsp` бандлены (классы в `lib/product-backend.jar`); с 2025.2 API доступен без платной подписки. Плагин (`LspServerSupportProvider` + `ProjectWideLspServerDescriptor`) компилируется против локального Rider (`./gradlew buildPlugin`, IntelliJ Platform Gradle Plugin 2.19, Gradle 9.2.1, Kotlin 2.2.21, JBR 21 из Rider).
- **Набор фич LSP API покрывает v1.** `completion` (2023.2), `definition` (2023.2), `hover` (2023.3.2), клиентский `workspace/didChangeWatchedFiles` (2023.3.2), `workspace/executeCommand` (2024.1), `completionItem/resolve` (2024.2), `$/progress` (2025.3). Кастомные запросы — через `createLsp4jClient()` / `lsp4jServerClass`.
- **Сервер на ядре работает без изменений ядра.** Скриптовым LSP-клиентом на форке `crystall-edge`: форк распознан, schema-cli — 2087 компонентов (~11 с холодно), индекс — 23 899 прототипов (~6 с), completion компонентов и enum-значений, hover компонента, переход к `parent:` и к C#-классу компонента. Переиспользованы `fork-fs.ts` и воркер индекса как есть — они не зависят от `vscode`.

## Рассмотренные варианты

- **Ядро на Kotlin поверх PSI YAML-плагина.** Отвергнут: ~4000 строк логики курсора/YAML в двух копиях, расходящихся со временем.
- **Ядро на C# в бэкенде ReSharper.** Отвергнут: тот же перенос плюс протокол rd между фронтендом и бэкендом.
- **LSP4IJ (Red Hat).** Отложен: внешняя зависимость, которую пользователь ставит отдельно; встроенного API хватает. Вернуться, если упрёмся в недостающую фичу протокола.
- **LSP-сервер + платформенный LSP API.** Принят.

## Последствия

- Минимальная версия — Rider 2025.3 (`sinceBuild = 253`); ниже можно опустить до 2025.2, если понадобится.
- **Node — открытый вопрос.** Rider бандлит плагин NodeJS, но не рантайм Node: `NodeJsInterpreterManager` лишь находит Node, установленный пользователем. Для аудитории SS14 (C#-разработчики) Node на машине не гарантирован. Варианты: (а) Node из PATH / настроек Rider с понятной ошибкой — так сделан спайк; (б) собрать сервер в бинарь (Node SEA) на каждую ОС, +~40–90 МБ на платформу; (в) скачивать Node при первом запуске. Решить до публикации.
- `dotnet` для schema-cli требуется так же, как в VS Code.
- Поведение «переоткрыть подсказки» после Backspace/Enter/выбора поля в LSP не выражается; сервер помечает такие кандидаты (`data.continues`), а клиент Rider должен будет вызывать автопопап сам (этап 3).
- **Файлы прототипов в Rider — вне контента проекта.** Контент проекта в Rider — это файлы `.csproj`, а `Resources/` не входит ни в один: на открытом прототипе `ProjectFileIndex.isInContent = false`, и LSP-менеджер платформы вовсе не предлагает такой файл `LspServerSupportProvider.fileOpened`. Плагин при открытии форка добавляет `Resources/Prototypes/` и `RobustToolbox/Resources/EnginePrototypes/` как content roots модуля, живущего только в памяти (своя `EntitySource`, не сериализуется — `.idea` форка не трогается). Проверено на Monolith в Rider 2025.3.4: сервер стартует, переход к C#-классу компонента работает. Дескриптор — `LspServerDescriptor` с корнем в папке решения, а не `ProjectWideLspServerDescriptor` (его `BaseProjectDirectories` в Rider — папки `.csproj`).
- **Completion рядом с YAML-плагином Rider** проверен вручную на Monolith: подсказки сервера показываются как надо, конфликтов с бандленным YAML-плагином не замечено.
- `runIde` на свежей песочнице упирается в окно лицензии (выход с кодом 7): её нужно один раз активировать, либо ставить собранный zip в обычный Rider.
