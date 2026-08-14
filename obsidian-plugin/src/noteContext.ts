import { MarkdownView, type App, type Plugin, type TFile } from 'obsidian';

/** Roughly four characters per token. Good enough to warn about size. */
const CHARS_PER_TOKEN = 4;

/** A note, or part of one, to send alongside a question. */
export interface NoteAttachment {
  /** Vault-relative path, used to resolve links in replies. */
  path: string;
  /** File name without extension, for display. */
  basename: string;
  /** The text being attached. */
  text: string;
  /** Whether `text` was cut to fit the message limit. */
  truncated: boolean;
  /** Whether this is a selection rather than the whole note. */
  isSelection: boolean;
}

/**
 * Tracks the note the user was last editing.
 *
 * This exists because of a specific Obsidian behaviour: once focus moves into a
 * sidebar panel, `getActiveViewOfType(MarkdownView)` returns null, so a chat panel
 * cannot ask "what am I editing?" at the moment the user clicks Send. The last
 * Markdown view is therefore remembered as leaves change. The view's editor keeps
 * its selection even while unfocused, so a selection captured this way stays
 * readable.
 */
export class NoteContext {
  private lastMarkdownView: MarkdownView | null = null;

  constructor(private readonly app: App) {}

  /** Starts listening. Registered through the plugin so listeners are cleaned up. */
  track(plugin: Plugin): void {
    plugin.registerEvent(
      this.app.workspace.on('active-leaf-change', (leaf) => {
        const view = leaf?.view;
        if (view instanceof MarkdownView) {
          this.lastMarkdownView = view;
        }
      }),
    );
  }

  /** The Markdown view to read from, preferring the genuinely active one. */
  private view(): MarkdownView | null {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active) {
      this.lastMarkdownView = active;
      return active;
    }
    // Discard a remembered view whose leaf has since been closed.
    if (this.lastMarkdownView && !this.lastMarkdownView.file) {
      this.lastMarkdownView = null;
    }
    return this.lastMarkdownView;
  }

  /** The note that would be attached, or null when none applies. */
  file(): TFile | null {
    const fromView = this.view()?.file ?? null;
    if (fromView) return fromView;

    // getActiveFile survives sidebar focus, so it is a useful last resort.
    const active = this.app.workspace.getActiveFile();
    return active?.extension === 'md' ? active : null;
  }

  /** Whether there is a non-empty selection to attach. */
  hasSelection(): boolean {
    return this.selectionText().length > 0;
  }

  private selectionText(): string {
    try {
      return this.view()?.editor?.getSelection()?.trim() ?? '';
    } catch {
      // A view mid-teardown can throw rather than return empty.
      return '';
    }
  }

  /**
   * Reads the whole note.
   *
   * @param maxChars Budget for the note text.
   * @returns The attachment, or null when no Markdown note is available.
   */
  async wholeNote(maxChars: number): Promise<NoteAttachment | null> {
    const file = this.file();
    if (!file) return null;

    // cachedRead is the right call for read-only use; it avoids a disk hit when
    // Obsidian already holds the contents.
    const raw = await this.app.vault.cachedRead(file);
    return buildAttachment(file, raw, maxChars, false);
  }

  /**
   * Reads the current selection.
   *
   * @param maxChars Budget for the selected text.
   * @returns The attachment, or null when nothing is selected.
   */
  selection(maxChars: number): NoteAttachment | null {
    const file = this.file();
    const text = this.selectionText();
    if (!file || !text) return null;

    return buildAttachment(file, text, maxChars, true);
  }
}

function buildAttachment(
  file: TFile,
  raw: string,
  maxChars: number,
  isSelection: boolean,
): NoteAttachment {
  const truncated = raw.length > maxChars;
  return {
    path: file.path,
    basename: file.basename,
    text: truncated ? raw.slice(0, maxChars) : raw,
    truncated,
    isSelection,
  };
}

/** Approximate token count, for showing cost before sending. */
export function approximateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Combines an attachment with the user's question into one message.
 *
 * The note is delimited and labelled so the model can tell quotation from
 * instruction, and the question goes last because trailing instructions are
 * followed more reliably than leading ones.
 *
 * @param attachment Note or selection to include.
 * @param question What the user typed.
 * @returns The text to send.
 */
export function formatWithContext(attachment: NoteAttachment, question: string): string {
  const label = attachment.isSelection
    ? `a selection from my note "${attachment.basename}"`
    : `my note "${attachment.basename}"`;
  const note = attachment.truncated
    ? `${attachment.text}\n\n[truncated to fit the message limit]`
    : attachment.text;

  return `Here is ${label}:\n\n<note>\n${note}\n</note>\n\n${question}`;
}
