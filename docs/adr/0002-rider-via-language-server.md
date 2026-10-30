# Rider через LSP-сервер на TS-ядре и платформенный LSP API

**Статус:** accepted (этап 0 плана Rider)

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
- **Node — через JavaScript-плагин Rider.** Rider не бандлит рантайм Node, но его JavaScript-плагин (бандлен и включён по умолчанию) знает Node проекта (`NodeJsInterpreterManager`, Settings | Languages & Frameworks | Node.js), находит установленный (`NodeJsLocalInterpreterManager.detectMostRelevant`) и умеет скачать его сам (действие `JavaScript.DownloadNode`). Плагин берёт Node оттуда (≥ 18); если его нет — уведомление с кнопкой этого скачивания, а после смены интерпретатора сервер стартует сам. Отвергнуты: свой Node в плагине (Node SEA/bun — +60–90 МБ на каждую ОС, а Marketplace не раздаёт zip по платформам), своё скачивание (дублирует зеркала, прокси и проверку сумм, которые уже есть в Rider), голый PATH (без подсказки, что делать). Цена — обязательная зависимость `<depends>JavaScript</depends>`: при отключённом JavaScript-плагине наш не загрузится.
- `dotnet` для schema-cli требуется так же, как в VS Code.
- **Статусы в Rider — не только лог.** В VS Code единственная поверхность статусов — Output-канал (#45). В Rider `window/logMessage` попадает лишь в `idea.log`, поэтому сервер дополнительно показывает проблемы, требующие действия (не форк, устаревшая сборка, нет `dotnet`, сбой индекса), одним `window/showMessage` на каждое новое сообщение, а долгие операции (первая экстракция схемы, сборка индекса) — как `$/progress` в статус-баре.
- Поведение «переоткрыть подсказки» после Backspace/Enter/выбора поля в LSP не выражается; сервер помечает такие кандидаты (`data.continues`), а клиент Rider должен будет вызывать автопопап сам (этап 3).
- **Файлы прототипов в Rider — вне контента проекта.** Контент проекта в Rider — это файлы `.csproj`, а `Resources/` не входит ни в один: на открытом прототипе `ProjectFileIndex.isInContent = false`, и LSP-менеджер платформы вовсе не предлагает такой файл `LspServerSupportProvider.fileOpened`. Плагин при открытии форка добавляет `Resources/Prototypes/` и `RobustToolbox/Resources/EnginePrototypes/` как content roots модуля, живущего только в памяти (`NonPersistentEntitySource` — не пишется ни в `.idea` форка, ни в кэш Workspace Model; собственный `EntitySource` для кэша требует сгенерированных метаданных и сыплет `MissingMetadataStorage`). Проверено на Monolith в Rider 2025.3.4: сервер стартует, переход к C#-классу компонента работает. Дескриптор — `LspServerDescriptor` с корнем в папке решения, а не `ProjectWideLspServerDescriptor` (его `BaseProjectDirectories` в Rider — папки `.csproj`).
- **Completion рядом с YAML-плагином Rider** проверен вручную на Monolith: подсказки сервера показываются как надо, конфликтов с бандленным YAML-плагином не замечено.
- **Плагин требует перезапуска (`require-restart="true"`).** Динамическая выгрузка ломается не на нас: снимок памяти при неудачной выгрузке (Rider 2025.3.4) показал единственный корень — поиск действий Rider (`RiderActionSearchEverywhereContributor` → `GotoActionModel.myActionGroups`), который после любого Find Action держит все показанные действия, наши тоже, до закрытия проекта. Сервер, модуль прототипов и слушатели отпускались корректно. Вместо выгрузки, которая почти всегда кончается перезапуском, плагин честно просит его сразу.
- `runIde` на свежей песочнице упирается в окно лицензии (выход с кодом 7): её нужно один раз активировать, либо ставить собранный zip в обычный Rider.
