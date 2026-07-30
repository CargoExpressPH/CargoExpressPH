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
  closeConversation,
  reopenConversation,
  getOrCreateConversation,
} from '../../lib/database';
import EmptyState from '../../components/ui/EmptyState';
import { MessageSquare, Send, Loader, User, Bot, Clock, CheckCircle, UserCheck, ArrowLeft, Search, AlertCircle } from 'lucide-react';
import usePageTitle from '../../hooks/usePageTitle';
import { logChat } from '../../lib/activityLog';

// ── Status badge config ────────────────────────────────────────────────────────
// 'waiting_admin' — customer escalated, waiting for a live admin
// 'open'          — admin is actively handling this conversation
// 'closed'        — resolved (admin closed) OR bot handling (no active admin)
const STATUS_BADGE = {
  waiting_admin: { emoji: '⏳', text: 'Waiting', color: 'var(--warning)',      bg: 'var(--warning-bg)',    icon: Clock },
  open:          { emoji: '💬', text: 'Active',  color: 'var(--success)',      bg: 'var(--success-bg)',    icon: MessageSquare },
  closed:        { emoji: '✅', text: 'Closed',  color: 'var(--text-tertiary)', bg: 'var(--bg-secondary)', icon: CheckCircle },
};

const ConvStatusBadge = ({ status, assignedAdmin }) => {
  const cfg = STATUS_BADGE[status] || STATUS_BADGE.open;
  const Icon = cfg.icon;
  return (
    <span className="inbox-status-badge" style={{ color: cfg.color, background: cfg.bg }}>
      <Icon size={10} />
      <span aria-hidden="true">{cfg.emoji}</span> {cfg.text}
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

// Mirrors getAdminConversations() ordering so realtime updates keep the same sort
const sortConvs = (list) => [...list].sort((a, b) => {
  if (a.status === 'waiting_admin' && b.status !== 'waiting_admin') return -1;
  if (b.status === 'waiting_admin' && a.status !== 'waiting_admin') return 1;
  if (a.unread_count > 0 && !(b.unread_count > 0)) return -1;
  if (b.unread_count > 0 && !(a.unread_count > 0)) return 1;
  const timeA = new Date(a.last_message?.created_at || a.created_at);
  const timeB = new Date(b.last_message?.created_at || b.created_at);
  return timeB - timeA;
});

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
  const [statusFilter, setStatusFilter] = useState('all');
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

    // Subscribe to conversation UPDATE (status changes — waiting_admin, resolved, etc.)
    const updateChannel = supabase.channel('admin_conversations_update')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'conversations' }, (payload) => {
        setConversations(prev =>
          sortConvs(prev.map(c =>
            c.id === payload.new.id
              ? { ...c, status: payload.new.status, assigned_admin_id: payload.new.assigned_admin_id }
              : c
          ))
        );
        // Also update activeConv if it's the changed one
        if (activeConvRef.current?.id === payload.new.id) {
          setActiveConv(prev => ({ ...prev, status: payload.new.status, assigned_admin_id: payload.new.assigned_admin_id }));
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
            unread_count: msg.sender_role === 'customer'
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
          const existingIds = new Set(conversations.map(c => c.profiles?.id).filter(Boolean));
          setCustomerResults((data || []).filter(p => !existingIds.has(p.id)));
        }
      } finally {
        if (!cancelled) setSearchingCustomers(false);
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [searchQuery, conversations]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Start a chat with a customer who has no conversation yet ───────────────
  const handleStartChat = async (customer) => {
    setLoadingList(true);
    setSearchQuery('');
    setCustomerResults([]);
    try {
      // New conversations default to 'closed' (bot-first); open it so the
      // admin can reply immediately instead of hitting a disabled input.
      const conv = await getOrCreateConversation(customer.id);
      if (conv.status === 'closed') {
        await reopenConversation(conv.id);
      }
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

    const isFirstAdminReply = activeConv.status === 'waiting_admin';

    try {
      const newMsg = await sendMessage(activeConv.id, user.id, 'admin', text);

      // Auto-assign on first admin reply to a 'waiting_admin' conversation
      if (isFirstAdminReply) {
        await assignConversation(activeConv.id);
        logChat('Conversation Assigned', activeConv.id, activeConv.profiles?.name || 'Customer', {
          details: `Admin ${user.email} accepted conversation with ${activeConv.profiles?.name || 'Customer'}.`,
        });
        // Refresh so UI shows assigned status
        setActiveConv(prev => ({ ...prev, status: 'open', assigned_admin_id: user.id }));
        activeConvRef.current = { ...activeConvRef.current, status: 'open', assigned_admin_id: user.id };
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
        setActiveConv(prev => ({ ...prev, status: 'open', assigned_admin_id: user.id }));
      } else if (newStatus === 'closed') {
        await closeConversation(activeConv.id);
        logChat('Conversation Resolved', activeConv.id, activeConv.profiles?.name || 'Customer', {
          details: `Conversation marked as resolved.`,
        });
        toast.success('Conversation resolved.');
        setActiveConv(prev => ({ ...prev, status: 'closed' }));
      } else if (newStatus === 'open') {
        await reopenConversation(activeConv.id);
        logChat('Conversation Reopened', activeConv.id, activeConv.profiles?.name || 'Customer', {
          details: `Conversation reopened.`,
        });
        toast.success('Conversation reopened.');
        setActiveConv(prev => ({ ...prev, status: 'open' }));
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
                  🤖 CargoExpress Assistant
                </div>
              )}
              {isCustomer && (
                <div className="inbox-msg-sender-label">
                  👤 {activeConv?.profiles?.name || 'Customer'}
                </div>
              )}

              <div className={`text-sm ${isAdmin ? `inbox-msg-bubble-admin${m.failed ? ' is-failed' : ''}` : isBot ? 'inbox-msg-bubble-bot' : 'inbox-msg-bubble-customer'}`}>
                {m.message.split('\n').map((line, j, arr) => (
                  <span key={j}>{line}{j < arr.length - 1 && <br />}</span>
                ))}
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
  const filteredConvs = conversations.filter(conv => {
    if (statusFilter === 'waiting' && conv.status !== 'waiting_admin') return false;
    // UI tab is "active"; DB status for live admin chats is "open"
    if (statusFilter === 'active' && conv.status !== 'open') return false;
    if (statusFilter === 'closed' && conv.status !== 'closed') return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const name = conv.profiles?.name?.toLowerCase() || '';
      const email = conv.profiles?.email?.toLowerCase() || '';
      if (!name.includes(q) && !email.includes(q)) return false;
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
                placeholder="Search all customers..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
              />
            </div>

            {/* Status Filter Tabs */}
            <div className="inbox-filter-tabs" role="group" aria-label="Filter conversations">
              {['all', 'waiting', 'active', 'closed'].map(status => (
                <button
                  key={status}
                  type="button"
                  aria-pressed={statusFilter === status}
                  onClick={() => setStatusFilter(status)}
                  className={`inbox-filter-tab-btn ${statusFilter === status ? 'active' : ''}`}
                >
                  {status === 'waiting' ? 'Waiting' : status}
                </button>
              ))}
            </div>
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
                const isWaiting = conv.status === 'waiting_admin';
                const isClosed = conv.status === 'closed';
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

                      {conv.last_message?.message && (
                        <div className="inbox-conv-preview">
                          {conv.last_message.sender_role === 'admin' ? 'You: ' : conv.last_message.sender_role === 'bot' ? 'Bot: ' : ''}
                          {conv.last_message.message}
                        </div>
                      )}

                      <div className="inbox-conversation-meta">
                        <ConvStatusBadge
                          status={conv.status}
                          assignedAdmin={conv.assigned_admin?.name}
                        />
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
                    All Customers
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
                <div className="flex items-center gap-12">
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
                      <span className="truncate">{activeConv.profiles?.email}</span>
                      <ConvStatusBadge
                        status={activeConv.status}
                        assignedAdmin={activeConv.assigned_admin?.name}
                      />
                    </div>
                    {activeConv.assigned_admin?.name && (
                      <div className="text-tertiary inbox-chat-user-assigned">
                        <UserCheck size={11} />
                        Assigned to: {activeConv.assigned_admin.name}
                      </div>
                    )}
                  </div>
                </div>

                {/* Action buttons */}
                <div className="inbox-chat-header-actions">
                  {activeConv.status !== 'closed' && (
                    <>
                      {!activeConv.assigned_admin_id && (
                        <button type="button" className="btn btn-outline btn-sm" onClick={() => handleStatusChange('assigned')}>
                          Assign to Me
                        </button>
                      )}
                      <button type="button" className="btn btn-resolve-success btn-sm gap-4 flex items-center" onClick={() => handleStatusChange('closed')}>
                        <CheckCircle size={14} /> Resolve
                      </button>
                    </>
                  )}
                  {activeConv.status === 'closed' && (
                    <button type="button" className="btn btn-primary btn-sm" onClick={() => handleStatusChange('open')}>
                      Reopen
                    </button>
                  )}
                </div>
              </div>

              {/* Waiting banner inside chat area */}
              {activeConv.status === 'waiting_admin' && (
                <div className="inbox-waiting-banner">
                  <Clock size={14} />
                  <span>This customer is <strong>waiting for your response</strong>. Reply to auto-assign this conversation to you.</span>
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
                  placeholder={activeConv.status === 'closed' ? 'Conversation resolved. Reopen to reply.' : 'Type a reply…'}
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
                  disabled={sending || activeConv.status === 'closed' || !!errorChat}
                />
                <button
                  type="submit"
                  className="btn btn-primary inbox-send-btn"
                  aria-label="Send reply"
                  disabled={!input.trim() || sending || activeConv.status === 'closed' || !!errorChat}
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
