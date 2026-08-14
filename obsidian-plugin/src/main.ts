import { Plugin, type WorkspaceLeaf } from 'obsidian';

import { History } from './history';
import { NoteContext } from './noteContext';
import type { ConversationStore } from './providers/chorus';
import { ChorusSettingTab, DEFAULT_SETTINGS, type ChorusSettings } from './settings';
import { CHORUS_VIEW_TYPE, ChorusView } from './view';

/**
 * Chorus: one AI chat per vault.
 *
 * The single-chat constraint is intentional. A note-taking vault has one train of
 * thought, and keeping one transcript means no chat management UI, no orphaned
 * threads, and a transcript small enough to send as context every turn.
 */
export default class ChorusPlugin extends Plugin {
  settings: ChorusSettings = { ...DEFAULT_SETTINGS };
  history!: History;
  noteContext!: NoteContext;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.history = new History(this.app, this.manifest.dir ?? '');
    await this.history.load();

    // Must start tracking before the view opens: the chat panel cannot determine
    // the active note itself once focus is inside the sidebar.
    this.noteContext = new NoteContext(this.app);
    this.noteContext.track(this);

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
        for (const leaf of this.app.workspace.getLeavesOfType(CHORUS_VIEW_TYPE)) {
          const view = leaf.view;
          if (view instanceof ChorusView) void view.clear();
        }
      },
    });

    this.addSettingTab(new ChorusSettingTab(this.app, this));
  }

  /**
   * Reveals the chat, reusing the existing panel when there is one.
   *
   * This is what enforces one window per vault: a second leaf is never created.
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

  /** Lets the proxy backend persist its conversation ID in the history file. */
  conversationStore(): ConversationStore {
    return {
      get: () => this.history.conversationId,
      set: (conversationId: string) => this.history.setConversationId(conversationId),
    };
  }

  async loadSettings(): Promise<void> {
    // Spread over the defaults so a settings file written by an older version
    // gains new fields instead of leaving them undefined.
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);

    // The status line names the active model, so it goes stale on a config change.
    for (const leaf of this.app.workspace.getLeavesOfType(CHORUS_VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof ChorusView) view.refresh();
    }
  }
}
