# Публикация Rider-плагина в JetBrains Marketplace

Плагин собирается из `rider-plugin/` (см. ADR-0002) и живёт на Marketplace
отдельно от VS Code-расширения ([publishing.md](publishing.md)). Релиз
выпускается вручную; токен и сертификат подписи хранятся только у того, кто
публикует, — в репо их нет.

## Один раз

1. **Vendor.** Войти на <https://plugins.jetbrains.com> под JetBrains Account.
   В `plugin.xml` указан `<vendor>TheShuEd</vendor>` — это имя, которое увидят
   пользователи; при желании завести на Marketplace одноимённую организацию
   (**Profile → Organizations**) и публиковать от неё.
2. **Первая версия — только через сайт.** Marketplace не принимает первую
   загрузку по API: **Upload plugin**, выбрать
   `rider-plugin/build/distributions/ss14editor-rider-<версия>.zip`, лицензию
   MIT, теги. Plugin ID `com.theshued.ss14editor` после этого менять нельзя.
3. **Токен** для следующих версий: **Profile → My Tokens → Generate Token**.
   Хранить как секрет; в репо и в `gradle.properties` его не класть.
4. **Подпись (желательно).** Без неё плагин публикуется, но Rider при
   установке предупреждает о неподписанном плагине. Сертификат:

   ```sh
   openssl genpkey -aes-256-cbc -algorithm RSA -out private_encrypted.pem -pkeyopt rsa_keygen_bits:4096
   openssl rsa -in private_encrypted.pem -out private.pem
   openssl req -key private.pem -new -x509 -days 365 -out chain.crt
   ```

   Хранить `private_encrypted.pem`, `chain.crt` и пароль так же, как токен;
   незашифрованный `private.pem` после этого удалить. Сертификат на год —
   продлевать до истечения.

## Каждый релиз

1. Поднять `pluginVersion` в `rider-plugin/gradle.properties` и дописать
   `<change-notes>` в `plugin.xml`. Marketplace не принимает уже загруженную
   версию.
2. Собрать и проверить — та же цепочка, что в CI:

   ```sh
   cd rider-plugin
   ./gradlew buildPlugin test verifyPlugin
   ```

   `verifyPlugin` проверяет самую старую (`riderVersion`) и самую новую
   (`riderLatestVersion`) поддерживаемые версии Rider из `gradle.properties` —
   перед релизом поднять `riderLatestVersion` до текущей. Обе должны быть
   `Compatible` без internal API; deprecated допустимы (переименованное LSP API,
   см. ADR-0002). Тот же Plugin Verifier Marketplace запускает при загрузке. В zip должны быть
   `lib/`, `server/dist/server.js`, `server/dist/prototype-index-worker.js`,
   `server/assets/schema-cli/`.
3. Поставить zip в свой Rider (**Settings → Plugins → ⚙ → Install Plugin from
   Disk**), перезапустить, открыть собранный форк и прототип: подсказки, hover,
   переход, подсветка ошибок.
4. Опубликовать:

   ```sh
   export PUBLISH_TOKEN=<токен>
   # подпись, если есть сертификат (многострочные значения — в base64):
   export CERTIFICATE_CHAIN=$(base64 -w0 chain.crt)
   export PRIVATE_KEY=$(base64 -w0 private_encrypted.pem)
   export PRIVATE_KEY_PASSWORD=<пароль>
   ./gradlew publishPlugin
   ```

   Без `CERTIFICATE_CHAIN`/`PRIVATE_KEY` шаг подписи пропускается. Новая
   версия появляется после модерации JetBrains — статус на странице плагина.
5. Отметить релиз в репо: тег `rider-v<версия>` и GitHub Release с zip из
   `rider-plugin/build/distributions/`.

## Что видно в Marketplace

- Описание и change notes — `<description>` и `<change-notes>` в
  `rider-plugin/src/main/resources/META-INF/plugin.xml`.
- Иконка — `META-INF/pluginIcon.svg` (логотип SS14, CC-BY-SA-4.0, атрибуция в
  описании и в `assets/icon.attribution.yml`).
- Совместимость — `sinceBuild = 253` (Rider 2025.3+) в `build.gradle.kts`.
