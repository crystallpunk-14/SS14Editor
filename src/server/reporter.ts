import {
  MessageType,
  ShowMessageNotification,
  type Connection,
  type WorkDoneProgressServerReporter,
} from 'vscode-languageserver/node';

import { messagesFor, type Locale, type Messages } from './i18n';

/** What part of the pipeline a problem belongs to — each keeps its own latest problem. */
export type ProblemArea = 'fork' | 'schema' | 'index';

/**
 * The server's only ways to reach the user — the LSP counterpart of the VS Code
 * "SS14 Editor" Output channel (issue #45).
 *
 *   - {@link log}: every status line, to `window/logMessage`. VS Code shows it in
 *     the server's output; Rider only writes it to `idea.log`.
 *   - {@link problem}: a verdict the user has to act on (not a fork, needs a
 *     build, no `dotnet`, a failed index), as one `window/showMessage` per new
 *     message — Rider has no Output channel a user would look at, so a problem
 *     that stayed in the log would go unseen there.
 *   - {@link progress}: long work (a cold schema extraction, an index build) as
 *     `$/progress`, which Rider shows in its status bar.
 */
export class Reporter {
  private readonly problems = new Map<ProblemArea, string>();
  private current: Messages = messagesFor('en');

  constructor(private readonly connection: Connection) {}

  /** The language problems, diagnostics and progress are shown in — set once, from `initialize`. */
  setLocale(locale: Locale): void {
    this.current = messagesFor(locale);
  }

  get messages(): Messages {
    return this.current;
  }

  log(lines: readonly string[]): void {
    for (const line of lines) this.connection.console.log(line);
  }

  /**
   * Report `message` as the current problem of `area`, or clear it with `null`.
   * Shown only when it differs from what was last shown for that area, so a
   * re-detection that lands on the same verdict stays quiet.
   */
  problem(area: ProblemArea, message: string | null, severity: 'warning' | 'error' = 'error'): void {
    if (message === null) {
      this.problems.delete(area);
      return;
    }
    if (this.problems.get(area) === message) return;
    this.problems.set(area, message);
    // A plain notification: `showWarningMessage` & co. send `showMessageRequest`,
    // which waits on the client for a reply nobody gives.
    void this.connection.sendNotification(ShowMessageNotification.type, {
      type: severity === 'warning' ? MessageType.Warning : MessageType.Error,
      message: `SS14 Prototype Editor: ${message}`,
    });
  }

  /** Begin a `$/progress` report; a client without work-done progress gets a no-op reporter. */
  async progress(title: string): Promise<WorkDoneProgressServerReporter> {
    const reporter = await this.connection.window.createWorkDoneProgress();
    reporter.begin(title);
    return reporter;
  }
}
