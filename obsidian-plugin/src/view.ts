import {
  ItemView,
  MarkdownRenderer,
  Notice,
  setIcon,
  type TFile,
  type WorkspaceLeaf,
} from 'obsidian';

import { approximateTokens, formatWithContext, type NoteAttachment } from './noteContext';
import { createBackend, pricingFor } from './providers';
import type { ChatMessage, Pricing } from './types';
import type ChorusPlugin from './main';

export const CHORUS_VIEW_TYPE = 'chorus-chat-view';

/** How long the copy button shows its confirmation state. */
const COPY_FEEDBACK_MS = 1500;

/**
 * Ceiling for a single outgoing message.
 *
 * The server rejects anything past 32,000 characters, so the attachment is capped
 * below that to leave room for the question and the wrapper text.
 */
const MAX_ATTACHMENT_CHARS = 28000;

/**
 * The chat panel.
 *
 * Turns are appended rather than re-rendered. A full rebuild would destroy any
 * text the user had selected mid-read, and re-parsing every prior reply's
 * Markdown on each turn gets slow on a long thread.
 */
export class ChorusView extends ItemView {
  private transcriptEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendButtonEl!: HTMLButtonElement;
  private statusEl!: HTMLElement;
  private attachRowEl!: HTMLElement;
  private scopeEl!: HTMLElement;
  private emptyEl: HTMLElement | null = null;
  private busy = false;
  /**
   * A note change that arrived mid-send.
   *
   * `undefined` means nothing is queued; `null` means the vault chat. Swapping
   * transcripts while a reply is streaming would attach it to the wrong chat.
   */
  private pendingSwitch: TFile | null | undefined;
  /** Cleared after each send, so a note is never resent without asking. */
  private attachment: NoteAttachment | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: ChorusPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return CHORUS_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Chorus';
  }

  getIcon(): string {
    return 'message-circle';
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass('chorus-view');

    this.scopeEl = root.createDiv({ cls: 'chorus-scope' });
    this.transcriptEl = root.createDiv({ cls: 'chorus-transcript' });

    const composer = root.createDiv({ cls: 'chorus-composer' });

    this.attachRowEl = composer.createDiv({ cls: 'chorus-attach-row' });
    this.renderAttachRow();

    this.inputEl = composer.createEl('textarea', {
      attr: { placeholder: 'Ask something. Enter to send, Shift+Enter for a new line.' },
    });

    const row = composer.createDiv({ cls: 'chorus-composer-row' });
    this.statusEl = row.createDiv({ cls: 'chorus-status' });

    const clearButton = row.createEl('button', { attr: { 'aria-label': 'Clear chat' } });
    setIcon(clearButton, 'trash-2');
    clearButton.onclick = () => void this.clear();

    this.sendButtonEl = row.createEl('button', { text: 'Send', cls: 'mod-cta' });
    this.sendButtonEl.onclick = () => void this.send();

    // Enter sends; Shift+Enter inserts a newline. IME composition must be left
    // alone or CJK input commits on the wrong keystroke.
    this.inputEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        void this.send();
      }
    });

    // Which note is attachable, and which chat is shown, both change as the user
    // moves around the vault.
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        this.renderAttachRow();
        void this.syncScope();
      }),
    );
    this.registerEvent(this.app.workspace.on('file-open', () => void this.syncScope()));
    // Obsidian raises no event for a selection changing, so the row is refreshed
    // when the user comes back to the composer, which is the moment before they
    // would reach for "Attach selection".
    this.inputEl.addEventListener('focus', () => this.renderAttachRow());

    await this.syncScope();
    await this.renderTranscript();
    this.renderScope();
    this.setStatus(this.describeBackend());
  }

  /**
   * Points the panel at whichever chat the active note owns.
   *
   * Does nothing when already on the right chat, so the workspace events that
   * fire for unrelated reasons are cheap.
   */
  private async syncScope(): Promise<void> {
    if (this.plugin.settings.chatScope !== 'note') {
      if (this.plugin.activeFile !== null) await this.switchTo(null);
      return;
    }

    const file = this.plugin.noteContext.file();
    if ((file?.path ?? null) === (this.plugin.activeFile?.path ?? null)) return;

    await this.switchTo(file);
  }

  /** Swaps the shown transcript, deferring if a reply is in flight. */
  private async switchTo(file: TFile | null): Promise<void> {
    if (this.busy) {
      this.pendingSwitch = file;
      return;
    }

    await this.plugin.switchTo(file);
    await this.renderTranscript();
    this.renderScope();
  }

  /** Names the chat on screen, so it is never ambiguous which one is open. */
  private renderScope(): void {
    this.scopeEl.empty();

    if (this.plugin.settings.chatScope !== 'note') {
      this.scopeEl.createSpan({ cls: 'chorus-scope-name', text: 'Vault chat' });
      return;
    }

    const file = this.plugin.activeFile;
    if (!file) {
      this.scopeEl.createSpan({ cls: 'chorus-scope-name', text: 'Vault chat' });
      this.scopeEl.createSpan({
        cls: 'chorus-scope-hint',
        text: 'no note open',
      });
      return;
    }

    this.scopeEl.createSpan({ cls: 'chorus-scope-name', text: file.basename });
    if (!this.plugin.activeChatId) {
      // Nothing has been written to the note yet, and nothing will be until a
      // reply arrives.
      this.scopeEl.createSpan({ cls: 'chorus-scope-hint', text: 'new chat' });
    }
  }

  /**
   * Draws the attach controls, or the chip describing what is already attached.
   *
   * Rebuilt rather than toggled because the buttons' availability depends on the
   * note the user is currently in, which changes underneath the panel.
   */
  private renderAttachRow(): void {
    this.attachRowEl.empty();

    if (this.attachment) {
      const chip = this.attachRowEl.createDiv({ cls: 'chorus-chip' });
      const tokens = approximateTokens(this.attachment.text);
      const scope = this.attachment.isSelection ? 'selection' : 'note';
      chip.createSpan({
        cls: 'chorus-chip-label',
        text: `${this.attachment.basename} · ${scope} · ~${tokens.toLocaleString()} tokens`,
      });

      if (this.attachment.truncated) {
        chip.createSpan({ cls: 'chorus-chip-warn', text: 'truncated' });
      }

      const remove = chip.createEl('button', {
        cls: 'chorus-chip-remove',
        attr: { 'aria-label': 'Remove attachment' },
      });
      setIcon(remove, 'x');
      remove.onclick = () => {
        this.attachment = null;
        this.renderAttachRow();
      };
      return;
    }

    const file = this.plugin.noteContext.file();
    if (!file) {
      this.attachRowEl.createSpan({
        cls: 'chorus-attach-hint',
        text: 'Open a note to attach it as context.',
      });
      return;
    }

    const noteButton = this.attachRowEl.createEl('button', {
      cls: 'chorus-attach-button',
      text: `Attach ${file.basename}`,
    });
    noteButton.onclick = () => void this.attachNote(false);

    const selectionButton = this.attachRowEl.createEl('button', {
      cls: 'chorus-attach-button',
      text: 'Attach selection',
    });
    selectionButton.disabled = !this.plugin.noteContext.hasSelection();
    selectionButton.onclick = () => void this.attachNote(true);
  }

  /** Captures the note or the current selection as context for the next message. */
  private async attachNote(selectionOnly: boolean): Promise<void> {
    const attachment = selectionOnly
      ? this.plugin.noteContext.selection(MAX_ATTACHMENT_CHARS)
      : await this.plugin.noteContext.wholeNote(MAX_ATTACHMENT_CHARS);

    if (!attachment) {
      new Notice(
        selectionOnly ? 'Nothing is selected in a note.' : 'No note is open to attach.',
      );
      return;
    }

    this.attachment = attachment;
    this.renderAttachRow();

    if (attachment.truncated) {
      new Notice(
        `That note is longer than the ${MAX_ATTACHMENT_CHARS.toLocaleString()} character limit, so it was cut short.`,
      );
    }
  }

  /** Full render. Used on open, after clearing, and on settings changes. */
  private async renderTranscript(): Promise<void> {
    this.transcriptEl.empty();
    this.emptyEl = null;

    const messages = this.plugin.transcript.messages;
    if (messages.length === 0) {
      this.showEmptyState();
      return;
    }

    for (const message of messages) {
      await this.renderTurn(message);
    }
    this.scrollToBottom();
  }

  private showEmptyState(): void {
    const noteScoped = this.plugin.settings.chatScope === 'note';
    const file = this.plugin.activeFile;

    const text =
      noteScoped && file
        ? `No messages yet. Sending one starts a chat for "${file.basename}".`
        : noteScoped
          ? 'No messages yet. Open a note to start a chat for it, or ask here for the vault chat.'
          : 'No messages yet. This vault keeps a single ongoing chat.';

    this.emptyEl = this.transcriptEl.createDiv({ cls: 'chorus-empty', text });
  }

  /** Appends one turn without touching the rest of the transcript. */
  private async appendTurn(message: ChatMessage): Promise<HTMLElement> {
    this.emptyEl?.remove();
    this.emptyEl = null;

    const element = await this.renderTurn(message);
    this.scrollToBottom();
    return element;
  }

  private async renderTurn(message: ChatMessage): Promise<HTMLElement> {
    if (message.role === 'user') {
      const turn = this.transcriptEl.createDiv({ cls: 'chorus-turn-user' });

      // The note text itself is not stored locally, so the turn shows what was
      // attached rather than reprinting the whole note in the transcript.
      if (message.attachmentPath) {
        const name = message.attachmentPath.split('/').pop() ?? message.attachmentPath;
        const scope = message.attachmentIsSelection ? 'selection' : 'note';
        turn.createDiv({
          cls: 'chorus-turn-attachment',
          text: `${name} · ${scope} · ${(message.attachmentChars ?? 0).toLocaleString()} chars`,
        });
      }

      turn.createDiv({ cls: 'chorus-turn-text', text: message.content });
      return turn;
    }

    const turn = this.transcriptEl.createDiv({ cls: 'chorus-turn-assistant' });
    const body = turn.createDiv();

    // Rendering through Obsidian means links, callouts and code blocks behave the
    // same as in a note. Awaited so the code blocks exist before they are
    // decorated with copy buttons.
    await MarkdownRenderer.render(this.app, message.content, body, '', this);

    this.addCodeBlockCopyButtons(body);
    this.renderTurnFooter(turn, message);
    return turn;
  }

  /**
   * Footer carrying the copy button and, optionally, token usage.
   *
   * Hidden until the turn is hovered, but its height is always reserved so
   * revealing it does not shift the transcript under the cursor.
   */
  private renderTurnFooter(turn: HTMLElement, message: ChatMessage): void {
    const footer = turn.createDiv({ cls: 'chorus-turn-footer' });

    const copyButton = footer.createEl('button', {
      cls: 'chorus-copy-button',
      attr: { 'aria-label': 'Copy reply' },
    });
    setIcon(copyButton, 'copy');
    copyButton.onclick = () => {
      // Copy the stored Markdown, not the rendered DOM: scraping text loses code
      // fences, list markers and table pipes.
      void this.copyToClipboard(message.content, copyButton, 'check');
    };

    if (!this.plugin.settings.showUsage) return;

    const inputTokens = message.inputTokens ?? 0;
    const outputTokens = message.outputTokens ?? 0;
    if (inputTokens === 0 && outputTokens === 0) return;

    const cost = estimateCost(inputTokens, outputTokens, pricingFor(this.plugin.settings));
    const parts = [
      `${inputTokens.toLocaleString()} in`,
      `${outputTokens.toLocaleString()} out`,
    ];
    if (cost) parts.push(`estimated cost ${cost}`);

    footer.createSpan({ cls: 'chorus-usage', text: parts.join(' · ') });
  }

  /**
   * Adds a copy button to each fenced code block.
   *
   * Obsidian's own renderer sometimes supplies one already, so an existing button
   * is left alone rather than duplicated.
   */
  private addCodeBlockCopyButtons(body: HTMLElement): void {
    body.querySelectorAll('pre').forEach((pre) => {
      if (pre.querySelector('.copy-code-button, .chorus-code-copy')) return;
      if (pre.parentElement?.hasClass('chorus-code-wrap')) return;

      // The button sits in a wrapper rather than inside <pre>, so its own label
      // is never included when the code is selected by hand.
      const wrapper = document.createElement('div');
      wrapper.className = 'chorus-code-wrap';
      pre.parentElement?.insertBefore(wrapper, pre);
      wrapper.appendChild(pre);

      const button = document.createElement('button');
      button.className = 'chorus-code-copy';
      button.textContent = 'Copy';
      button.onclick = () => {
        const code = pre.querySelector('code')?.textContent ?? pre.textContent ?? '';
        void this.copyToClipboard(code, button);
      };
      wrapper.appendChild(button);
    });
  }

  /**
   * Writes to the clipboard and confirms on the button itself.
   *
   * @param text Text to copy.
   * @param button Element to show feedback on.
   * @param icon Icon to swap in on success, for icon-only buttons.
   */
  private async copyToClipboard(
    text: string,
    button: HTMLElement,
    icon?: string,
  ): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      new Notice('Could not write to the clipboard.');
      return;
    }

    if (icon) {
      setIcon(button, icon);
      window.setTimeout(() => setIcon(button, 'copy'), COPY_FEEDBACK_MS);
      return;
    }

    const previous = button.textContent;
    button.textContent = 'Copied';
    window.setTimeout(() => {
      button.textContent = previous;
    }, COPY_FEEDBACK_MS);
  }

  private scrollToBottom(): void {
    this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
  }

  private setStatus(text: string, isError = false): void {
    this.statusEl.setText(text);
    this.statusEl.toggleClass('chorus-status-error', isError);
  }

  private describeBackend(): string {
    try {
      return createBackend(this.plugin.settings, this.plugin.conversationStore()).label;
    } catch (error) {
      return error instanceof Error ? error.message : 'Not configured.';
    }
  }

  /** Sends the composer contents and appends the reply. */
  private async send(): Promise<void> {
    if (this.busy) return;

    const content = this.inputEl.value.trim();
    if (!content) return;

    let backend;
    try {
      backend = createBackend(this.plugin.settings, this.plugin.conversationStore());
    } catch (error) {
      this.setStatus(error instanceof Error ? error.message : String(error), true);
      return;
    }

    this.setBusy(true);
    this.inputEl.value = '';

    // Taken now and cleared immediately: the note must not be resent silently on
    // the following turn, and the cost of attaching should stay explicit.
    const attachment = this.attachment;
    this.attachment = null;
    this.renderAttachRow();

    const sentContent = attachment ? formatWithContext(attachment, content) : content;

    // Show the user's turn straight away, but only persist it alongside a reply.
    // A failed turn otherwise leaves a question with no answer in the transcript.
    const userMessage: ChatMessage = {
      role: 'user',
      content,
      ...(attachment
        ? {
            attachmentPath: attachment.path,
            attachmentChars: attachment.text.length,
            attachmentIsSelection: attachment.isSelection,
          }
        : {}),
    };
    await this.plugin.transcript.append(userMessage);
    const userTurnEl = await this.appendTurn(userMessage);
    this.setStatus('Waiting for the model...');

    // Streaming text is shown as plain text with a caret, then replaced by the
    // rendered Markdown once complete. Re-parsing Markdown on every fragment
    // would be wasteful, and interleaved async renders can land out of order.
    const streamEl = this.transcriptEl.createDiv({ cls: 'chorus-turn-streaming' });
    let streamed = '';

    try {
      const result = await backend.complete({
        // The stored history carries the question only; the outgoing copy of the
        // latest turn carries the attached note too.
        messages: this.plugin.transcript.messages.map(({ role, content: text }, index, all) => ({
          role,
          content: index === all.length - 1 ? sentContent : text,
        })),
        systemPrompt: this.plugin.settings.systemPrompt,
        maxTokens: this.plugin.settings.maxTokens,
        onDelta: (text) => {
          if (!streamed) this.setStatus('Receiving...');
          streamed += text;
          streamEl.setText(streamed);
          this.scrollToBottom();
        },
      });

      if (!result.content) {
        throw new Error('The model returned an empty reply.');
      }

      const reply: ChatMessage = {
        role: 'assistant',
        content: result.content,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      };
      streamEl.remove();
      await this.plugin.transcript.append(reply);

      // The reply landed, so this chat has earned storage. Opening a note never
      // writes to it; only getting an answer does.
      await this.plugin.persistNoteChat();

      await this.appendTurn(reply);
      this.renderScope();
      this.setStatus(this.describeBackend());
    } catch (error) {
      // Roll the unanswered question back and hand the text to the composer, so
      // nothing typed is lost and the transcript stays coherent.
      streamEl.remove();
      await this.plugin.transcript.dropLast();
      userTurnEl.remove();
      if (this.plugin.transcript.messages.length === 0) {
        this.showEmptyState();
      }
      this.inputEl.value = content;
      this.setStatus(error instanceof Error ? error.message : String(error), true);
    } finally {
      this.setBusy(false);

      // Apply a note change that arrived while the reply was streaming.
      if (this.pendingSwitch !== undefined) {
        const target = this.pendingSwitch;
        this.pendingSwitch = undefined;
        await this.switchTo(target);
      }
    }
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.sendButtonEl.disabled = busy;
    this.sendButtonEl.setText(busy ? 'Sending' : 'Send');
    this.inputEl.disabled = busy;
  }

  /** Clears the vault's conversation. */
  async clear(): Promise<void> {
    if (this.plugin.transcript.messages.length === 0) return;
    await this.plugin.transcript.clear();
    await this.renderTranscript();
    this.setStatus(this.describeBackend());
    new Notice('Chorus chat cleared.');
  }

  /**
   * Called by the plugin when settings change.
   *
   * Re-resolves the scope as well as redrawing, because switching between
   * note-scoped and vault-wide chats changes which transcript should be open.
   */
  async refresh(): Promise<void> {
    await this.syncScope();
    await this.renderTranscript();
    this.renderScope();
    this.setStatus(this.describeBackend());
  }
}

/**
 * Indicative turn cost. Returns null below half a cent, since "~$0.00" reads as
 * broken rather than as cheap.
 */
function estimateCost(
  inputTokens: number,
  outputTokens: number,
  pricing: Pricing | null,
): string | null {
  if (!pricing) return null;

  const usd =
    (inputTokens / 1_000_000) * pricing.inputPerMillion +
    (outputTokens / 1_000_000) * pricing.outputPerMillion;

  if (usd < 0.005) return null;
  return `~$${usd.toFixed(2)}`;
}
