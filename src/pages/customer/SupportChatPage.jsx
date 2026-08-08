import { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { supabase } from '../../lib/supabase';
import {
  getOrCreateConversation,
  getMessagesPage,
  sendMessage,
  escalateConversation,
  recordBotOutcome,
  CONVERSATION_STATUS,
  markAdminMessagesRead,
  getConversationState,
  isWithinReopenGrace,
} from '../../lib/database';
import { getBotReply, BOT_GREETING } from '../../lib/supportChatEngine';
import {
  Send, Bot, Loader, MessageSquare, AlertTriangle,
  RefreshCw, Clock, User, AlertCircle, CheckCircle2,
} from 'lucide-react';
import EmptyState from '../../components/ui/EmptyState';
import { useToast } from '../../hooks/useToast';
import { SkeletonChat } from '../../components/ui/SkeletonLoader';
import usePageTitle from '../../hooks/usePageTitle';

// Max ms to wait for chat to initialize before showing an error.
const LOAD_TIMEOUT_MS = 15000;
const MAX_MESSAGE_LENGTH = 1000;
const TEXTAREA_BASE_HEIGHT = 48;
const MESSAGES_PAGE_SIZE = 50;

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// Welcome-back greeting (shown when customer returns to a CLOSED conversation)
const BOT_WELCOME_BACK = `Welcome back! 👋

I'm CargoExpress Assistant.

How can I help you today?`;

const normalizeError = (err) => {
  const msg = err?.message || String(err || '');
  if (msg.includes('PGRST116') || msg.includes('0 rows')) return 'Could not find or create your chat conversation. Please try again.';
  if (msg.includes('JWT') || msg.toLowerCase().includes('unauthorized')) return 'Your session has expired. Please refresh the page and log in again.';
  if (msg.toLowerCase().includes('network') || msg.toLowerCase().includes('failed to fetch')) return 'Network error. Please check your internet connection and try again.';
  if (msg.toLowerCase().includes('timeout') || msg.includes('AbortError')) return 'The request timed out. Please try again.';
  return msg || 'Failed to load chat. Please try again.';
};

const formatTime = (ts) => {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit', hour12: true });
};

// ── Message bubble ─────────────────────────────────────────────────────────────
const MessageBubble = ({ m, showResolutionPrompt, onResolve, onEscalate, onRetry, onDiscard, actionsDisabled }) => {
  const isMe    = m.sender_role === 'customer';
  const isBot   = m.sender_role === 'bot';

  const resolvedAdminName = 'Admin';

  return (
    <div className={`support-message-row ${isMe ? 'is-me' : 'is-admin'}`}>
      {!isMe && (
        <div className={`chat-avatar ${isBot ? 'bot-avatar' : 'admin-avatar'}`}>
          {isBot ? <Bot size={12} /> : <User size={12} />}
        </div>
      )}
      <div className="support-message-stack">
        {isBot && <div className="chat-sender-label bot-label"><Bot size={11} aria-hidden="true" /> CargoExpress Assistant</div>}
        {m.sender_role === 'admin' && <div className="chat-sender-label admin-label"><User size={11} aria-hidden="true" /> {resolvedAdminName}</div>}

        <div className={`support-message-bubble ${isMe ? 'user-bubble' : isBot ? 'bot-bubble' : 'admin-bubble'}${m.failed ? ' is-failed' : ''}`}>
          {m.message.split('\n').map((line, j, arr) => (
            <span key={j}>{line}{j < arr.length - 1 && <br />}</span>
          ))}
        </div>
        {m.failed ? (
          <div className="chat-msg-failed-actions" role="alert">
            <AlertCircle size={11} aria-hidden="true" />
            <span>Not sent</span>
            <button type="button" onClick={() => onRetry(m)} disabled={actionsDisabled}>Retry</button>
            <span aria-hidden="true">·</span>
            <button type="button" onClick={() => onDiscard(m)} disabled={actionsDisabled}>Discard</button>
          </div>
        ) : (
          <div className={`chat-timestamp ${isMe ? 'text-right' : ''}`}>{formatTime(m.created_at)}</div>
        )}

        {/* Both actions are named for what they DO. The thumbs-up/down pair
            that used to live here asked the customer to rate the bot, and the
            only route to a human was hidden behind the 👎 — someone who
            urgently needs a person has no reason to guess that rating the
            answer poorly is what summons one. */}
        {isBot && showResolutionPrompt && (
          <div className="chat-resolution">
            <button
              type="button"
              className="chat-resolution-btn is-resolve"
              onClick={onResolve}
              disabled={actionsDisabled}
            >
              Yes, this helped
            </button>
            <button
              type="button"
              className="chat-resolution-btn is-escalate"
              onClick={onEscalate}
              disabled={actionsDisabled}
            >
              Talk to an Agent
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

// ── Main component ─────────────────────────────────────────────────────────────
const SupportChatPage = () => {
  usePageTitle('Support Chat');
  const { user } = useAuth();
  const toast = useToast();

  const [conversationId, setConversationId] = useState(null);
  const [convStatus, setConvStatus] = useState(CONVERSATION_STATUS.BOT_ACTIVE);
  // Drives only the wording of the resolved banner/placeholder — see the note
  // on REOPEN_GRACE_MS. The trigger owns the routing.
  const [resolvedAt, setResolvedAt] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sending, setSending] = useState(false);
  const [botTyping, setBotTyping] = useState(false);
  const [textareaHeight, setTextareaHeight] = useState(48);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);

  // true = chatbot is responding; false = admin live chat mode
  const [isBotMode, setIsBotMode] = useState(false);

  // ID of the last bot message awaiting a Yes/No answer
  const [pendingResolutionId, setPendingResolutionId] = useState(null);

  const messagesEndRef = useRef(null);
  const messagesContainerRef = useRef(null);
  const textareaRef    = useRef(null);
  const timeoutRef     = useRef(null);
  const isMountedRef   = useRef(true);
  const channelRef     = useRef(null);
  const nearBottomRef  = useRef(true);
  const forceScrollRef = useRef(false);
  const initialScrollPendingRef = useRef(false);
  const failedSeqRef   = useRef(0);

  const clearLoadTimeout = useCallback(() => {
    if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
  }, []);

  // ── Insert a bot message into the database ────────────────────────────────
  // sender_id = customer UUID; DB guard trigger preserves sender_role = 'bot'
  const insertBotMessage = useCallback(async (text, convId) => {
    if (!user?.id || !convId) return null;
    try {
      return await sendMessage(convId, user.id, 'bot', text);
    } catch (err) {
      console.warn('[Bot] insertBotMessage failed:', err.message);
      return null;
    }
  }, [user?.id]);

  // ── Init chat ──────────────────────────────────────────────────────────────
  //
  // Conversation lifecycle routing (status-based, NOT message-count-based):
  //
  //   Case A — no conversation exists → create (status='bot_active') → bot greets
  //   Case B — status = 'bot_active' → bot takes over
  //   Case C — 'waiting' | 'waiting_customer' | 'resolved' → no bot
  //
  // 'resolved' splits on the 12-hour grace window (20260807120000), because
  // conversations is UNIQUE per customer — that one row is both "the ticket you
  // just closed" and "every question this person will ever ask":
  //
  //   resolved ≤12h ago  → human mode. A follow-up must not be answered by a
  //                        bot that cannot see the thread it is continuing,
  //                        with the admin never told the customer came back.
  //   resolved >12h ago  → bot mode. A new question weeks later should not
  //                        queue for an admin because of a closed ticket.
  //
  // The window here only phrases the UI. Which one actually happens is decided
  // by the trigger and read back after the message is sent.
  //
  const greetingSentRef = useRef(false);

  const initChat = useCallback(async () => {
    if (!user?.id) return;

    setError(null);
    setLoading(true);
    setConversationId(null);
    setMessages([]);
    setPendingResolutionId(null);
    setIsBotMode(false);
    setHasMoreMessages(false);
    initialScrollPendingRef.current = true;

    clearLoadTimeout();
    timeoutRef.current = setTimeout(() => {
      if (isMountedRef.current) {
        setLoading(false);
        setError('Loading took too long. Please check your connection and try again.');
      }
    }, LOAD_TIMEOUT_MS);

    try {
      const conv = await getOrCreateConversation(user.id);
      const { messages: history, hasMore } = await getMessagesPage(conv.id, { limit: MESSAGES_PAGE_SIZE });

      clearLoadTimeout();
      if (!isMountedRef.current) return;

      const status = conv.status || CONVERSATION_STATUS.BOT_ACTIVE;
      // A resolved thread outside the grace window behaves as a fresh bot chat:
      // the customer's next message starts a new session server-side, so the UI
      // must not promise them an agent.
      const isStaleResolved =
        status === CONVERSATION_STATUS.RESOLVED && !isWithinReopenGrace(conv);

      setConversationId(conv.id);
      setConvStatus(status);
      setResolvedAt(conv.resolved_at || null);
      setHasMoreMessages(hasMore);

      // ── Route by status ──────────────────────────────────────────────────
      if (status === CONVERSATION_STATUS.BOT_ACTIVE || isStaleResolved) {
        // BOT MODE: chatbot is the first responder
        setIsBotMode(true);

        const hasHistory = history && history.length > 0;
        const lastMessage = hasHistory ? history[history.length - 1] : null;
        const isLastMessageGreeting = lastMessage && (lastMessage.message === BOT_GREETING || lastMessage.message === BOT_WELCOME_BACK);

        // Always show historical messages so the customer can scroll up
        setMessages(history || []);

        // Send appropriate greeting into the DB and append to view,
        // avoiding duplicates caused by React StrictMode or concurrent runs.
        if (!isLastMessageGreeting && !greetingSentRef.current) {
          greetingSentRef.current = true;
          const greetingText = hasHistory ? BOT_WELCOME_BACK : BOT_GREETING;
          const greetingMsg  = await insertBotMessage(greetingText, conv.id);
          if (greetingMsg && isMountedRef.current) {
            setMessages(prev =>
              prev.some(m => m.id === greetingMsg.id) ? prev : [...prev, greetingMsg]
            );
          }
        }
      } else {
        // HUMAN MODE: waiting / waiting_customer / recently resolved — a person
        // owns this thread. History is displayed as-is and no bot greeting is
        // injected; for a resolved thread the banner and the composer
        // placeholder say that replying reopens it.
        setIsBotMode(false);
        setMessages(history || []);
      }

      setLoading(false);

      // Mark admin messages as read now that the customer is viewing the chat
      if (document.visibilityState === 'visible') {
        markAdminMessagesRead(conv.id).catch(() => {});
      }
    } catch (err) {
      clearLoadTimeout();
      if (isMountedRef.current) {
        const friendly = normalizeError(err);
        setError(friendly);
        setLoading(false);
        toast.error(friendly);
      }
    }
  }, [user?.id, clearLoadTimeout, toast, insertBotMessage]);

  useEffect(() => {
    isMountedRef.current = true;
    if (user?.id) initChat();
    return () => {
      isMountedRef.current = false;
      clearLoadTimeout();
    };
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Realtime — new messages ────────────────────────────────────────────────
  useEffect(() => {
    if (!conversationId) return;
    if (channelRef.current) { supabase.removeChannel(channelRef.current); channelRef.current = null; }

    const channel = supabase.channel(`chat_hybrid_${conversationId}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'chat_messages',
        filter: `conversation_id=eq.${conversationId}`,
      }, (payload) => {
        if (!isMountedRef.current) return;
        setMessages(prev =>
          prev.some(m => m.id === payload.new.id) ? prev : [...prev, payload.new]
        );
        // New admin reply while the customer is actively viewing → mark read
        if (payload.new.sender_role === 'admin' && document.visibilityState === 'visible') {
          markAdminMessagesRead(conversationId).catch(() => {});
        }
      })
      // Listen for admin assigning / closing the conversation
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'conversations',
        filter: `id=eq.${conversationId}`,
      }, (payload) => {
        if (!isMountedRef.current) return;
        const newStatus = payload.new.status || CONVERSATION_STATUS.BOT_ACTIVE;
        setConvStatus(newStatus);
        // Starts the grace window when an admin resolves while the customer is
        // watching, so the banner they see next is the follow-up one.
        setResolvedAt(payload.new.resolved_at || null);
        // Only 'bot_active' leaves the bot in charge. An admin resolving the
        // thread while the customer is watching must NOT drop them back into
        // bot mode — the subtitle would claim the assistant is ready to help
        // and the next reply would be answered by a bot that cannot see the
        // conversation it is continuing.
        if (newStatus !== CONVERSATION_STATUS.BOT_ACTIVE) {
          setIsBotMode(false);
          setPendingResolutionId(null);
        }
      })
      .subscribe();

    channelRef.current = channel;

    // When the customer returns to this tab, mark any admin replies as read
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        markAdminMessagesRead(conversationId).catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      supabase.removeChannel(channel);
      channelRef.current = null;
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [conversationId]);

  const scrollToEnd = (smooth) => {
    messagesEndRef.current?.scrollIntoView({ behavior: smooth && !prefersReducedMotion() ? 'smooth' : 'auto' });
  };

  // Auto-scroll: instant on open; afterwards only when the customer is near the
  // bottom or just sent a message (respects prefers-reduced-motion)
  useEffect(() => {
    if (messages.length === 0 && !botTyping) return;
    if (initialScrollPendingRef.current) {
      initialScrollPendingRef.current = false;
      nearBottomRef.current = true;
      scrollToEnd(false);
      return;
    }
    if (forceScrollRef.current || nearBottomRef.current) {
      forceScrollRef.current = false;
      scrollToEnd(true);
    }
  }, [messages, botTyping]);

  const handleMessagesScroll = () => {
    const el = messagesContainerRef.current;
    if (!el) return;
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  // ── Load older messages (pagination) ───────────────────────────────────────
  const handleLoadOlder = async () => {
    if (!conversationId || loadingOlder || !hasMoreMessages || messages.length === 0) return;
    setLoadingOlder(true);
    const el = messagesContainerRef.current;
    const prevHeight = el ? el.scrollHeight : 0;
    const prevTop = el ? el.scrollTop : 0;
    try {
      const oldest = messages.find(m => !m.failed);
      const { messages: older, hasMore } = await getMessagesPage(conversationId, {
        limit: MESSAGES_PAGE_SIZE,
        before: oldest?.created_at,
      });
      setMessages(prev => {
        const ids = new Set(prev.map(m => m.id));
        const fresh = (older || []).filter(m => !ids.has(m.id));
        return [...fresh, ...prev];
      });
      setHasMoreMessages(hasMore);
      // Keep the viewport anchored on the message the customer was reading
      requestAnimationFrame(() => {
        if (el) el.scrollTop = prevTop + (el.scrollHeight - prevHeight);
      });
    } catch {
      toast.error('Failed to load earlier messages.');
    } finally {
      setLoadingOlder(false);
    }
  };

  // ── Send ───────────────────────────────────────────────────────────────────
  const makeFailedMessage = (text) => ({
    id: `failed-${++failedSeqRef.current}`,
    conversation_id: conversationId,
    sender_id: user?.id,
    sender_role: 'customer',
    message: text,
    created_at: new Date().toISOString(),
    failed: true,
  });

  const sendCustomerText = async (text) => {
    if (!text || !conversationId || !user) return;
    setSending(true);
    setPendingResolutionId(null);

    // 1. Store the customer's message — on failure keep a retryable bubble
    try {
      const customerMsg = await sendMessage(conversationId, user.id, 'customer', text);
      forceScrollRef.current = true;
      setMessages(prev =>
        prev.some(m => m.id === customerMsg.id) ? prev : [...prev, customerMsg]
      );
    } catch (err) {
      console.error('[SupportChat] Failed to send message:', err);
      forceScrollRef.current = true;
      setMessages(prev => [...prev, makeFailedMessage(text)]);
      setSending(false);
      toast.error('Message not sent. Tap Retry on the message to try again.');
      return;
    }

    // 2. The message just landed on a RESOLVED thread, so the trigger has
    //    already routed it: 'waiting' if it was resolved inside the 12-hour
    //    grace window (a follow-up, back to the admin who handled it), or
    //    'bot_active' if it was resolved longer ago (a new session).
    //
    //    We ASK the server which happened rather than recomputing the window
    //    here. The two clocks can disagree by seconds near the boundary, and
    //    each way of being wrong strands someone: run the bot on a thread the
    //    server queued and an admin answers a question already answered; skip
    //    the bot on a thread the server left in 'bot_active' and the customer
    //    gets no reply at all while no admin is coming.
    // Local, not the isBotMode state: a setState in this function is not
    // visible to the checks below it in the same closure.
    let botHandlesThisMessage = isBotMode;

    if (convStatus === CONVERSATION_STATUS.RESOLVED) {
      let routedStatus = CONVERSATION_STATUS.WAITING;
      try {
        const state = await getConversationState(conversationId);
        if (state?.status) routedStatus = state.status;
        setResolvedAt(state?.resolved_at || null);
      } catch (err) {
        // Fall back to the reopen branch: waiting for a person is recoverable,
        // silence is not.
        console.warn('[SupportChat] Could not read routed status:', err?.message || err);
      }

      setConvStatus(routedStatus);

      if (routedStatus !== CONVERSATION_STATUS.BOT_ACTIVE) {
        // Reopened to a human. Nothing to PATCH — the trigger has already put
        // the thread back in the shared admin queue; this only catches local
        // state up so the banner appears without waiting for the realtime
        // UPDATE.
        setIsBotMode(false);
        setSending(false);
        return;
      }

      // New bot session on an old resolved thread — fall through to the bot.
      setIsBotMode(true);
      botHandlesThisMessage = true;
    }

    // 3. If NOT in bot mode → admin is handling, nothing more to do
    if (!botHandlesThisMessage) {
      setSending(false);
      return;
    }

    // 4. Bot processes the message — a bot failure is non-fatal (toast only)
    setBotTyping(true);
    setSending(false);

    try {
      const reply = await getBotReply(text, user.id);
      await new Promise(r => setTimeout(r, 700 + Math.random() * 400));
      if (!isMountedRef.current) return;
      setBotTyping(false);

      if (reply.escalate) {
        // Smart escalation keyword — skip bot reply, go straight to admin
        const escText = `I understand you need more specific assistance.\n\nPlease wait while I connect you with one of our support administrators. 🔄`;
        const escMsg = await insertBotMessage(escText, conversationId);
        if (escMsg) setMessages(prev => prev.some(m => m.id === escMsg.id) ? prev : [...prev, escMsg]);
        await escalateConversation(conversationId);
        setConvStatus(CONVERSATION_STATUS.WAITING);
        setIsBotMode(false);
      } else {
        // Normal bot reply
        const botMsg = await insertBotMessage(reply.text, conversationId);
        if (botMsg && isMountedRef.current) {
          setMessages(prev => prev.some(m => m.id === botMsg.id) ? prev : [...prev, botMsg]);
          if (reply.askResolved) setPendingResolutionId(botMsg.id);
        }
      }
    } catch (err) {
      console.error('[SupportChat] Bot reply failed:', err);
      if (isMountedRef.current) {
        setBotTyping(false);
        toast.error('The assistant is unavailable right now. Please try again.');
      }
    }
  };

  const handleSend = () => {
    const text = input.trim();
    if (!text || !conversationId || !user || sending || botTyping) return;

    setInput('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    setTextareaHeight(TEXTAREA_BASE_HEIGHT);
    sendCustomerText(text);
  };

  const handleRetryMessage = (failedMsg) => {
    if (sending || botTyping) return;
    setMessages(prev => prev.filter(m => m.id !== failedMsg.id));
    sendCustomerText(failedMsg.message);
  };

  const handleDiscardMessage = (failedMsg) => {
    setMessages(prev => prev.filter(m => m.id !== failedMsg.id));
  };

  // ── Resolution — Yes ───────────────────────────────────────────────────────
  // Conversation stays bot-handled — the bot answered successfully.
  const handleResolvedYes = async () => {
    setPendingResolutionId(null);
    // The deflection signal. Without it a bot-answered thread and an
    // abandoned one look identical in the data. Non-blocking: a failed
    // write must never cost the customer their reply.
    void recordBotOutcome(conversationId, true).catch(() => {});
    const msg = await insertBotMessage(
      `Thank you for contacting CargoExpress PH! 😊\n\nHave a great day! If you have another concern in the future, feel free to message us anytime.`,
      conversationId
    );
    if (msg) setMessages(prev => prev.some(m => m.id === msg.id) ? prev : [...prev, msg]);
    // Conversation status remains 'bot_active' — bot stays in control
  };

  // ── Resolution — No ────────────────────────────────────────────────────────
  // Escalate to admin: flip status to 'waiting' and raise the escalated flag
  const handleResolvedNo = async () => {
    setPendingResolutionId(null);
    void recordBotOutcome(conversationId, false).catch(() => {});
    const escMsg = await insertBotMessage(
      `Thank you. I wasn't able to fully resolve your concern. 🙏\n\nPlease wait while one of our administrators assists you.`,
      conversationId
    );
    if (escMsg) setMessages(prev => prev.some(m => m.id === escMsg.id) ? prev : [...prev, escMsg]);
    try {
      await escalateConversation(conversationId);
      setConvStatus(CONVERSATION_STATUS.WAITING);
      setIsBotMode(false);
    } catch {
      toast.error('Failed to connect to admin. Please try again.');
    }
  };

  // ── Loading / error states ─────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="page-transition support-chat-page" role="status" aria-live="polite" aria-busy="true">
        <span className="sr-only">Loading support chat...</span>
        <SkeletonChat />
      </div>
    );
  }

  if (error) {
    return (
      <div className="page-transition support-chat-page">
        <h1 className="sr-only">Support Chat</h1>
        <div className="mb-16">
          <h2 className="fw-800 mb-4 flex items-center gap-8">
            <MessageSquare size={22} color="var(--primary)" />
            Support Chat
          </h2>
          <p className="text-secondary text-sm">Message our support team for help with your shipments.</p>
        </div>
        <div className="card animate-scale-in text-center" role="alert" style={{ padding: 40 }}>
          <div className="flex items-center justify-center mx-auto mb-16"
            style={{ width: 56, height: 56, borderRadius: '50%', background: 'var(--error-bg)' }}>
            <AlertTriangle size={28} color="var(--error)" aria-hidden="true" />
          </div>
          <h3 className="mb-8" style={{ color: 'var(--error-dark)' }}>Unable to Load Chat</h3>
          <p className="text-secondary text-sm mb-20">{error}</p>
          <button className="btn btn-primary flex items-center gap-8 mx-auto" onClick={initChat}>
            <RefreshCw size={16} /> Try Again
          </button>
        </div>
      </div>
    );
  }

  // ── Chat UI ────────────────────────────────────────────────────────────────
  const isWaiting   = convStatus === CONVERSATION_STATUS.WAITING;
  // Only a RECENTLY resolved thread advertises the reopen. Past the grace
  // window the next message starts a fresh bot session, and a banner promising
  // the support team would be a promise the trigger will not keep.
  const isResolved  = convStatus === CONVERSATION_STATUS.RESOLVED &&
                      isWithinReopenGrace({ resolved_at: resolvedAt });
  // Keep waiting-admin conversations writable so customers can leave details while they wait.
  // A resolved thread stays writable too — that reply is how it reopens.
  const inputDisabled = sending || botTyping;

  return (
    <div className="support-chat-page page-transition">
      {/* Header */}
      <h1 className="sr-only">Support Chat</h1>
      <div className="mb-16">
        <h2 className="fw-800 mb-4 flex items-center gap-8">
          <MessageSquare size={22} color="var(--primary)" />
          Support Chat
        </h2>
        <p className="text-secondary text-sm">
          {isResolved
            ? 'This conversation was marked resolved by our support team.'
            : isBotMode
              ? 'Our virtual assistant is ready to help you 24/7.'
              : 'You are connected to our support team.'}
        </p>
      </div>

      {/* Waiting for admin banner (shown after escalation) */}
      {isWaiting && (
        <div className="chat-waiting-banner" role="status">
          <Clock size={16} />
          <span>Connecting you to a support agent. You can keep adding details here while you wait.</span>
        </div>
      )}

      {/* Resolved banner. Says what replying will DO, because the composer stays
          enabled and a resolved thread that silently accepts messages is how the
          customer ended up talking to nobody. */}
      {isResolved && (
        <div className="chat-resolved-banner" role="status">
          <CheckCircle2 size={16} aria-hidden="true" />
          <span>This conversation was resolved. Replying will reopen it and bring back our support team.</span>
        </div>
      )}

      {/* Messages area */}
      <div
        className="support-chat-messages"
        ref={messagesContainerRef}
        onScroll={handleMessagesScroll}
        role="log"
        aria-live="polite"
        aria-label="Support chat messages"
      >
        {messages.length === 0 && !botTyping && (
          <EmptyState
            icon={MessageSquare}
            title="No Messages Yet"
            description="Send a message to start chatting with our support team!"
          />
        )}

        {hasMoreMessages && messages.length > 0 && (
          <div className="support-load-older">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={handleLoadOlder}
              disabled={loadingOlder}
            >
              {loadingOlder
                ? <Loader size={14} className="animate-spin" aria-hidden="true" />
                : 'Load earlier messages'}
            </button>
          </div>
        )}

        {messages.map((m, i) => {
          const showTimestamp =
            i === 0 ||
            (messages[i - 1] && (new Date(m.created_at) - new Date(messages[i - 1].created_at)) > 300000);
          const isLastBotWithPrompt = m.sender_role === 'bot' && m.id === pendingResolutionId;

          return (
            <div key={m.id}>
              {showTimestamp && (
                <div className="text-center mt-12 mb-8 text-tertiary fw-600" style={{ fontSize: '0.6875rem' }}>
                  {new Date(m.created_at).toLocaleDateString('en-PH', { month: 'short', day: 'numeric' })} · {formatTime(m.created_at)}
                </div>
              )}
              <MessageBubble
                m={m}
                showResolutionPrompt={isLastBotWithPrompt}
                onResolve={handleResolvedYes}
                onEscalate={handleResolvedNo}
                onRetry={handleRetryMessage}
                onDiscard={handleDiscardMessage}
                actionsDisabled={sending || botTyping}
              />
            </div>
          );
        })}

        {/* Bot typing indicator */}
        {botTyping && (
          <div className="support-message-row is-admin" role="status" aria-label="Assistant is typing">
            <div className="chat-avatar bot-avatar"><Bot size={12} /></div>
            <div className="support-message-stack">
              <div className="chat-sender-label bot-label"><Bot size={11} aria-hidden="true" /> CargoExpress Assistant</div>
              <div className="chat-typing-dots"><span /><span /><span /></div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div
        className="flex gap-8 items-end"
        style={{
          borderRadius: 24,
        }}
      >
        <textarea
          ref={textareaRef}
          className="form-input flex-1"
          placeholder={
            isWaiting  ? 'Leave more details for the support agent...' :
            isResolved ? 'Reply to reopen this conversation…' :
            botTyping  ? 'Assistant is typing…' :
            isBotMode  ? 'Ask me anything about your shipment…' :
                         'Type your message…'
          }
          aria-label="Type your support message"
          maxLength={MAX_MESSAGE_LENGTH}
          value={input}
          onChange={e => {
            const nextValue = e.target.value;
            setInput(nextValue);
            if (!nextValue.trim()) {
              e.target.style.height = `${TEXTAREA_BASE_HEIGHT}px`;
              setTextareaHeight(TEXTAREA_BASE_HEIGHT);
              return;
            }
            e.target.style.height = `${TEXTAREA_BASE_HEIGHT}px`;
            const h = Math.min(Math.max(e.target.scrollHeight, TEXTAREA_BASE_HEIGHT), 120);
            e.target.style.height = `${h}px`;
            setTextareaHeight(h);
          }}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
          }}
          onFocus={() => {
            setTimeout(() => {
              scrollToEnd(true);
            }, 150);
          }}
          style={{
            borderRadius: 18,
            paddingLeft: 18, paddingRight: 18,
            paddingTop: 12,  paddingBottom: 12,
            resize: 'none',
            minHeight: '48px', maxHeight: '120px',
            lineHeight: '1.4', overflowY: 'auto',
            opacity: inputDisabled ? 0.6 : 1,
          }}
          rows={1}
          disabled={inputDisabled}
        />
        <button
          className="chat-send-btn"
          type="button"
          onClick={handleSend}
          disabled={!input.trim() || inputDisabled}
          aria-label={sending || botTyping ? 'Sending…' : 'Send message'}
          style={{ width: 44, height: 44, marginBottom: 2 }}
        >
          {sending || botTyping
            ? <Loader size={18} className="animate-spin" />
            : <Send size={18} />}
        </button>
      </div>
    </div>
  );
};

export default SupportChatPage;
