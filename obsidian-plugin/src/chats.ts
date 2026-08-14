import type { App, TFile } from 'obsidian';

/**
 * Frontmatter property naming a note's chat.
 *
 * The note stores an ID rather than a file path, and the transcript file is named
 * after that ID. Renaming or moving the note therefore changes nothing: the
 * pointer travels inside the note, and the transcript's name never depends on
 * where the note lives. A path-keyed scheme would need rename tracking, and would
 * still miss renames made outside Obsidian or arriving through sync.
 */
export const FRONTMATTER_KEY = 'chorus-chat';

/** Resolves which transcript file belongs to a note, and assigns IDs on demand. */
export class ChatRegistry {
  constructor(
    private readonly app: App,
    private readonly pluginDir: string,
  ) {}

  /**
   * Transcript for the vault-wide chat.
   *
   * Keeps the original filename so an existing single-chat transcript carries over
   * untouched when note-scoped chats are switched on.
   */
  vaultTranscriptPath(): string {
    return `${this.pluginDir}/history.json`;
  }

  /** Transcript for a note-scoped chat. */
  chatTranscriptPath(chatId: string): string {
    return `${this.pluginDir}/chats/${chatId}.json`;
  }

  /**
   * Reads a note's chat ID.
   *
   * @param file Note to inspect.
   * @returns The ID, or null when the note has no chat yet.
   */
  readChatId(file: TFile): string | null {
    const value = this.app.metadataCache.getFileCache(file)?.frontmatter?.[FRONTMATTER_KEY];
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  /**
   * Assigns a chat ID to a note, writing it into the note's frontmatter.
   *
   * Called only once a reply has arrived, so merely opening or reading a note
   * never modifies it.
   *
   * @param file Note to mark.
   * @returns The new chat ID.
   */
  async assignChatId(file: TFile): Promise<string> {
    const existing = this.readChatId(file);
    if (existing) return existing;

    const chatId = crypto.randomUUID();

    // processFrontMatter is the supported way to edit frontmatter: it creates the
    // block when absent and leaves the rest of the note untouched.
    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      frontmatter[FRONTMATTER_KEY] = chatId;
    });

    return chatId;
  }
}
