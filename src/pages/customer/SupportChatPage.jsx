import { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { supabase } from '../../lib/supabase';
import {
  getOrCreateConversation,
  getMessages,
  sendMessage,
  setConversationWaitingAdmin,
} from '../../lib/database';
import { getBotReply, BOT_GREETING } from '../../lib/supportChatEngine';
import {
  Send, Bot, Loader, MessageSquare, AlertTriangle,
  RefreshCw, CheckCircle, XCircle, Clock, ShieldCheck, User,
} from 'lucide-react';
import EmptyState from '../../components/ui/EmptyState';
import { useToast } from '../../hooks/useToast';
import { SkeletonChat } from '../../components/ui/SkeletonLoader';
import usePageTitle from '../../hooks/usePageTitle';

// Max ms to wait for chat to initialize before showing an error.
const LOAD_TIMEOUT_MS = 15000;
const MAX_MESSAGE_LENGTH = 1000;
const TEXTAREA_BASE_HEIGHT = 48;

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
const MessageBubble = ({ m, showResolutionPrompt, onVoteYes, onVoteNo, adminName }) => {
  const isMe    = m.sender_role === 'customer';
  const isBot   = m.sender_role === 'bot';

  const resolvedAdminName = m.profiles?.name || adminName || 'Support Agent';

  return (
    <div className={`support-message-row ${isMe ? 'is-me' : 'is-admin'}`}>
      {!isMe && (
        <div className={`chat-avatar ${isBot ? 'bot-avatar' : 'admin-avatar'}`}>
          {isBot ? <Bot size={12} /> : <User size={12} />}
        </div>
      )}
      <div className="support-message-stack">
        {isBot && <div className="chat-sender-label bot-label">🤖 CargoExpress Assistant</div>}
        {m.sender_role === 'admin' && <div className="chat-sender-label admin-label">👤 {resolvedAdminName}</div>}

        <div className={`support-message-bubble ${isMe ? 'user-bubble' : isBot ? 'bot-bubble' : 'admin-bubble'}`}>
          {m.message.split('\n').map((line, j, arr) => (
            <span key={j}>{line}{j < arr.length - 1 && <br />}</span>
          ))}
        </div>
        <div className={`chat-timestamp ${isMe ? 'text-right' : ''}`}>{formatTime(m.created_at)}</div>

        {/* Yes / No resolution prompt */}
        {isBot && showResolutionPrompt && (
          <div className="chat-resolution-prompt">
            <span className="chat-resolution-text">Did I solve your concern?</span>
            <div className="chat-resolution-btns">
              <button className="chat-resolve-btn yes" onClick={onVoteYes}>
                <CheckCircle size={14} /> Yes
              </button>
              <button className="chat-resolve-btn no" onClick={onVoteNo}>
                <XCircle size={14} /> No
              </button>
            </div>
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
  const [convStatus, setConvStatus] = useState('closed');
  const [adminName, setAdminName] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sending, setSending] = useState(false);
  const [botTyping, setBotTyping] = useState(false);
  const [textareaHeight, setTextareaHeight] = useState(48);

  // true = chatbot is responding; false = admin live chat mode
  const [isBotMode, setIsBotMode] = useState(false);

  // ID of the last bot message awaiting a Yes/No answer
  const [pendingResolutionId, setPendingResolutionId] = useState(null);

  const messagesEndRef = useRef(null);
  const textareaRef    = useRef(null);
  const timeoutRef     = useRef(null);
  const isMountedRef   = useRef(true);
  const channelRef     = useRef(null);

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
  //   Case A — no conversation exists → create (status='closed') → bot greets
  //   Case B — status = 'closed'     → bot takes over, sends welcome-back msg
  //   Case C — status = 'open' | 'waiting_admin' → admin mode, no bot
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

    clearLoadTimeout();
    timeoutRef.current = setTimeout(() => {
      if (isMountedRef.current) {
        setLoading(false);
        setError('Loading took too long. Please check your connection and try again.');
      }
    }, LOAD_TIMEOUT_MS);

    try {
      const conv    = await getOrCreateConversation(user.id);
      const history = await getMessages(conv.id);

      clearLoadTimeout();
      if (!isMountedRef.current) return;

      const status = conv.status || 'open';
      setConversationId(conv.id);
      setConvStatus(status);
      if (conv.assigned_admin?.name) {
        setAdminName(conv.assigned_admin.name);
      }

      // ── Route by status ──────────────────────────────────────────────────
      if (status === 'closed') {
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
        // ADMIN MODE: status is 'open' or 'waiting_admin'
        // Admin is handling — display history, no bot responses
        setIsBotMode(false);
        setMessages(history || []);
      }

      setLoading(false);
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
      })
      // Listen for admin assigning / closing the conversation
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'conversations',
        filter: `id=eq.${conversationId}`,
      }, (payload) => {
        if (!isMountedRef.current) return;
        const newStatus = payload.new.status || 'open';
        setConvStatus(newStatus);
        // If admin opens the conversation (from waiting → open), switch to admin mode
        if (newStatus === 'open' || newStatus === 'waiting_admin') {
          setIsBotMode(false);
          setPendingResolutionId(null);
        }
      })
      .subscribe();

    channelRef.current = channel;
    return () => { supabase.removeChannel(channel); channelRef.current = null; };
  }, [conversationId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, botTyping]);

  // ── Send ───────────────────────────────────────────────────────────────────
  const handleSend = async () => {
    const text = input.trim();
    if (!text || !conversationId || !user || sending || botTyping) return;

    setInput('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    setTextareaHeight(48);
    setPendingResolutionId(null);
    setSending(true);

    try {
      // 1. Always store the customer's message
      const customerMsg = await sendMessage(conversationId, user.id, 'customer', text);
      setMessages(prev =>
        prev.some(m => m.id === customerMsg.id) ? prev : [...prev, customerMsg]
      );

      // 2. If NOT in bot mode → admin is handling, nothing more to do
      if (!isBotMode) {
        setSending(false);
        return;
      }

      // 3. Bot processes the message
      setBotTyping(true);
      setSending(false);

      const reply = await getBotReply(text, user.id);
      await new Promise(r => setTimeout(r, 700 + Math.random() * 400));
      if (!isMountedRef.current) return;
      setBotTyping(false);

      if (reply.escalate) {
        // Smart escalation keyword — skip bot reply, go straight to admin
        const escText = `I understand you need more specific assistance.\n\nPlease wait while I connect you with one of our support administrators. 🔄`;
        const escMsg = await insertBotMessage(escText, conversationId);
        if (escMsg) setMessages(prev => prev.some(m => m.id === escMsg.id) ? prev : [...prev, escMsg]);
        await setConversationWaitingAdmin(conversationId);
        setConvStatus('waiting_admin');
        setIsBotMode(false);
      } else {
        // Normal bot reply
        const botMsg = await insertBotMessage(reply.text, conversationId);
        if (botMsg && isMountedRef.current) {
          setMessages(prev => prev.some(m => m.id === botMsg.id) ? prev : [...prev, botMsg]);
          if (reply.askResolved) setPendingResolutionId(botMsg.id);
        }
      }
    } catch {
      setSending(false);
      setBotTyping(false);
      toast.error('Failed to send message. Please try again.');
      setInput(text);
    }
  };

  // ── Resolution — Yes ───────────────────────────────────────────────────────
  // Conversation stays CLOSED — bot handled everything successfully
  const handleResolvedYes = async () => {
    setPendingResolutionId(null);
    const msg = await insertBotMessage(
      `Thank you for contacting CargoExpress PH! 😊\n\nHave a great day! If you have another concern in the future, feel free to message us anytime.`,
      conversationId
    );
    if (msg) setMessages(prev => prev.some(m => m.id === msg.id) ? prev : [...prev, msg]);
    // Conversation status remains 'closed' — bot stays in control for future visits
  };

  // ── Resolution — No ────────────────────────────────────────────────────────
  // Escalate to admin: flip status to 'waiting_admin'
  const handleResolvedNo = async () => {
    setPendingResolutionId(null);
    const escMsg = await insertBotMessage(
      `Thank you. I wasn't able to fully resolve your concern. 🙏\n\nPlease wait while one of our administrators assists you.`,
      conversationId
    );
    if (escMsg) setMessages(prev => prev.some(m => m.id === escMsg.id) ? prev : [...prev, escMsg]);
    try {
      await setConversationWaitingAdmin(conversationId);
      setConvStatus('waiting_admin');
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
  const isWaiting   = convStatus === 'waiting_admin';
  // Keep waiting-admin conversations writable so customers can leave details while they wait.
  const inputDisabled = sending || botTyping;

  return (
    <div className="support-chat-page page-transition">
      {/* Header */}
      <div className="mb-16">
        <h2 className="fw-800 mb-4 flex items-center gap-8">
          <MessageSquare size={22} color="var(--primary)" />
          Support Chat
        </h2>
        <p className="text-secondary text-sm">
          {isBotMode
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

      {/* Messages area */}
      <div
        className="support-chat-messages"
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
                onVoteYes={handleResolvedYes}
                onVoteNo={handleResolvedNo}
                adminName={adminName}
              />
            </div>
          );
        })}

        {/* Bot typing indicator */}
        {botTyping && (
          <div className="support-message-row is-admin" role="status" aria-label="Assistant is typing">
            <div className="chat-avatar bot-avatar"><Bot size={12} /></div>
            <div className="support-message-stack">
              <div className="chat-sender-label bot-label">🤖 CargoExpress Assistant</div>
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
