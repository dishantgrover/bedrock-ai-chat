import { useEffect, useRef } from 'react';

/** Cap the textarea growth so the message list stays usable on a phone. */
const MAX_TEXTAREA_HEIGHT = 200;

/**
 * Message input. Enter sends, Shift+Enter inserts a newline, and the textarea
 * grows with its content. While a reply streams, the send button becomes a stop
 * button.
 *
 * @param {Object} props
 * @param {string} props.value Current draft.
 * @param {(value: string) => void} props.onChange Draft change handler.
 * @param {() => void} props.onSend Submit the draft.
 * @param {() => void} props.onStop Abort the in-flight response.
 * @param {boolean} props.streaming Whether a reply is streaming.
 * @param {boolean} [props.disabled] Disable input entirely.
 */
export default function Composer({
  value,
  onChange,
  onSend,
  onStop,
  streaming,
  disabled = false,
}) {
  const textareaRef = useRef(null);

  useEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
  }, [value]);

  function handleKeyDown(event) {
    // Ignore Enter while an IME composition is active, otherwise submitting
    // would truncate characters mid-composition.
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (!streaming && value.trim()) {
        onSend();
      }
    }
  }

  return (
    <div
      className="border-t border-surface-border bg-surface-base px-3 pt-3"
      style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
    >
      <div className="mx-auto flex max-w-3xl items-end gap-2">
        <textarea
          ref={textareaRef}
          rows={1}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Send a message..."
          className="chat-scroll max-h-[200px] flex-1 resize-none rounded-2xl border border-surface-border bg-surface-raised px-4 py-3 leading-relaxed outline-none transition focus:border-zinc-500 disabled:opacity-50"
        />

        {streaming ? (
          <button
            type="button"
            onClick={onStop}
            aria-label="Stop generating"
            className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-zinc-700 transition hover:bg-zinc-600"
          >
            <span className="block h-3 w-3 rounded-[2px] bg-zinc-100" />
          </button>
        ) : (
          <button
            type="button"
            onClick={onSend}
            disabled={disabled || !value.trim()}
            aria-label="Send message"
            className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-zinc-100 text-zinc-900 transition hover:bg-white disabled:opacity-30"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          </button>
        )}
      </div>
      <p className="mx-auto mt-2 max-w-3xl text-center text-[11px] text-zinc-600">
        Models can make mistakes. Verify important information.
      </p>
    </div>
  );
}
