import type { App } from 'obsidian';

import type { ChatMessage } from './types';

/** On-disk shape of one transcript. */
interface TranscriptData {
  /** Server-side conversation ID, empty for the non-proxy backends. */
  conversationId: string;
  messages: ChatMessage[];
}

/**
 * One conversation's transcript.
 *
 * A transcript can exist before it has a file. A chat for a note is only given
 * storage once the model has actually replied, so until then this holds the turn
 * in memory and `save` does nothing. `bind` supplies the path at that point.
 *
 * Kept out of `data.json` deliberately: transcripts grow without bound, and a
 * corrupt transcript should never take the user's settings with it.
 */
export class Transcript {
  private data: TranscriptData = { conversationId: '', messages: [] };

  constructor(
    private readonly app: App,
    private filePath: string | null,
  ) {}

  /** Reads the transcript, tolerating a missing or damaged file. */
  async load(): Promise<void> {
    this.data = { conversationId: '', messages: [] };
    if (!this.filePath) return;

    try {
      if (!(await this.app.vault.adapter.exists(this.filePath))) return;

      const raw = await this.app.vault.adapter.read(this.filePath);
      const parsed = JSON.parse(raw) as Partial<TranscriptData>;
      this.data = {
        conversationId:
          typeof parsed.conversationId === 'string' ? parsed.conversationId : '',
        messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      };
    } catch {
      // A damaged transcript must not stop the plugin loading, so start fresh
      // rather than throwing on every open.
      this.data = { conversationId: '', messages: [] };
    }
  }

  /** Gives an in-memory transcript a home and writes what it already holds. */
  async bind(filePath: string): Promise<void> {
    this.filePath = filePath;
    await this.save();
  }

  get hasFile(): boolean {
    return this.filePath !== null;
  }

  get messages(): ChatMessage[] {
    return this.data.messages;
  }

  get isEmpty(): boolean {
    return this.data.messages.length === 0;
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

  /** Drops the last message. Used to roll back a turn that got no reply. */
  async dropLast(): Promise<void> {
    this.data.messages.pop();
    await this.save();
  }

  /**
   * Empties the transcript.
   *
   * The server-side conversation is forgotten too, so the proxy backend starts a
   * new thread rather than continuing one the user believes is gone.
   */
  async clear(): Promise<void> {
    this.data = { conversationId: '', messages: [] };
    await this.save();
  }

  private async save(): Promise<void> {
    if (!this.filePath) return;

    // The chats directory does not exist until the first note-scoped chat is
    // created, so make sure of it before writing into it.
    const directory = this.filePath.slice(0, this.filePath.lastIndexOf('/'));
    if (directory && !(await this.app.vault.adapter.exists(directory))) {
      await this.app.vault.adapter.mkdir(directory);
    }

    await this.app.vault.adapter.write(
      this.filePath,
      JSON.stringify(this.data, null, 2),
    );
  }
}
