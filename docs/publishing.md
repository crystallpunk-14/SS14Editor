# Публикация в VS Code Marketplace

Релиз выпускается вручную: `.vsix` собирается локально и загружается через
сайт Marketplace. Токен (PAT) для этого не нужен. Автопубликация по тегу
вынесена в отдельный issue.

## Один раз: publisher

1. Войти на <https://marketplace.visualstudio.com/manage> под Microsoft-аккаунтом.
2. **Create publisher**, ID — `TheShuEd`. Он обязан совпадать с полем
   `publisher` в `package.json` и с константой `PUBLISHER` в
   `src/core/index.ts`. Их совпадение проверяет тест
   `test/core/extension-id.test.ts`.

## Каждый релиз

1. Поднять `version` в `package.json` (`npm version <x.y.z> --no-git-tag-version`
   обновит и `package-lock.json`) и дописать раздел в `CHANGELOG.md`. Marketplace
   не принимает версию, которая уже была загружена: исправление выходит
   следующей версией.
2. Собрать и проверить:

   ```sh
   npm ci
   npm run typecheck && npm run lint && npm test
   npm run package          # -> ss14editor.vsix
   npx vsce ls --no-dependencies   # что попадёт в .vsix
   ```

   `vsce package` не должен выдавать ни ошибок, ни предупреждений. В `.vsix`
   должны быть `dist/`, `assets/schema-cli/`, `assets/icon.png`,
   `assets/icon.attribution.yml`, `README.md`, `CHANGELOG.md`, `LICENSE`, и
   больше ничего.
3. Поставить `.vsix` в чистый профиль и убедиться, что расширение активируется
   на собранном форке (Output → **SS14 Editor**):

   ```sh
   code --user-data-dir /tmp/ss14-clean --extensions-dir /tmp/ss14-clean-ext \
        --install-extension ss14editor.vsix
   code --user-data-dir /tmp/ss14-clean --extensions-dir /tmp/ss14-clean-ext <путь-к-форку>
   ```

4. На <https://marketplace.visualstudio.com/manage/publishers/TheShuEd>:
   - первая версия — **New extension → Visual Studio Code**, загрузить `ss14editor.vsix`;
   - следующие — у расширения **… → Update**, загрузить новый `.vsix`.

   Проверка на стороне Marketplace занимает несколько минут, статус виден
   там же.
5. Отметить релиз в репо:

   ```sh
   git tag v<x.y.z>
   git push origin v<x.y.z>
   ```

   На GitHub: **Releases → Draft a new release**, тег `v<x.y.z>`, текст из
   раздела `CHANGELOG.md`, приложить `ss14editor.vsix`.

## Что видно в Marketplace

- Страница расширения — это `README.md`, вкладка Changelog — `CHANGELOG.md`.
  Обе обновляются только с новой версией.
- Иконка — `assets/icon.png` (логотип SS14, CC-BY-SA-4.0, атрибуция в
  `assets/icon.attribution.yml`).
- Имя, описание и ключевые слова — `displayName`, `description`, `keywords` в
  `package.json`.
