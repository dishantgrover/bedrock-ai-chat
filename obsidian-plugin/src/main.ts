import { Plugin, type TFile, type WorkspaceLeaf } from 'obsidian';

import { ChatRegistry } from './chats';
import { Transcript } from './history';
import { NoteContext } from './noteContext';
import type { ConversationStore } from './providers/chorus';
import { ChorusSettingTab, DEFAULT_SETTINGS, type ChorusSettings } from './settings';
import { CHORUS_VIEW_TYPE, ChorusView } from './view';

/**
 * Chorus: an AI chat inside an Obsidian vault.
 *
 * A chat belongs either to a note or to the vault, depending on the `chatScope`
 * setting. Note-scoped chats are pointed to from the note's frontmatter, and are
 * created only once a reply has arrived, so browsing notes never leaves a trail of
 * empty conversations.
 */
export default class ChorusPlugin extends Plugin {
  settings: ChorusSettings = { ...DEFAULT_SETTINGS };
  chats!: ChatRegistry;
  noteContext!: NoteContext;

  /** Transcript currently shown in the panel. */
  transcript!: Transcript;
  /** Note the active transcript belongs to, or null for the vault chat. */
  activeFile: TFile | null = null;
  /** Chat ID of the active transcript, null while a note chat is unsaved. */
  activeChatId: string | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    const pluginDir = this.manifest.dir ?? '';
    this.chats = new ChatRegistry(this.app, pluginDir);

    // Must start tracking before the view opens: the chat panel cannot determine
    // the active note itself once focus is inside the sidebar.
    this.noteContext = new NoteContext(this.app);
    this.noteContext.track(this);

    this.transcript = new Transcript(this.app, this.chats.vaultTranscriptPath());
    await this.transcript.load();

    this.registerView(CHORUS_VIEW_TYPE, (leaf: WorkspaceLeaf) => new ChorusView(leaf, this));

    this.addRibbonIcon('message-circle', 'Open Chorus chat', () => void this.openChat());

    this.addCommand({
      id: 'open-chat',
      name: 'Open chat',
      callback: () => void this.openChat(),
    });

    this.addCommand({
      id: 'clear-chat',
      name: 'Clear chat',
      callback: () => {
        for (const view of this.views()) void view.clear();
      },
    });

    this.addSettingTab(new ChorusSettingTab(this.app, this));
  }

  /**
   * Reveals the chat, reusing the existing panel when there is one.
   *
   * This is what enforces one panel: a second leaf is never created.
   */
  async openChat(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(CHORUS_VIEW_TYPE);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }

    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;

    await leaf.setViewState({ type: CHORUS_VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  /** Open Chorus panels. */
  private views(): ChorusView[] {
    return this.app.workspace
      .getLeavesOfType(CHORUS_VIEW_TYPE)
      .map((leaf) => leaf.view)
      .filter((view): view is ChorusView => view instanceof ChorusView);
  }

  /**
   * Points the panel at the chat for a note, or at the vault chat.
   *
   * A note without a chat yet gets an unsaved transcript: real enough to hold a
   * turn, but with no file and no frontmatter written until a reply lands.
   *
   * @param file Note to switch to, or null for the vault chat.
   */
  async switchTo(file: TFile | null): Promise<void> {
    if (this.settings.chatScope === 'vault' || !file) {
      this.activeFile = null;
      this.activeChatId = null;
      this.transcript = new Transcript(this.app, this.chats.vaultTranscriptPath());
      await this.transcript.load();
      return;
    }

    const chatId = this.chats.readChatId(file);
    this.activeFile = file;
    this.activeChatId = chatId;
    this.transcript = new Transcript(
      this.app,
      chatId ? this.chats.chatTranscriptPath(chatId) : null,
    );
    await this.transcript.load();
  }

  /**
   * Gives the active note's chat a permanent home.
   *
   * Called after the first successful reply, which is what keeps chat creation
   * tied to sending a message rather than to opening a note.
   */
  async persistNoteChat(): Promise<void> {
    if (this.settings.chatScope !== 'note') return;
    if (!this.activeFile || this.activeChatId) return;

    const chatId = await this.chats.assignChatId(this.activeFile);
    this.activeChatId = chatId;
    await this.transcript.bind(this.chats.chatTranscriptPath(chatId));
  }

  /** Lets the proxy backend persist its conversation ID on the active chat. */
  conversationStore(): ConversationStore {
    return {
      get: () => this.transcript.conversationId,
      set: (conversationId: string) => this.transcript.setConversationId(conversationId),
    };
  }

  async loadSettings(): Promise<void> {
    // Spread over the defaults so a settings file written by an older version
    // gains new fields instead of leaving them undefined.
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);

    // The status line names the active model and the scope may have changed, so
    // open panels reload rather than showing stale state.
    for (const view of this.views()) void view.refresh();
  }
}
