import { useState, useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../hooks/useToast';
import { supabase } from '../../lib/supabase';
import {
  getAdminConversations,
  getMessagesPage,
  markCustomerMessagesRead,
  sendMessage,
  withTimeout,
  assignConversation,
  resolveConversation,
  getOrCreateConversation,
  compareConversations,
  reassignConversation,
  getAdminProfiles,
  searchConversationMessages,
  CONVERSATION_STATUS,
} from '../../lib/database';
import EmptyState from '../../components/ui/EmptyState';
import CustomSelect from '../../components/ui/CustomSelect';
import { MessageSquare, Send, Loader, User, Bot, Clock, CheckCircle, UserCheck, ArrowLeft, Search, AlertCircle, X } from 'lucide-react';
import usePageTitle from '../../hooks/usePageTitle';
import { logChat } from '../../lib/activityLog';
import { renderMarkdown } from '../../lib/markdown';

// ── Status badge config ────────────────────────────────────────────────────────
// Three of the four states earn a badge. `waiting_customer` was previously
// blank on the theory that a row with nothing to do should stay silent, but
// blank is ambiguous in a list: it reads the same as `bot_active`, so an
// answered thread and one the bot is still holding looked identical. The blue
// pill says which — the row still needs no action, it just no longer lies
// about why. `bot_active` remains the one unbadged state: the bot is mid-flight
// and nothing is owed by anyone.
const STATUS_BADGE = {
  waiting:          { text: 'Waiting',       color: 'var(--warning-text)' },
  waiting_customer: { text: 'Awaiting Reply', color: 'var(--info-text)' },
  resolved:         { text: 'Resolved',      color: 'var(--text-tertiary)' },
};

const WAITING_ALERT_HOURS = 24;

// Statuses from which a NEW customer message becomes our turn. Mirrors
// maintain_conversation_service_state (20260804260000): 'bot_active' keeps the
// thread it is handling and 'resolved' hands a returning customer back to the
// bot, so neither owes an admin a reply.
const OUR_TURN_AFTER_CUSTOMER_MSG = new Set([
  CONVERSATION_STATUS.WAITING,
  CONVERSATION_STATUS.WAITING_CUSTOMER,
]);

/** How long this customer has been waiting on us, in hours. */
const waitingHours = (conv) => {
  if (conv.status !== CONVERSATION_STATUS.WAITING) return 0;
  const since = new Date(conv.last_customer_message_at || conv.created_at);
  return (Date.now() - since.getTime()) / 3600000;
};

/** "waiting 3h" / "waiting 4 days" — the age of the oldest unanswered message. */
const formatWait = (hours) => {
  if (hours < 1) return 'waiting <1h';
  if (hours < 24) return `waiting ${Math.floor(hours)}h`;
  const days = Math.floor(hours / 24);
  return `waiting ${days} day${days === 1 ? '' : 's'}`;
};

const ConvStatusBadge = ({ status, assignedAdmin }) => {
  const cfg = STATUS_BADGE[status];
  if (!cfg) return assignedAdmin
    ? <span className="inbox-status-quiet">{assignedAdmin}</span>
    : null;
  return (
    <span className="inbox-status-badge" style={{ color: cfg.color }}>
      <span className="inbox-status-dot" aria-hidden="true" />
      {cfg.text}
      {assignedAdmin && <span style={{ marginLeft: 4, opacity: 0.8 }}>· {assignedAdmin}</span>}
    </span>
  );
};

const formatTime = (dateStr) => {
  const d = new Date(dateStr);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

// ── Admin initials avatar ──────────────────────────────────────────────────────
const getInitials = (name) =>
  (name || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();

const TEXTAREA_BASE_HEIGHT = 42;
const MESSAGES_PAGE_SIZE = 50;

// Ordering lives in database.js so a realtime update and a reload cannot sort
// the same list differently.
const sortConvs = (list) => [...list].sort(compareConversations);

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

const InboxPage = () => {
  usePageTitle('Inbox');
  const { user } = useAuth();
  const toast = useToast();
  const location = useLocation();

  const [conversations, setConversations] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [customerResults, setCustomerResults] = useState([]);
  const [searchingCustomers, setSearchingCustomers] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  const [activeConv, setActiveConv] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loadingList, setLoadingList] = useState(true);
  const [errorList, setErrorList] = useState(null);
  const [loadingChat, setLoadingChat] = useState(false);
  const [errorChat, setErrorChat] = useState(null);
  const [chatReloadKey, setChatReloadKey] = useState(0);
  const [sending, setSending] = useState(false);
  const [textareaHeight, setTextareaHeight] = useState(TEXTAREA_BASE_HEIGHT);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [messageMatches, setMessageMatches] = useState(new Map());
  const [admins, setAdmins] = useState([]);
  const [reassigning, setReassigning] = useState(false);

  const messagesEndRef = useRef(null);
  const messagesContainerRef = useRef(null);
  const activeConvRef = useRef(null); // stable ref for realtime handlers
  const textareaRef = useRef(null);
  const nearBottomRef = useRef(true);
  const forceScrollRef = useRef(false);
  const initialScrollPendingRef = useRef(false);
  const convIdsRef = useRef(new Set());
  const failedSeqRef = useRef(0);

  // ── Load conversations ─────────────────────────────────────────────────────
  const loadConvs = async (targetUserId) => {
    setErrorList(null);
    try {
      let data = await withTimeout(getAdminConversations());

      let targetConv = null;
      if (targetUserId) {
        targetConv = data.find(c => c.profiles?.id === targetUserId);
        if (!targetConv) {
          try {
            await getOrCreateConversation(targetUserId);
            data = await withTimeout(getAdminConversations());
            targetConv = data.find(c => c.profiles?.id === targetUserId);
          } catch (e) {
            console.error('Failed to auto-create conversation', e);
          }
        }
      }

      setConversations(data || []);

      if (targetConv) {
        setActiveConv(targetConv);
        activeConvRef.current = targetConv;
      }
    } catch (err) {
      setErrorList(err.message || 'Failed to load conversations.');
    } finally {
      setLoadingList(false);
    }
  };

  // Admin roster for the reassign control. Fetched once; a handover is rare
  // enough that it does not need to stay live.
  useEffect(() => {
    getAdminProfiles().then(setAdmins).catch(() => setAdmins([]));
  }, []);

  const handleReassign = async (adminId) => {
    if (!activeConv) return;
    setReassigning(true);
    try {
      await reassignConversation(activeConv.id, adminId);
      const target = admins.find(a => a.id === adminId);
      logChat('Conversation Reassigned', activeConv.id, activeConv.profiles?.name || 'Customer', {
        details: adminId
          ? `Reassigned to ${target?.name || target?.email || 'another admin'}.`
          : 'Returned to the unassigned pool.',
      });
      setActiveConv(prev => ({
        ...prev,
        assigned_admin_id: adminId || null,
        assigned_admin: target ? { name: target.name } : null,
      }));
      toast.success(adminId ? `Reassigned to ${target?.name || 'admin'}.` : 'Returned to the pool.');
      loadConvs();
    } catch {
      toast.error('Failed to reassign conversation.');
    } finally {
      setReassigning(false);
    }
  };

  useEffect(() => {
    const targetUserId = location.state?.contactUserId;
    loadConvs(targetUserId);

    let timeoutId;

    // Subscribe to new conversations INSERT
    const insertChannel = supabase.channel('admin_conversations_insert')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'conversations' }, () => {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => loadConvs(), 2000);
      })
      .subscribe();

    // Subscribe to conversation UPDATE (status changes — waiting, resolved, etc.)
    const updateChannel = supabase.channel('admin_conversations_update')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'conversations' }, (payload) => {
        // last_customer_message_at rides along: it drives the wait-age badge
        // and the waiting-first ordering, so omitting it would leave the queue
        // showing a stale age after a live update.
        const patch = {
          status: payload.new.status,
          assigned_admin_id: payload.new.assigned_admin_id,
          escalated: payload.new.escalated,
          first_response_at: payload.new.first_response_at,
          last_customer_message_at: payload.new.last_customer_message_at,
          resolved_at: payload.new.resolved_at,
        };
        setConversations(prev =>
          sortConvs(prev.map(c => (c.id === payload.new.id ? { ...c, ...patch } : c)))
        );
        // Also update activeConv if it's the changed one
        if (activeConvRef.current?.id === payload.new.id) {
          setActiveConv(prev => ({ ...prev, ...patch }));
        }
        // A thread escalating out of 'bot_active' brings its whole bot-phase
        // backlog into scope at once — those messages were never counted, so
        // the row needs its count from the server rather than an increment.
        //
        // This fires for any update landing in 'waiting', not just the
        // transition into it: no REPLICA IDENTITY FULL is set on
        // conversations, so payload.old carries the primary key only and
        // cannot tell us the previous status. The refetch is debounced and
        // idempotent, so the extra calls are cheap; guessing from a missing
        // payload.old would not be.
        if (payload.new.status === CONVERSATION_STATUS.WAITING) {
          clearTimeout(timeoutId);
          timeoutId = setTimeout(() => loadConvs(), 1500);
        }
      })
      .subscribe();

    // Subscribe to ALL new chat messages so sidebar previews/unread stay live
    const msgChannel = supabase.channel('admin_chat_messages_all')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages' }, (payload) => {
        const msg = payload.new;
        if (!convIdsRef.current.has(msg.conversation_id)) {
          clearTimeout(timeoutId);
          timeoutId = setTimeout(() => loadConvs(), 1500);
          return;
        }
        const isActive = activeConvRef.current?.id === msg.conversation_id;
        setConversations(prev => sortConvs(prev.map(c => {
          if (c.id !== msg.conversation_id) return c;
          return {
            ...c,
            last_message: {
              conversation_id: c.id,
              message: msg.message,
              created_at: msg.created_at,
              sender_role: msg.sender_role,
            },
            // Only a thread that is OUR turn accrues unread work. A customer
            // message arriving while the bot still holds the thread is being
            // answered by the bot, and counting it is what inflated this list
            // to total chat volume.
            //
            // The test is on the status BEFORE this message, mirroring
            // maintain_conversation_service_state: from 'waiting' or
            // 'waiting_customer' a customer message lands in 'waiting' (ours),
            // while 'bot_active' and 'resolved' both stay/return to
            // 'bot_active' (the bot's). Testing for the post-trigger status
            // instead would depend on whether the conversations UPDATE event
            // beat this INSERT — it is not ordered, so the count would drift.
            unread_count: msg.sender_role === 'customer' && OUR_TURN_AFTER_CUSTOMER_MSG.has(c.status)
              ? (isActive ? 0 : (c.unread_count || 0) + 1)
              : (c.unread_count || 0),
          };
        })));
      })
      .subscribe();

    return () => {
      clearTimeout(timeoutId);
      supabase.removeChannel(insertChannel);
      supabase.removeChannel(updateChannel);
      supabase.removeChannel(msgChannel);
    };
  }, [location.state?.contactUserId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep known conversation ids available to realtime handlers
  useEffect(() => {
    convIdsRef.current = new Set(conversations.map(c => c.id));
  }, [conversations]);

  // ── Load messages when conversation is selected ────────────────────────────
  useEffect(() => {
    if (!activeConv) return;
    activeConvRef.current = activeConv;
    setInput('');
    setTextareaHeight(TEXTAREA_BASE_HEIGHT);
    if (textareaRef.current) {
      textareaRef.current.style.height = `${TEXTAREA_BASE_HEIGHT}px`;
    }

    let isMounted = true;
    initialScrollPendingRef.current = true;
    const loadMsgs = async () => {
      setLoadingChat(true);
      setErrorChat(null);
      try {
        const { messages: history, hasMore } = await getMessagesPage(activeConv.id, { limit: MESSAGES_PAGE_SIZE });
        if (isMounted) {
          setMessages((history || []).map(message =>
            message.sender_role === 'customer' ? { ...message, is_read: true } : message
          ));
          setHasMoreMessages(hasMore);
          setConversations(prev => prev.map(c =>
            c.id === activeConv.id ? { ...c, unread_count: 0 } : c
          ));
        }
        markCustomerMessagesRead(activeConv.id).catch(() => {});
      } catch (err) {
        if (isMounted) {
          setMessages([]);
          setHasMoreMessages(false);
          setErrorChat(err?.message || 'Failed to load messages.');
        }
      } finally {
        if (isMounted) setLoadingChat(false);
      }
    };
    loadMsgs();
    return () => { isMounted = false; };
  }, [activeConv?.id, chatReloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Realtime messages for active conversation ──────────────────────────────
  useEffect(() => {
    if (!activeConv) return;

    const channel = supabase.channel(`chat_admin_${activeConv.id}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'chat_messages',
        filter: `conversation_id=eq.${activeConv.id}`,
      }, (payload) => {
        setMessages(prev => {
          if (prev.some(m => m.id === payload.new.id)) return prev;
          const incoming = payload.new.sender_role === 'customer'
            ? { ...payload.new, is_read: true }
            : payload.new;
          return [...prev, incoming];
        });
        if (payload.new.sender_role === 'customer') {
          markCustomerMessagesRead(activeConv.id).catch(() => {});
        }
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [activeConv?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-scroll: instant on conversation open; afterwards only when the admin
  // is already near the bottom or just sent a message (respects reduced motion)
  useEffect(() => {
    if (messages.length === 0) return;
    if (initialScrollPendingRef.current) {
      initialScrollPendingRef.current = false;
      nearBottomRef.current = true;
      messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
      return;
    }
    if (forceScrollRef.current || nearBottomRef.current) {
      forceScrollRef.current = false;
      messagesEndRef.current?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    }
  }, [messages]);

  const handleMessagesScroll = () => {
    const el = messagesContainerRef.current;
    if (!el) return;
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  // ── Load older messages (pagination) ───────────────────────────────────────
  const handleLoadOlder = async () => {
    if (!activeConv || loadingOlder || !hasMoreMessages || messages.length === 0) return;
    setLoadingOlder(true);
    const el = messagesContainerRef.current;
    const prevHeight = el ? el.scrollHeight : 0;
    const prevTop = el ? el.scrollTop : 0;
    try {
      const oldest = messages.find(m => !m.failed);
      const { messages: older, hasMore } = await getMessagesPage(activeConv.id, {
        limit: MESSAGES_PAGE_SIZE,
        before: oldest?.created_at,
      });
      setMessages(prev => {
        const ids = new Set(prev.map(m => m.id));
        const fresh = (older || [])
          .filter(m => !ids.has(m.id))
          .map(m => (m.sender_role === 'customer' ? { ...m, is_read: true } : m));
        return [...fresh, ...prev];
      });
      setHasMoreMessages(hasMore);
      // Keep the viewport anchored on the message the admin was reading
      requestAnimationFrame(() => {
        if (el) el.scrollTop = prevTop + (el.scrollHeight - prevHeight);
      });
    } catch {
      toast.error('Failed to load earlier messages.');
    } finally {
      setLoadingOlder(false);
    }
  };

  // ── Search ALL customers (directory) when admin types a query ──────────────
  useEffect(() => {
    const q = searchQuery.trim();
    if (q.length < 2) {
      setCustomerResults([]);
      setSearchingCustomers(false);
      return;
    }
    setSearchingCustomers(true);
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        // Strip PostgREST filter delimiters so user input can't break the .or() expression
        const term = q.replace(/[,()]/g, ' ').trim();
        const { data, error } = await supabase
          .from('profiles')
          .select('id, name, email')
          .eq('role', 'customer')
          .or(`name.ilike.%${term}%,email.ilike.%${term}%`)
          .order('name', { ascending: true })
          .limit(8);
        if (cancelled) return;
        if (error) {
          setCustomerResults([]);
        } else {
          // Anyone who already has a conversation row is excluded here, empty
          // or not — during a search those rows are shown in the list above,
          // so listing them here too would surface the same customer twice.
          // (The bug this replaced was in the LIST, not here: empty rows were
          // hidden there while also being excluded here, so such a customer
          // appeared in neither half of the sidebar.)
          const existingIds = new Set(conversations.map(c => c.profiles?.id).filter(Boolean));
          setCustomerResults((data || []).filter(p => !existingIds.has(p.id)));
        }
      } finally {
        if (!cancelled) setSearchingCustomers(false);
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [searchQuery, conversations]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Search message BODIES (admin-only RPC) ────────────────────────────────
  // Runs beside the directory lookup on the same query. Kept as its own effect
  // so a failure here degrades to name/email search rather than breaking it.
  useEffect(() => {
    const q = searchQuery.trim();
    if (q.length < 2) {
      setMessageMatches(new Map());
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const matches = await searchConversationMessages(q);
        if (!cancelled) setMessageMatches(matches);
      } catch {
        if (!cancelled) setMessageMatches(new Map());
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [searchQuery]);

  // ── Start a chat with a customer who has no conversation yet ───────────────
  const handleStartChat = async (customer) => {
    setLoadingList(true);
    setSearchQuery('');
    setCustomerResults([]);
    try {
      // Deliberately does NOT touch status. Opening a conversation is not an
      // event in it — nobody has said anything yet, so claiming the customer
      // is "waiting" would be a lie the amber badge then repeats. The admin's
      // first message is the event, and the trigger derives the state from it.
      const conv = await getOrCreateConversation(customer.id);
      await loadConvs(customer.id);
      logChat('Conversation Started', conv.id, customer.name || 'Customer', {
        details: `Admin started a conversation with ${customer.name || customer.email}.`,
      });
    } catch {
      toast.error('Failed to start conversation.');
      setLoadingList(false);
    }
  };

  // ── Send message ───────────────────────────────────────────────────────────
  const makeFailedMessage = (text) => ({
    id: `failed-${++failedSeqRef.current}`,
    conversation_id: activeConv?.id,
    sender_id: user?.id,
    sender_role: 'admin',
    message: text,
    created_at: new Date().toISOString(),
    failed: true,
  });

  const sendText = async (text) => {
    if (!text || !activeConv || !user) return;
    setSending(true);

    // Taking an unassigned conversation out of the queue, or picking up one
    // the bot was handling, both count as accepting it.
    const isFirstAdminReply =
      (activeConv.status === CONVERSATION_STATUS.WAITING ||
       activeConv.status === CONVERSATION_STATUS.BOT_ACTIVE) &&
      !activeConv.assigned_admin_id;

    try {
      const newMsg = await sendMessage(activeConv.id, user.id, 'admin', text);

      // Auto-assign on first admin reply. The status move to 'waiting_customer'
      // is done by the maintain_conversation_service_state trigger; this
      // mirrors it locally so the UI does not lag a round trip behind.
      if (isFirstAdminReply) {
        await assignConversation(activeConv.id);
        logChat('Conversation Assigned', activeConv.id, activeConv.profiles?.name || 'Customer', {
          details: `Admin ${user.email} accepted conversation with ${activeConv.profiles?.name || 'Customer'}.`,
        });
        // Refresh so UI shows assigned status
        setActiveConv(prev => ({ ...prev, status: CONVERSATION_STATUS.WAITING_CUSTOMER, assigned_admin_id: user.id }));
        activeConvRef.current = { ...activeConvRef.current, status: CONVERSATION_STATUS.WAITING_CUSTOMER, assigned_admin_id: user.id };
        loadConvs();
      }

      logChat('Admin Sent Message', activeConv.id, activeConv.profiles?.name || 'Customer', {
        details: `Replied to ${activeConv.profiles?.name || 'Customer'}.`,
      });

      forceScrollRef.current = true;
      setMessages(prev => {
        if (prev.some(m => m.id === newMsg.id)) return prev;
        return [...prev, newMsg];
      });
    } catch {
      forceScrollRef.current = true;
      setMessages(prev => [...prev, makeFailedMessage(text)]);
      toast.error('Message not sent. Use Retry on the message to try again.');
    } finally {
      setSending(false);
    }
  };

  const handleSend = () => {
    const text = input.trim();
    if (!text || !activeConv || !user) return;

    setInput('');
    setTextareaHeight(TEXTAREA_BASE_HEIGHT);
    if (textareaRef.current) {
      textareaRef.current.style.height = `${TEXTAREA_BASE_HEIGHT}px`;
    }
    sendText(text);
  };

  const handleRetryMessage = (failedMsg) => {
    if (sending) return;
    setMessages(prev => prev.filter(m => m.id !== failedMsg.id));
    sendText(failedMsg.message);
  };

  const handleDiscardMessage = (failedMsg) => {
    setMessages(prev => prev.filter(m => m.id !== failedMsg.id));
  };

  // ── Status change (assign / close / reopen) ────────────────────────────────
  const handleStatusChange = async (newStatus) => {
    if (!activeConv) return;
    try {
      if (newStatus === 'assigned') {
        await assignConversation(activeConv.id);
        logChat('Conversation Assigned', activeConv.id, activeConv.profiles?.name || 'Customer', {
          details: `Conversation manually assigned to ${user.email}.`,
        });
        toast.success('Conversation assigned to you.');
        // Claiming does not change whose turn it is — replying does.
        setActiveConv(prev => ({ ...prev, assigned_admin_id: user.id }));
      } else if (newStatus === CONVERSATION_STATUS.RESOLVED) {
        await resolveConversation(activeConv.id);
        logChat('Conversation Resolved', activeConv.id, activeConv.profiles?.name || 'Customer', {
          details: `Conversation marked as resolved.`,
        });
        toast.success('Resolved. The bot handles them if they write again.');
        setActiveConv(prev => ({ ...prev, status: CONVERSATION_STATUS.RESOLVED }));
      }
      loadConvs();
    } catch {
      toast.error('Failed to update conversation status.');
    }
  };

  // ── Date formatting landmark helper ────────────────────────────────────────
  const formatDateLabel = (dateStr) => {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  // ── Message rendering ──────────────────────────────────────────────────────
  const renderMessageStream = () => {
    let lastDateLabel = null;

    return messages.map((m) => {
      const isAdmin = m.sender_role === 'admin';
      const isBot   = m.sender_role === 'bot';
      const isCustomer = m.sender_role === 'customer';
      const dateLabel = formatDateLabel(m.created_at);

      const showDateDivider = dateLabel && dateLabel !== lastDateLabel;
      if (showDateDivider) {
        lastDateLabel = dateLabel;
      }

      return (
        <div key={m.id}>
          {showDateDivider && (
            <div className="inbox-date-divider">
              <span className="inbox-date-divider-label">{dateLabel}</span>
            </div>
          )}
          <div className={`inbox-message-row ${isAdmin ? 'is-admin' : 'is-other'}`}>
            {!isAdmin && (
              <div className={`inbox-msg-avatar ${isBot ? 'is-bot' : 'is-customer'}`}>
                {isBot
                  ? <Bot size={13} color="var(--text-secondary)" />
                  : <User size={13} color="white" />
                }
              </div>
            )}

            <div className="inbox-message-stack">
              {isBot && (
                <div className="inbox-msg-sender-label">
                  <Bot size={11} aria-hidden="true" /> CargoExpress Assistant
                </div>
              )}
              {isCustomer && (
                <div className="inbox-msg-sender-label">
                  <User size={11} aria-hidden="true" /> {activeConv?.profiles?.name || 'Customer'}
                </div>
              )}

              <div className={`text-sm ${isAdmin ? `inbox-msg-bubble-admin${m.failed ? ' is-failed' : ''}` : isBot ? 'inbox-msg-bubble-bot' : 'inbox-msg-bubble-customer'}`}>
                {renderMarkdown(m.message)}
              </div>
              {m.failed ? (
                <div className="inbox-msg-failed-actions" role="alert">
                  <AlertCircle size={11} aria-hidden="true" />
                  <span>Not sent</span>
                  <button type="button" onClick={() => handleRetryMessage(m)} disabled={sending}>Retry</button>
                  <span aria-hidden="true">·</span>
                  <button type="button" onClick={() => handleDiscardMessage(m)} disabled={sending}>Discard</button>
                </div>
              ) : (
                <div className={`inbox-msg-timestamp ${isAdmin ? 'is-admin' : 'is-other'}`}>
                  {formatTime(m.created_at)}
                </div>
              )}
            </div>
          </div>
        </div>
      );
    });
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  // One number matters: how many people are waiting on us. Everything else
  // the admin can see by looking at the list.
  const needsReply = conversations.filter(c => c.status === CONVERSATION_STATUS.WAITING && c.last_message).length;
  const overdue = conversations.filter(c => waitingHours(c) >= WAITING_ALERT_HOURS && c.last_message).length;

  const query = searchQuery.trim().toLowerCase();
  const searching = query.length > 0;

  const filteredConvs = conversations.filter(conv => {
    // Empty conversations are noise in the resting list — but they are exactly
    // what someone is looking for when they search a customer by name, so the
    // rule lifts while a search is running.
    if (!searching && !conv.last_message && conv.id !== activeConv?.id) return false;

    // Resolved threads are history, not work. One checkbox instead of a tab —
    // and a search should still find them, or the search looks broken.
    if (!searching && !showResolved && conv.status === CONVERSATION_STATUS.RESOLVED) return false;

    if (searching) {
      const name = conv.profiles?.name?.toLowerCase() || '';
      const email = conv.profiles?.email?.toLowerCase() || '';
      const matchedInMessages = messageMatches.has(conv.id);
      if (!name.includes(query) && !email.includes(query) && !matchedInMessages) return false;
    }
    return true;
  });

  return (
    <div className="page-transition admin-inbox-page">
      <h1 className="fw-800 text-2xl mb-24">Customer Inbox</h1>

      <div className={`inbox-layout ${activeConv ? 'has-active-conv' : ''}`}>

        {/* ── Left Panel: Conversations List ─────────────────────────────── */}
        <div className="inbox-sidebar">
          <div className="inbox-sidebar-header">
            <h3 className="fw-700 text-base" style={{ margin: 0 }}>Conversations</h3>
            
            {/* Search Input Box */}
            <div className="inbox-search-box" role="search">
              <Search size={14} className="text-secondary" aria-hidden="true" />
              <input
                type="text"
                aria-label="Search conversations"
                placeholder="Search or message a customer…"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
              />
            </div>

            {/* One line of status. Shown even at zero — a queue you can SEE is
                empty is the reassurance; a hidden one is how conversations
                got buried in the first place. */}
            <div className={`inbox-queue-line ${needsReply > 0 ? 'has-waiting' : ''}`} role="status" aria-live="polite">
              {needsReply > 0 ? (
                <>
                  <AlertCircle size={14} aria-hidden="true" />
                  <span>
                    <strong>{needsReply}</strong> need{needsReply === 1 ? 's' : ''} a reply
                    {overdue > 0 && <> · {overdue} over {WAITING_ALERT_HOURS}h</>}
                  </span>
                </>
              ) : (
                <>
                  <CheckCircle size={14} aria-hidden="true" />
                  <span>All caught up</span>
                </>
              )}
            </div>

            <label className="inbox-show-resolved">
              <input
                type="checkbox"
                checked={showResolved}
                onChange={e => setShowResolved(e.target.checked)}
              />
              Show resolved
            </label>
          </div>
          <div className="inbox-conversation-list">
            {loadingList ? (
              <div className="flex-center p-md"><Loader size={24} className="animate-spin text-secondary" /></div>
            ) : errorList ? (
              <div className="p-md text-center text-sm" style={{ color: 'var(--error)' }}>
                <p><strong>Error loading chats</strong></p>
                <p className="mt-4">{errorList}</p>
                <button type="button" className="btn btn-ghost btn-sm mt-sm" onClick={() => loadConvs()}>Retry</button>
              </div>
            ) : filteredConvs.length === 0 && customerResults.length === 0 && !searchingCustomers ? (
              <div className="p-md text-center text-sm text-secondary">
                {conversations.length === 0
                  ? 'No customer messages yet.'
                  : searchQuery
                  ? 'No matching customers found.'
                  : 'No matching conversations.'}
              </div>
            ) : (
              <>
              {filteredConvs.map((conv, i) => {
                const isWaiting = conv.status === CONVERSATION_STATUS.WAITING;
                const isClosed = conv.status === CONVERSATION_STATUS.RESOLVED;
                const waitHrs = waitingHours(conv);
                return (
                  <button
                    key={conv.id}
                    type="button"
                    onClick={() => { setActiveConv(conv); activeConvRef.current = conv; }}
                    className={`inbox-conversation-item stagger-item ${activeConv?.id === conv.id ? 'active' : ''} ${isWaiting ? 'inbox-conv-waiting' : ''}`}
                    style={{ animationDelay: `${i * 40}ms` }}
                    aria-label={`Conversation with ${conv.profiles?.name || 'Customer'}, status ${conv.status}${conv.unread_count > 0 ? `, ${conv.unread_count} unread` : ''}`}
                  >
                    {/* Avatar */}
                    <div
                      className="inbox-conversation-avatar"
                      style={{
                        background: isWaiting
                          ? 'linear-gradient(135deg, var(--warning), #f59e0b)'
                          : activeConv?.id === conv.id
                          ? 'linear-gradient(135deg,var(--primary),var(--primary-light))'
                          : 'var(--bg-secondary)',
                      }}
                    >
                      {isWaiting
                        ? <Clock size={18} color="white" />
                        : <span className={`inbox-avatar-initials ${activeConv?.id === conv.id ? 'active' : ''}`}>
                            {getInitials(conv.profiles?.name)}
                          </span>
                      }
                    </div>

                    {/* Info */}
                    <div className="inbox-conversation-info">
                      <div className="flex items-center justify-between gap-4">
                        <div className={`inbox-conversation-name ${isClosed ? 'is-closed' : ''}`}>
                          {conv.profiles?.name || 'Unknown Customer'}
                        </div>
                        {conv.unread_count > 0 && (
                          <span className="inbox-unread-dot" title={`${conv.unread_count} unread message`} />
                        )}
                      </div>

                      {searching && messageMatches.has(conv.id) ? (
                        <div className="inbox-conv-preview is-match">
                          <Search size={10} aria-hidden="true" />
                          <span>{messageMatches.get(conv.id).snippet}</span>
                          {messageMatches.get(conv.id).matchCount > 1 && (
                            <span className="inbox-match-count">
                              +{messageMatches.get(conv.id).matchCount - 1}
                            </span>
                          )}
                        </div>
                      ) : conv.last_message?.message ? (
                        <div className="inbox-conv-preview">
                          {conv.last_message.sender_role === 'admin' ? 'You: ' : conv.last_message.sender_role === 'bot' ? 'Bot: ' : ''}
                          {conv.last_message.message}
                        </div>
                      ) : searching ? (
                        <div className="inbox-conv-preview is-empty">No messages yet</div>
                      ) : null}

                      <div className="inbox-conversation-meta">
                        <ConvStatusBadge
                          status={conv.status}
                          assignedAdmin={conv.assigned_admin?.name}
                        />
                        {isWaiting && (
                          <span className={`inbox-wait-age ${waitHrs >= WAITING_ALERT_HOURS ? 'overdue' : ''}`}>
                            {formatWait(waitHrs)}
                          </span>
                        )}
                      </div>
                    </div>
                  </button>
                );
              })}

              {/* ── All-customer directory results (no conversation yet) ── */}
              {searchQuery.trim().length >= 2 && (searchingCustomers || customerResults.length > 0) && (
                <div>
                  <div
                    className="text-tertiary fw-700"
                    style={{ fontSize: '0.6875rem', textTransform: 'uppercase', letterSpacing: '0.05em', padding: '10px 14px 4px' }}
                  >
                    Start a new conversation
                  </div>
                  {searchingCustomers ? (
                    <div className="p-md text-center">
                      <Loader size={16} className="animate-spin text-secondary" />
                    </div>
                  ) : (
                    customerResults.map(cust => (
                      <button
                        key={cust.id}
                        type="button"
                        className="inbox-conversation-item"
                        onClick={() => handleStartChat(cust)}
                        aria-label={`Start conversation with ${cust.name || cust.email}`}
                      >
                        <div className="inbox-conversation-avatar" style={{ background: 'var(--bg-secondary)' }}>
                          <span className="inbox-avatar-initials">{getInitials(cust.name)}</span>
                        </div>
                        <div className="inbox-conversation-info">
                          <div className="inbox-conversation-name">{cust.name || 'Unnamed Customer'}</div>
                          <div className="inbox-conv-preview">{cust.email}</div>
                          <div className="inbox-conversation-meta">
                            <span className="inbox-status-badge" style={{ color: 'var(--primary)', background: 'var(--primary-bg)' }}>
                              <MessageSquare size={10} /> Start chat
                            </span>
                          </div>
                        </div>
                      </button>
                    ))
                  )}
                </div>
              )}
              </>
            )}
          </div>
        </div>

        {/* ── Right Panel: Chat Messages ──────────────────────────────────── */}
        <div className="inbox-chat-area">
          {activeConv ? (
            <>
              {/* Chat Header */}
              <div className="inbox-chat-header">
                {/* Needs its own class, not `flex` utilities: as a flex item it
                    defaults to min-width:auto, so a long name or email could not
                    shrink and pushed the header past the viewport on mobile. */}
                <div className="inbox-chat-header-identity">
                  <button
                    type="button"
                    className="inbox-mobile-back-btn"
                    onClick={() => { setActiveConv(null); activeConvRef.current = null; }}
                    aria-label="Back to conversations list"
                  >
                    <ArrowLeft size={18} />
                  </button>
                  <div className="w-36 h-36 rounded-full flex items-center justify-center flex-shrink-0 inbox-header-avatar">
                    <User size={18} color="white" />
                  </div>
                  <div className="inbox-chat-user-meta">
                    <div className="fw-700 text-accent inbox-chat-user-name">
                      {activeConv.profiles?.name || 'Customer'}
                    </div>
                    <div className="text-secondary inbox-chat-user-sub">
                      <span className="truncate inbox-chat-user-email">{activeConv.profiles?.email}</span>
                      <ConvStatusBadge
                        status={activeConv.status}
                        assignedAdmin={activeConv.assigned_admin?.name}
                      />
                    </div>
                    {activeConv.assigned_admin_id && (
                      <div className="text-tertiary inbox-chat-user-assigned">
                        <UserCheck size={11} aria-hidden="true" />
                        <label htmlFor="inbox-reassign" className="sr-only">Reassign this conversation</label>
                        {/* Hidden on mobile to give the select room; the icon
                            plus the sr-only label above still carry the meaning. */}
                        <span className="inbox-assigned-label">Assigned to</span>
                        {/* A handover path. Assignment used to be one-way, so a
                            conversation owned by someone on leave was stuck. */}
                        {/* CustomSelect, not a native <select>, so this matches
                            every other dropdown in the admin UI (Activity Logs,
                            Customers, Feedback). A native select hands off to
                            the OS picker — a centred dialog on Android, a wheel
                            on iOS — which read as a different app. It also
                            renders a <button>, and iOS never focus-zooms a
                            button, so the auto-zoom problem cannot recur. */}
                        <CustomSelect
                          id="inbox-reassign"
                          className="form-control inbox-reassign-select"
                          value={activeConv.assigned_admin_id || ''}
                          disabled={reassigning}
                          onChange={e => handleReassign(e.target.value || null)}
                        >
                          {admins.length === 0 && (
                            <option value={activeConv.assigned_admin_id}>
                              {activeConv.assigned_admin?.name || 'Assigned'}
                            </option>
                          )}
                          {admins.map(a => (
                            <option key={a.id} value={a.id}>
                              {a.id === user?.id ? `${a.name || a.email} (me)` : (a.name || a.email)}
                            </option>
                          ))}
                          <option value="">— Unassign —</option>
                        </CustomSelect>
                      </div>
                    )}
                  </div>
                </div>

                {/* Action buttons.
                    Desktop and mobile render separate groups rather than one
                    shared set. Each is display:none at the other breakpoint, so
                    only one is ever in the accessibility tree — no duplicate
                    controls announced to a screen reader. */}
                <div className="inbox-chat-header-actions">
                  {/* ── Desktop: full labelled buttons ── */}
                  <div className="inbox-actions-desktop">
                    {activeConv.status !== CONVERSATION_STATUS.RESOLVED && (
                      <>
                        {!activeConv.assigned_admin_id && (
                          <button type="button" className="btn btn-outline btn-sm" onClick={() => handleStatusChange('assigned')}>
                            Assign to Me
                          </button>
                        )}
                        <button type="button" className="btn btn-resolve-success btn-sm gap-4 flex items-center" onClick={() => handleStatusChange(CONVERSATION_STATUS.RESOLVED)}>
                          <CheckCircle size={14} /> Resolve
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      className="inbox-close-btn"
                      onClick={() => { setActiveConv(null); activeConvRef.current = null; }}
                      aria-label="Close conversation"
                      title="Close"
                    >
                      <X size={16} aria-hidden="true" />
                    </button>
                  </div>

                  {/* ── Mobile: two direct icon actions, no hidden menu ──
                       An overflow menu holding one situational item costs more
                       than it gives. The header's ✕ is omitted here because the
                       back arrow already does exactly the same thing; on desktop
                       there is no back arrow, so ✕ stays in the group above. */}
                  {activeConv.status !== CONVERSATION_STATUS.RESOLVED && !activeConv.assigned_admin_id && (
                    <button
                      type="button"
                      className="inbox-assign-quick"
                      onClick={() => handleStatusChange('assigned')}
                      aria-label="Assign this conversation to me"
                      title="Assign to me"
                    >
                      <UserCheck size={18} aria-hidden="true" />
                    </button>
                  )}

                  {activeConv.status !== CONVERSATION_STATUS.RESOLVED && (
                    <button
                      type="button"
                      className="inbox-resolve-quick"
                      onClick={() => handleStatusChange(CONVERSATION_STATUS.RESOLVED)}
                      aria-label="Resolve conversation"
                      title="Resolve"
                    >
                      <CheckCircle size={18} aria-hidden="true" />
                    </button>
                  )}
                </div>
              </div>

              {/* Waiting banner inside chat area */}
              {activeConv.status === CONVERSATION_STATUS.WAITING && (
                <div className="inbox-waiting-banner">
                  <Clock size={14} />
                  <span>
                    This customer is <strong>waiting for your response</strong>
                    {waitingHours(activeConv) >= 1 && <> — {formatWait(waitingHours(activeConv))}</>}.
                    Reply to auto-assign this conversation to you.
                  </span>
                </div>
              )}

              {/* Messages */}
              <div
                className="inbox-chat-messages"
                ref={messagesContainerRef}
                onScroll={handleMessagesScroll}
                role="log"
                aria-live="polite"
                aria-relevant="additions"
                aria-label="Conversation messages"
              >
                {loadingChat ? (
                  <div className="flex-center h-full" role="status" aria-busy="true">
                    <Loader size={24} className="animate-spin text-secondary" aria-hidden="true" />
                    <span className="sr-only">Loading messages</span>
                  </div>
                ) : errorChat ? (
                  <div className="p-md text-center text-sm" style={{ color: 'var(--error)' }} role="alert">
                    <p><strong>Error loading messages</strong></p>
                    <p className="mt-4">{errorChat}</p>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm mt-sm"
                      onClick={() => setChatReloadKey(k => k + 1)}
                    >
                      Retry
                    </button>
                  </div>
                ) : messages.length === 0 ? (
                  <div className="text-center text-sm text-secondary mt-20">No messages yet.</div>
                ) : (
                  <>
                    {hasMoreMessages && (
                      <div className="inbox-load-older">
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
                    {renderMessageStream()}
                  </>
                )}
                <div ref={messagesEndRef} />
              </div>

              {/* Input Area */}
              <form
                className="inbox-chat-input-area"
                onSubmit={e => {
                  e.preventDefault();
                  handleSend();
                }}
              >
                <textarea
                  ref={textareaRef}
                  className="form-input flex-1 inbox-textarea"
                  aria-label="Type a reply"
                  placeholder={activeConv.status === CONVERSATION_STATUS.RESOLVED ? 'Resolved — replying reopens it' : 'Type a reply…'}
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
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleSend();
                    }
                  }}
                  style={{ height: `${textareaHeight}px` }}
                  disabled={sending || !!errorChat}
                />
                <button
                  type="submit"
                  className="btn btn-primary inbox-send-btn"
                  aria-label="Send reply"
                  disabled={!input.trim() || sending || !!errorChat}
                >
                  {sending ? <Loader size={18} className="animate-spin" aria-hidden="true" /> : <><Send size={18} aria-hidden="true" /> Reply</>}
                </button>
              </form>
            </>
          ) : (
            <EmptyState
              icon={MessageSquare}
              title="No Conversation Selected"
              description="Select a customer from the left to view and reply to their messages."
              className="h-full"
            />
          )}
        </div>
      </div>
    </div>
  );
};

export default InboxPage;
