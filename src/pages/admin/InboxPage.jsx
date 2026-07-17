import { useState, useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../hooks/useToast';
import { supabase } from '../../lib/supabase';
import {
  getAdminConversations,
  getMessages,
  markCustomerMessagesRead,
  sendMessage,
  withTimeout,
  assignConversation,
  closeConversation,
  reopenConversation,
  getOrCreateConversation,
} from '../../lib/database';
import EmptyState from '../../components/ui/EmptyState';
import { MessageSquare, Send, Loader, User, Bot, Clock, CheckCircle, UserCheck, ArrowLeft, Search } from 'lucide-react';
import usePageTitle from '../../hooks/usePageTitle';
import { logChat } from '../../lib/activityLog';

// ── Status badge config ────────────────────────────────────────────────────────
// 'waiting_admin' — customer escalated, waiting for a live admin
// 'open'          — admin is actively handling this conversation
// 'closed'        — resolved (admin closed) OR bot handling (no active admin)
const STATUS_BADGE = {
  waiting_admin: { label: '⏳ Waiting', color: 'var(--warning)',      bg: 'var(--warning-bg)',    icon: Clock },
  open:          { label: '💬 Active',  color: 'var(--success)',      bg: 'var(--success-bg)',    icon: MessageSquare },
  closed:        { label: '✅ Closed',  color: 'var(--text-tertiary)', bg: 'var(--bg-secondary)', icon: CheckCircle },
};

const ConvStatusBadge = ({ status, assignedAdmin }) => {
  const cfg = STATUS_BADGE[status] || STATUS_BADGE.open;
  const Icon = cfg.icon;
  return (
    <span className="inbox-status-badge" style={{ color: cfg.color, background: cfg.bg }}>
      <Icon size={10} />
      {cfg.label}
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

const InboxPage = () => {
  usePageTitle('Inbox');
  const { user } = useAuth();
  const toast = useToast();
  const location = useLocation();

  const [conversations, setConversations] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [activeConv, setActiveConv] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loadingList, setLoadingList] = useState(true);
  const [errorList, setErrorList] = useState(null);
  const [loadingChat, setLoadingChat] = useState(false);
  const [sending, setSending] = useState(false);
  const [textareaHeight, setTextareaHeight] = useState(TEXTAREA_BASE_HEIGHT);

  const messagesEndRef = useRef(null);
  const activeConvRef = useRef(null); // stable ref for realtime handlers
  const textareaRef = useRef(null);

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
          prev.map(c =>
            c.id === payload.new.id
              ? { ...c, status: payload.new.status, assigned_admin_id: payload.new.assigned_admin_id }
              : c
          ).sort((a, b) => {
            if (a.status === 'waiting_admin' && b.status !== 'waiting_admin') return -1;
            if (b.status === 'waiting_admin' && a.status !== 'waiting_admin') return 1;
            return new Date(b.created_at) - new Date(a.created_at);
          })
        );
        // Also update activeConv if it's the changed one
        if (activeConvRef.current?.id === payload.new.id) {
          setActiveConv(prev => ({ ...prev, status: payload.new.status, assigned_admin_id: payload.new.assigned_admin_id }));
        }
      })
      .subscribe();

    return () => {
      clearTimeout(timeoutId);
      supabase.removeChannel(insertChannel);
      supabase.removeChannel(updateChannel);
    };
  }, [location.state?.contactUserId]); // eslint-disable-line react-hooks/exhaustive-deps

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
    const loadMsgs = async () => {
      setLoadingChat(true);
      try {
        const history = await getMessages(activeConv.id);
        if (isMounted) {
          setMessages((history || []).map(message =>
            message.sender_role === 'customer' ? { ...message, is_read: true } : message
          ));
        }
        markCustomerMessagesRead(activeConv.id).catch(() => {});
      } catch {
        // Message load failed — user sees empty state
      } finally {
        if (isMounted) setLoadingChat(false);
      }
    };
    loadMsgs();
    return () => { isMounted = false; };
  }, [activeConv?.id]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // ── Send message ───────────────────────────────────────────────────────────
  const handleSend = async () => {
    const text = input.trim();
    if (!text || !activeConv || !user) return;

    setInput('');
    setTextareaHeight(TEXTAREA_BASE_HEIGHT);
    if (textareaRef.current) {
      textareaRef.current.style.height = `${TEXTAREA_BASE_HEIGHT}px`;
    }
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

      setMessages(prev => {
        if (prev.some(m => m.id === newMsg.id)) return prev;
        return [...prev, newMsg];
      });
    } catch (err) {
      setInput(text);
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
        const h = Math.min(Math.max(textareaRef.current.scrollHeight, TEXTAREA_BASE_HEIGHT), 120);
        textareaRef.current.style.height = `${h}px`;
        setTextareaHeight(h);
      }
      toast.error('Failed to send message. Please try again.');
    } finally {
      setSending(false);
    }
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

  // ── Message rendering ──────────────────────────────────────────────────────
  const renderMessage = (m) => {
    const isAdmin = m.sender_role === 'admin';
    const isBot   = m.sender_role === 'bot';
    const isCustomer = m.sender_role === 'customer';

    return (
      <div key={m.id} className={`inbox-message-row ${isAdmin ? 'is-admin' : 'is-other'}`}>
        {/* Avatar for non-admin messages */}
        {!isAdmin && (
          <div className={`inbox-msg-avatar ${isBot ? 'is-bot' : 'is-customer'}`}>
            {isBot
              ? <Bot size={13} color="var(--text-secondary)" />
              : <User size={13} color="white" />
            }
          </div>
        )}

        <div className="inbox-message-stack">
          {/* Sender label */}
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

          <div className={`text-sm ${isAdmin ? 'inbox-msg-bubble-admin' : isBot ? 'inbox-msg-bubble-bot' : 'inbox-msg-bubble-customer'}`}>
            {m.message.split('\n').map((line, j) => (
              <span key={j}>{line}<br /></span>
            ))}
          </div>
          <div className={`inbox-msg-timestamp ${isAdmin ? 'is-admin' : 'is-other'}`}>
            {formatTime(m.created_at)}
          </div>
        </div>
      </div>
    );
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  const filteredConvs = conversations.filter(conv => {
    if (statusFilter === 'waiting' && conv.status !== 'waiting_admin') return false;
    if (statusFilter === 'active' && conv.status !== 'active') return false;
    if (statusFilter === 'closed' && conv.status !== 'closed') return false;
    if (searchQuery) {
      const name = conv.profiles?.name?.toLowerCase() || '';
      if (!name.includes(searchQuery.toLowerCase())) return false;
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
                placeholder="Search customer name..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
              />
            </div>

            {/* Status Filter Tabs */}
            <div className="inbox-filter-tabs">
              {['all', 'waiting', 'active', 'closed'].map(status => (
                <button
                  key={status}
                  type="button"
                  onClick={() => setStatusFilter(status)}
                  className={`inbox-filter-tab-btn ${statusFilter === status ? 'active' : ''}`}
                >
                  {status === 'waiting' ? 'Waiting' : status}
                </button>
              ))}
            </div>
          </div>
          <div className="flex-1" style={{ overflowY: 'auto' }}>
            {loadingList ? (
              <div className="flex-center p-md"><Loader size={24} className="animate-spin text-secondary" /></div>
            ) : errorList ? (
              <div className="p-md text-center text-sm" style={{ color: 'var(--error)' }}>
                <p><strong>Error loading chats</strong></p>
                <p className="mt-4">{errorList}</p>
                <button type="button" className="btn btn-ghost btn-sm mt-sm" onClick={() => loadConvs()}>Retry</button>
              </div>
            ) : filteredConvs.length === 0 ? (
              <div className="p-md text-center text-sm text-secondary">
                {conversations.length === 0 ? 'No customer messages yet.' : 'No matching conversations.'}
              </div>
            ) : (
              filteredConvs.map((conv, i) => {
                const isWaiting = conv.status === 'waiting_admin';
                const isClosed = conv.status === 'closed';
                return (
                  <button
                    key={conv.id}
                    onClick={() => { setActiveConv(conv); activeConvRef.current = conv; }}
                    className={`inbox-conversation-item stagger-item ${activeConv?.id === conv.id ? 'active' : ''} ${isWaiting ? 'inbox-conv-waiting' : ''}`}
                    style={{ animationDelay: `${i * 40}ms` }}
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
                      <div className={`inbox-conversation-name ${isClosed ? 'is-closed' : ''}`}>
                        {conv.profiles?.name || 'Unknown Customer'}
                      </div>
                      <div className="inbox-conversation-meta">
                        <ConvStatusBadge
                          status={conv.status}
                          assignedAdmin={conv.assigned_admin?.name}
                        />
                      </div>
                    </div>
                  </button>
                );
              })
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
                <div className="flex gap-8 flex-shrink-0">
                  {activeConv.status !== 'closed' && (
                    <>
                      {!activeConv.assigned_admin_id && (
                        <button className="btn btn-outline btn-sm" onClick={() => handleStatusChange('assigned')}>
                          Assign to Me
                        </button>
                      )}
                      <button className="btn btn-danger btn-sm" onClick={() => handleStatusChange('closed')}>
                        Resolve
                      </button>
                    </>
                  )}
                  {activeConv.status === 'closed' && (
                    <button className="btn btn-primary btn-sm" onClick={() => handleStatusChange('open')}>
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
              <div className="inbox-chat-messages">
                {loadingChat ? (
                  <div className="flex-center h-full"><Loader size={24} className="animate-spin text-secondary" /></div>
                ) : messages.length === 0 ? (
                  <div className="text-center text-sm text-secondary mt-20">No messages yet.</div>
                ) : (
                  messages.map(m => renderMessage(m))
                )}
                <div ref={messagesEndRef} />
              </div>

              {/* Input Area */}
              <div className="inbox-chat-input-area">
                <textarea
                  ref={textareaRef}
                  className="form-input flex-1 inbox-textarea"
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
                  disabled={sending || activeConv.status === 'closed'}
                />
                <button
                  className="btn btn-primary inbox-send-btn"
                  onClick={handleSend}
                  disabled={!input.trim() || sending || activeConv.status === 'closed'}
                >
                  {sending ? <Loader size={18} className="animate-spin" /> : <><Send size={18} /> Reply</>}
                </button>
              </div>
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
