import type { App } from 'obsidian';

import type { ChatMessage } from './types';

/** On-disk shape of the vault's single transcript. */
interface HistoryFile {
  /** Chorus proxy conversation ID, empty for the other backends. */
  conversationId: string;
  messages: ChatMessage[];
}

const EMPTY: HistoryFile = { conversationId: '', messages: [] };

/**
 * The vault's one conversation.
 *
 * Kept in its own file rather than in `data.json` for two reasons: a transcript
 * grows without bound and would bloat the settings file, and a corrupt transcript
 * should never take the user's credentials down with it.
 */
export class History {
  private data: HistoryFile = { ...EMPTY, messages: [] };

  constructor(
    private readonly app: App,
    private readonly pluginDir: string,
  ) {}

  private get path(): string {
    return `${this.pluginDir}/history.json`;
  }

  /** Reads the transcript, tolerating a missing or damaged file. */
  async load(): Promise<void> {
    try {
      if (!(await this.app.vault.adapter.exists(this.path))) {
        this.data = { ...EMPTY, messages: [] };
        return;
      }
      const raw = await this.app.vault.adapter.read(this.path);
      const parsed = JSON.parse(raw) as Partial<HistoryFile>;
      this.data = {
        conversationId: typeof parsed.conversationId === 'string' ? parsed.conversationId : '',
        messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      };
    } catch {
      // A damaged transcript should not stop the plugin loading; start fresh
      // rather than throwing on every startup.
      this.data = { ...EMPTY, messages: [] };
    }
  }

  private async save(): Promise<void> {
    await this.app.vault.adapter.write(this.path, JSON.stringify(this.data, null, 2));
  }

  get messages(): ChatMessage[] {
    return this.data.messages;
  }

  get conversationId(): string {
    return this.data.conversationId;
  }

  async setConversationId(conversationId: string): Promise<void> {
    this.data.conversationId = conversationId;
    await this.save();
  }

  /** Appends a turn and persists immediately, so a crash cannot lose it. */
  async append(message: ChatMessage): Promise<void> {
    this.data.messages.push({ ...message, createdAt: new Date().toISOString() });
    await this.save();
  }

  /** Drops the last message. Used to roll back a user turn that got no reply. */
  async dropLast(): Promise<void> {
    this.data.messages.pop();
    await this.save();
  }

  /** Clears the transcript. The proxy conversation is reset too, so the server
   * side does not keep replaying a thread the user believes is gone. */
  async clear(): Promise<void> {
    this.data = { conversationId: '', messages: [] };
    await this.save();
  }
}
