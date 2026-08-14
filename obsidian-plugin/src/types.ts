/** Shared shapes used by the view, the store and every backend. */

/** Which backend a vault talks to. */
export type BackendId = 'chorus' | 'bedrock' | 'anthropic';

/** A single stored turn. */
export interface ChatMessage {
  role: 'user' | 'assistant';
  /**
   * What the user typed, or what the model replied.
   *
   * For a turn that carried an attached note, this holds the question only. The
   * note text is sent to the model but not stored locally, so the transcript stays
   * readable; with the proxy backend the server keeps the full message, so the
   * model still sees the note on later turns.
   */
  content: string;
  /** Prompt tokens billed. Absent on turns recorded before usage was tracked. */
  inputTokens?: number;
  /** Completion tokens billed. */
  outputTokens?: number;
  /** Vault path of a note attached to this turn, when there was one. */
  attachmentPath?: string;
  /** Characters of note text attached, for display. */
  attachmentChars?: number;
  /** Whether the attachment was a selection rather than a whole note. */
  attachmentIsSelection?: boolean;
  /** ISO timestamp, used only for display. */
  createdAt?: string;
}

/** What a backend is asked to do. */
export interface CompletionRequest {
  /** Full conversation, oldest first, including the new user turn. */
  messages: ChatMessage[];
  /** Optional system prompt. */
  systemPrompt: string;
  /** Hard cap on generated tokens. */
  maxTokens: number;
  /**
   * Called with each fragment of text as it arrives, when the backend can stream.
   *
   * Backends that cannot stream ignore this and resolve once with the whole
   * reply, so a caller must treat streaming as an optimisation rather than
   * something to depend on.
   */
  onDelta?: (text: string) => void;
}

/** What a backend returns. */
export interface CompletionResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * A chat backend.
 *
 * Implementations must not stream. Obsidian's `requestUrl` buffers the whole
 * response, and it is the only HTTP call that works on both desktop and mobile
 * while bypassing CORS, so every backend resolves once with the full reply.
 */
export interface Backend {
  /** Shown in the view's status line. */
  readonly label: string;
  /** Throws with a human-readable message on failure. */
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

/** Per-model rates for the indicative cost estimate, USD per million tokens. */
export interface Pricing {
  inputPerMillion: number;
  outputPerMillion: number;
}
