import type { ForkStatus, PrototypeDiagnostic, SchemaStatus, StaleBuild } from '../core';

/** The languages the server speaks to the user in; the client picks one in `initializationOptions.locale`. */
export type Locale = 'en' | 'ru';

export function localeOf(value: unknown): Locale {
  return value === 'ru' ? 'ru' : 'en';
}

/**
 * Everything the server shows a user: problems (`window/showMessage`),
 * diagnostics and progress titles. The log (`window/logMessage`) stays in
 * English — it is for bug reports, not for reading in the editor.
 *
 * English is the core's own text, word for word, so the VS Code wording and
 * the server's never drift; another language is built from the codes and data
 * the core returns alongside it.
 */
export interface Messages {
  readonly noFolder: string;
  forkProblem(status: Extract<ForkStatus, { recognized: false }>): string;
  staleBuild(stale: StaleBuild): string;
  schemaProblem(status: Exclude<SchemaStatus, { state: 'loaded' }>): string;
  indexFailed(message: string): string;
  readonly extractingSchema: string;
  readonly indexingPrototypes: string;
  indexProgress(done: number, total: number): string;
  diagnostic(problem: PrototypeDiagnostic): string;
  readonly staleDiagnosticHint: string;
}

const EN: Messages = {
  noFolder: 'no folder is open — open an SS14 fork.',
  forkProblem: (status) => status.message,
  staleBuild: (stale) => stale.message,
  schemaProblem: (status) => status.message,
  indexFailed: (message) => message,
  extractingSchema: 'SS14: extracting schema',
  indexingPrototypes: 'SS14: indexing prototypes',
  indexProgress: (done, total) => `${done}/${total} files`,
  diagnostic: (problem) => problem.message,
  staleDiagnosticHint: ' The fork build is older than its C# sources — rebuild it to refresh the schema.',
};

/** How the Rider plugin's own menu names the rebuild command. */
const RU_REBUILD_HINT = 'Затем выполните Tools → SS14 → «Пересобрать схему».';

const RU_FORK_PROBLEMS: Record<Extract<ForkStatus, { recognized: false }>['code'], string> = {
  'no-robusttoolbox-submodule': 'Это не форк SS14: в .gitmodules не объявлен сабмодуль RobustToolbox.',
  'no-content-server': 'Это не форк SS14: в корне нет папки Content.Server/.',
  'no-content-client': 'Это не форк SS14: в корне нет папки Content.Client/.',
  'no-resources-prototypes': 'Это не форк SS14: в корне нет папки Resources/Prototypes/.',
  'dlls-not-found': 'Форк не собран: нет DLL в bin/Content.Server/ или bin/Content.Client/. Соберите форк и откройте его заново.',
};

/** Keeps the extractor's own output (stderr) as it is — it is .NET's text, not ours. */
function detailOf(message: string): string {
  const newline = message.indexOf('\n');
  return newline === -1 ? '' : message.slice(newline);
}

const RU: Messages = {
  noFolder: 'не открыта папка — откройте форк SS14.',
  forkProblem: (status) => RU_FORK_PROBLEMS[status.code],
  staleBuild: (stale) =>
    `⚠ Сборка форка устарела: исходники C# в ${stale.projects.join(', ')} новее DLL в bin/. ` +
    'Схема взята из прошлой сборки — пересоберите форк, чтобы подхватить изменения.',
  schemaProblem: (status) => {
    switch (status.state) {
      case 'dotnet-missing':
        return `dotnet не найден: .NET SDK нет в PATH. Установите его. ${RU_REBUILD_HINT}`;
      case 'dotnet-too-old':
        return (
          `Установленный .NET слишком старый для извлечения схемы (нужен .NET 8 или новее). ` +
          `Установите свежий .NET SDK. ${RU_REBUILD_HINT}${detailOf(status.message)}`
        );
      case 'extractor-missing':
        return 'В этой сборке плагина нет извлекателя схемы (schema-cli). Переустановите плагин.';
      case 'extraction-failed':
        return status.stderr
          ? `Не удалось извлечь схему:${detailOf(status.message) || `\n${status.stderr}`}`
          : `Не удалось извлечь схему. ${RU_REBUILD_HINT}`;
      case 'incompatible':
        return (
          `Схема несовместима: извлекатель выдал версию ${status.foundVersion}, ` +
          `плагин ждёт ${status.expectedVersion}. Обновите плагин; до этого подсказки отключены.`
        );
      case 'fingerprint-mismatch':
        return `Схема повреждена: отпечаток рядом с metadata.json не совпадает с документом. ${RU_REBUILD_HINT}`;
    }
  },
  indexFailed: (message) => message.replace(/^Prototype index failed: /, 'Не удалось построить индекс прототипов: '),
  extractingSchema: 'SS14: извлечение схемы',
  indexingPrototypes: 'SS14: индексация прототипов',
  indexProgress: (done, total) => `${done}/${total} файлов`,
  diagnostic: (problem) => {
    switch (problem.code) {
      case 'unknown-component':
        return `Неизвестный компонент «${problem.value}».`;
      case 'unknown-prototype':
        return `Нет прототипа ${problem.kind} с id «${problem.value}».`;
      case 'invalid-enum-value':
        return `«${problem.value}» — не одно из значений: ${(problem.choices ?? []).join(', ')}.`;
    }
  },
  staleDiagnosticHint: ' Сборка форка старше исходников C# — пересоберите его, чтобы обновить схему.',
};

export function messagesFor(locale: Locale): Messages {
  return locale === 'ru' ? RU : EN;
}
