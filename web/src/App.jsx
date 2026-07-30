import { useCallback, useEffect, useRef, useState } from 'react';

import * as api from './api.js';
import { AuthExpiredError } from './api.js';
import { currentUser, initAuth, signOut } from './auth.js';
import { APP_NAME, APP_TAGLINE } from './branding.js';
import Composer from './components/Composer.jsx';
import Login from './components/Login.jsx';
import Logo from './components/Logo.jsx';
import Message from './components/Message.jsx';
import ModelPicker from './components/ModelPicker.jsx';
import Sidebar from './components/Sidebar.jsx';

/**
 * Application shell: owns auth state, the conversation list, the open thread and
 * the streaming lifecycle.
 */
export default function App() {
  const [config, setConfig] = useState(null);
  const [configError, setConfigError] = useState('');
  const [authed, setAuthed] = useState(false);
  const [me, setMe] = useState(null);

  const [conversations, setConversations] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [activeModelId, setActiveModelId] = useState(null);

  const [draft, setDraft] = useState('');
  const [streamingText, setStreamingText] = useState(null);
  const [error, setError] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [selectedModelId, setSelectedModelId] = useState(null);

  const abortRef = useRef(null);
  const scrollRef = useRef(null);
  const bottomRef = useRef(null);
  const pinnedToBottomRef = useRef(true);

  // Load public config, then decide whether an existing session already exists.
  useEffect(() => {
    api
      .fetchConfig()
      .then((loaded) => {
        initAuth(loaded);
        setConfig(loaded);
        setSelectedModelId(loaded.models.find((model) => model.default)?.id ?? loaded.models[0]?.id);
        setAuthed(Boolean(currentUser()));
      })
      .catch((caught) => setConfigError(caught.message));
  }, []);

  const handleAuthLoss = useCallback(() => {
    signOut();
    setAuthed(false);
    setMe(null);
    setConversations([]);
    setMessages([]);
    setActiveId(null);
  }, []);

  /** Wraps an API call so an expired session drops cleanly to the login screen. */
  const guarded = useCallback(
    async (work) => {
      try {
        return await work();
      } catch (caught) {
        if (caught instanceof AuthExpiredError) {
          handleAuthLoss();
          return undefined;
        }
        setError(caught.message);
        return undefined;
      }
    },
    [handleAuthLoss],
  );

  const refreshSidebar = useCallback(
    () =>
      guarded(async () => {
        const [list, profile] = await Promise.all([api.listConversations(), api.fetchMe()]);
        setConversations(list);
        setMe(profile);
      }),
    [guarded],
  );

  useEffect(() => {
    if (authed) {
      refreshSidebar();
    }
  }, [authed, refreshSidebar]);

  // Track whether the user is reading history; only auto-scroll when they are at
  // the bottom, so streaming does not yank them away from where they were.
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return undefined;

    function onScroll() {
      const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
      pinnedToBottomRef.current = distance < 80;
    }

    node.addEventListener('scroll', onScroll, { passive: true });
    return () => node.removeEventListener('scroll', onScroll);
  }, [activeId]);

  useEffect(() => {
    if (pinnedToBottomRef.current) {
      bottomRef.current?.scrollIntoView({ block: 'end' });
    }
  }, [messages, streamingText]);

  async function openConversation(id) {
    setSidebarOpen(false);
    setError('');
    const result = await guarded(() => api.getConversation(id));
    if (!result) return;
    setActiveId(id);
    setActiveModelId(result.conversation.modelId);
    setMessages(result.messages);
    pinnedToBottomRef.current = true;
  }

  function startNewChat() {
    setSidebarOpen(false);
    setActiveId(null);
    setActiveModelId(null);
    setMessages([]);
    setDraft('');
    setError('');
  }

  async function handleDelete(id) {
    const result = await guarded(() => api.deleteConversation(id));
    if (result === undefined && !authed) return;
    if (id === activeId) {
      startNewChat();
    }
    refreshSidebar();
  }

  async function handleSend() {
    const content = draft.trim();
    if (!content || streamingText !== null) return;

    setError('');
    setDraft('');

    // Create the conversation lazily on first send so an abandoned new-chat
    // screen does not leave empty threads in the sidebar.
    let conversationId = activeId;
    if (!conversationId) {
      const conversation = await guarded(() => api.createConversation(selectedModelId));
      if (!conversation) {
        setDraft(content);
        return;
      }
      conversationId = conversation.id;
      setActiveId(conversation.id);
      setActiveModelId(conversation.modelId);
    }

    setMessages((previous) => [...previous, { role: 'user', content }]);
    setStreamingText('');
    pinnedToBottomRef.current = true;

    const controller = new AbortController();
    abortRef.current = controller;

    let accumulated = '';

    try {
      await api.streamMessage({
        conversationId,
        content,
        signal: controller.signal,
        onDelta: (text) => {
          accumulated += text;
          setStreamingText(accumulated);
        },
        onError: (message) => setError(message),
      });
    } catch (caught) {
      if (caught instanceof AuthExpiredError) {
        handleAuthLoss();
        return;
      }
      // An abort is the user pressing stop, not a failure.
      if (caught.name !== 'AbortError') {
        setError(caught.message);
      }
    } finally {
      abortRef.current = null;
      setStreamingText(null);
      if (accumulated) {
        setMessages((previous) => [...previous, { role: 'assistant', content: accumulated }]);
      }
      refreshSidebar();
    }
  }

  function handleStop() {
    abortRef.current?.abort();
  }

  if (configError) {
    return (
      <div className="grid h-full place-items-center px-4 text-center">
        <div>
          <p className="text-sm text-red-400">{configError}</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-3 text-sm text-zinc-400 underline"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!config) {
    return <div className="grid h-full place-items-center text-sm text-zinc-500">Loading...</div>;
  }

  if (!authed) {
    return <Login onSignedIn={() => setAuthed(true)} />;
  }

  const activeModel = config.models.find((model) => model.id === activeModelId);
  const streaming = streamingText !== null;

  return (
    <div className="flex h-full">
      <Sidebar
        conversations={conversations}
        activeId={activeId}
        open={sidebarOpen}
        username={me?.user?.username ?? ''}
        usage={me?.usage ?? null}
        onClose={() => setSidebarOpen(false)}
        onNewChat={startNewChat}
        onSelect={openConversation}
        onDelete={handleDelete}
        onSignOut={handleAuthLoss}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        <header
          className="flex items-center gap-2 border-b border-surface-border px-3 py-2.5"
          style={{ paddingTop: 'max(0.625rem, env(safe-area-inset-top))' }}
        >
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open menu"
            className="rounded-lg p-2 text-zinc-400 transition hover:bg-zinc-800 md:hidden"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M3 6h18M3 12h18M3 18h18" />
            </svg>
          </button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-medium">
              {activeId
                ? conversations.find((item) => item.id === activeId)?.title || 'Chat'
                : `New chat`}
            </h1>
            {!activeModel && (
              <p className="truncate text-xs text-zinc-500 md:hidden">{APP_NAME}</p>
            )}
            {activeModel && (
              <p className="truncate text-xs text-zinc-500">{activeModel.label}</p>
            )}
          </div>
        </header>

        <div ref={scrollRef} className="chat-scroll flex-1 overflow-y-auto">
          {!activeId && messages.length === 0 ? (
            <div className="grid h-full place-items-center px-4 py-8">
              <div className="w-full max-w-md">
                <div className="mb-8 text-center">
                  <div className="mb-2 flex items-center justify-center gap-2 text-zinc-100">
                    <Logo size={28} />
                    <span className="text-2xl font-semibold tracking-tight">{APP_NAME}</span>
                  </div>
                  <p className="text-sm text-zinc-500">{APP_TAGLINE}</p>
                </div>
                <ModelPicker
                  models={config.models}
                  selectedId={selectedModelId}
                  onSelect={setSelectedModelId}
                />
              </div>
            </div>
          ) : (
            <div className="mx-auto max-w-3xl space-y-5 px-3 py-5">
              {messages.map((message, index) => (
                <Message
                  key={`${message.role}-${index}`}
                  role={message.role}
                  content={message.content}
                />
              ))}

              {streaming && (
                <Message role="assistant" content={streamingText} streaming />
              )}

              {error && (
                <p role="alert" className="rounded-lg bg-red-950/50 px-3 py-2 text-sm text-red-300">
                  {error}
                </p>
              )}

              <div ref={bottomRef} />
            </div>
          )}
        </div>

        <Composer
          value={draft}
          onChange={setDraft}
          onSend={handleSend}
          onStop={handleStop}
          streaming={streaming}
        />
      </main>
    </div>
  );
}
