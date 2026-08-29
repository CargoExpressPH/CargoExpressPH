import { useState, useEffect } from 'react';
import { getContactInquiries, updateContactInquiry, assignInquiry, unassignInquiry } from '../../lib/database';
import { logChat } from '../../lib/activityLog';
import { useAuth } from '../../contexts/AuthContext';
import { SkeletonTableRow } from '../../components/ui/SkeletonLoader';
import EmptyState from '../../components/ui/EmptyState';
import ResponsiveFilterControls from '../../components/ui/ResponsiveFilterControls';
import {
  Mail, Phone, Clock, CheckCircle, Eye, UserCheck,
  Loader, MessageSquare, AlertCircle, X
} from 'lucide-react';
import usePageTitle from '../../hooks/usePageTitle';
import FocusTrap from '../../components/ui/FocusTrap';
import useScrollLock from '../../hooks/useScrollLock';
import { useToast } from '../../hooks/useToast';

const STATUS_CONFIG = {
  new: { label: 'New', className: 'badge-warning' },
  read: { label: 'Read', className: 'badge-info' },
  resolved: { label: 'Resolved', className: 'badge-success' },
};

/**
 * Read an inquiry's contact channels.
 *
 * Prefers the normalized contact_phone / contact_email columns. Falls back to
 * parsing the legacy polymorphic `phone` column (a phone OR an email OR
 * "phone | email") for any row the backfill in
 * 20260803140000_contact_inquiries_normalize.sql did not reach.
 */
const readContact = (inquiry) => {
  if (!inquiry) return { phone: '', email: '' };
  if (inquiry.contact_phone || inquiry.contact_email) {
    return { phone: inquiry.contact_phone || '', email: inquiry.contact_email || '' };
  }
  const v = String(inquiry.phone || '').trim();
  if (!v) return { phone: '', email: '' };
  const parts = v.split('|').map(p => p.trim());
  if (parts.length > 1) return { phone: parts[0], email: parts[1] };
  return parts[0].includes('@') ? { phone: '', email: parts[0] } : { phone: parts[0], email: '' };
};

const getContactHref = (value) => {
  const v = String(value || '').trim();
  if (!v) return null;
  return v.includes('@') ? `mailto:${v}` : `tel:${v.replace(/[^\d+]/g, '')}`;
};

const ContactLink = ({ inquiry, className }) => {
  const { phone, email } = readContact(inquiry);
  const phoneHref = getContactHref(phone);
  const emailHref = getContactHref(email);
  if (!phoneHref && !emailHref) return <span className={className}>—</span>;
  return (
    <span className={className}>
      {phoneHref && (
        <a
          href={phoneHref}
          className="contact-link"
          onClick={e => e.stopPropagation()}
          title={`Call ${phone}`}
        >
          {phone}
        </a>
      )}
      {phoneHref && emailHref && <span className="contact-link-sep"> · </span>}
      {emailHref && (
        <a
          href={emailHref}
          className="contact-link"
          onClick={e => e.stopPropagation()}
          title={`Email ${email}`}
        >
          {email}
        </a>
      )}
    </span>
  );
};

const ContactInquiriesPage = () => {
  usePageTitle('Contact Inquiries');
  const { user, userProfile } = useAuth();
  const toast = useToast();
  const [inquiries, setInquiries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [updating, setUpdating] = useState(null);
  const [selectedInquiry, setSelectedInquiry] = useState(null);
  const [filter, setFilter] = useState('all');

  useEffect(() => { loadInquiries(); }, []);

  // This detail modal is built inline rather than from components/ui, so it was
  // missed when scroll locking and Escape were added to the shared modals.
  // Both hooks sit above the early return below so hook order stays stable.
  useScrollLock(!!selectedInquiry);

  useEffect(() => {
    if (!selectedInquiry) return undefined;
    const handleEscape = (e) => {
      if (e.key === 'Escape') setSelectedInquiry(null);
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [selectedInquiry]);

  const loadInquiries = async () => {
    setError(null);
    setLoading(true);
    try {
      const data = await getContactInquiries();
      setInquiries(data);
    } catch (e) {
      setError(e.message || 'Failed to load contact inquiries.');
    } finally {
      setLoading(false);
    }
  };

  const handleStatusChange = async (id, newStatus) => {
    setUpdating(id);
    try {
      await updateContactInquiry(id, { status: newStatus });
      const inq = inquiries.find(i => i.id === id);
      logChat(`Inquiry Marked ${newStatus}`, id, inq?.name || 'Unknown', { details: `Inquiry status changed to ${newStatus}` });
      setInquiries(prev => prev.map(i => i.id === id ? { ...i, status: newStatus } : i));
      if (selectedInquiry?.id === id) {
        setSelectedInquiry(prev => ({ ...prev, status: newStatus }));
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setUpdating(null);
    }
  };

  // Ownership. Without it nobody is answerable for an inquiry, and with more
  // than one admin two people can answer the same person.
  //
  // The button that calls this is disabled once assigned_admin_id names
  // someone else (see the render below), so this guard only ever fires on a
  // stale render — a page that hasn't re-synced yet still can't steal or
  // release someone else's claim, because assignInquiry/unassignInquiry
  // themselves refuse it server-side. That refusal is the actual boundary;
  // this check just turns it into a clear message instead of a raw error.
  const handleAssign = async (inquiry) => {
    const mine = inquiry.assigned_admin_id === user?.id;
    if (inquiry.assigned_admin_id && !mine) {
      toast.error(`This inquiry is already claimed by ${inquiry.assigned_admin?.name || 'another admin'}.`);
      return;
    }

    setUpdating(inquiry.id);
    try {
      if (mine) {
        await unassignInquiry(inquiry.id);
      } else {
        await assignInquiry(inquiry.id);
      }
      const patch = mine
        ? { assigned_admin_id: null, assigned_admin: null }
        : { assigned_admin_id: user?.id, assigned_admin: { name: userProfile?.name || 'You' } };
      setInquiries(prev => prev.map(i => (i.id === inquiry.id ? { ...i, ...patch } : i)));
      if (selectedInquiry?.id === inquiry.id) setSelectedInquiry(prev => ({ ...prev, ...patch }));
      logChat(mine ? 'Inquiry Released' : 'Inquiry Claimed', inquiry.id, inquiry.name || 'Unknown', {
        details: mine ? 'Returned to the unclaimed pool.' : 'Claimed by admin.',
      });
    } catch (e) {
      // Someone else's claim landed first, or the release target changed —
      // either way the local copy is now wrong. Resync from the server
      // rather than leaving a claim on screen that the write never made.
      toast.error(e.message || 'Failed to update this inquiry.');
      loadInquiries();
    } finally {
      setUpdating(null);
    }
  };

  const handleView = (inquiry) => {
    setSelectedInquiry(inquiry);
    if (inquiry.status === 'new') {
      handleStatusChange(inquiry.id, 'read');
    }
  };

  const filtered = filter === 'all'
    ? inquiries
    : inquiries.filter(i => i.status === filter);

  const newCount = inquiries.filter(i => i.status === 'new').length;
  const filterOptions = ['all', 'new', 'read', 'resolved'].map(f => ({
    value: f,
    label: f === 'all' ? 'All' : f,
    count: f === 'all' ? inquiries.length : inquiries.filter(i => i.status === f).length,
  }));
  const selectedContact = selectedInquiry ? readContact(selectedInquiry) : null;

  if (error && !loading && inquiries.length === 0) {
    return (
      <div className="page-transition">
        <div className="card text-center" style={{ padding: 40, color: 'var(--error-text)' }}>
          <AlertCircle size={32} className="mb-8" />
          <h3>Error</h3>
          <p>{error}</p>
          <button type="button" className="btn btn-primary mt-md" onClick={loadInquiries}>Retry</button>
        </div>
      </div>
    );
  }

  return (
    <div className="page-transition">
      {/* Header */}
      <div className="admin-page-header">
        <div>
          <h1 className="admin-page-title">
            <Mail size={24} color="var(--primary)" aria-hidden="true" />
            Contact Inquiries
            {newCount > 0 && (
              <span className="badge badge-warning text-xs">
                {newCount} new
              </span>
            )}
          </h1>
          <p className="text-secondary text-sm">Messages from the public contact form</p>
        </div>
        <button type="button" className="btn btn-outline btn-sm" onClick={loadInquiries} disabled={loading}>
          {loading ? <Loader size={14} className="animate-spin" /> : 'Refresh'}
        </button>
      </div>

      {/* Filters */}
      <ResponsiveFilterControls
        options={filterOptions}
        value={filter}
        onChange={setFilter}
        ariaLabel="Inquiry status filters"
        label="Status"
        desktopClassName="admin-filter-row"
        buttonClassName={(option, active) => `btn btn-sm ${active ? 'btn-primary' : 'btn-outline'} text-capitalize`}
        className="mb-16"
      />

      {/* Table */}
      {loading ? (
        <div className="card">
          <div className="table-container">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Contact</th>
                  <th scope="col">Message</th>
                  <th scope="col">Status</th>
                  <th scope="col">Date</th>
                  <th scope="col" style={{ width: 100 }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: 5 }, (_, i) => <SkeletonTableRow key={i} cols={6} />)}
              </tbody>
            </table>
          </div>
        </div>
      ) : filtered.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={Mail}
            title="No Inquiries"
            description={filter !== 'all' ? `No ${filter} inquiries found.` : 'No contact inquiries have been submitted yet.'}
          />
        </div>
      ) : (
        <div className="card">
          <div className="table-container">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Contact</th>
                  <th scope="col">Message</th>
                  <th scope="col">Status</th>
                  <th scope="col">Date</th>
                  <th scope="col" style={{ width: 100 }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(inq => {
                  const cfg = STATUS_CONFIG[inq.status] || STATUS_CONFIG.new;
                  return (
                    <tr
                      key={inq.id}
                      className="clickable"
                      style={{
                        background: inq.status === 'new' ? 'var(--warning-bg)' : undefined,
                      }}
                      onClick={() => handleView(inq)}
                    >
                      <td data-label="Name">
                        <div className="flex items-center gap-8">
                          <div className="sidebar-user-avatar w-32 h-32 text-xs flex-shrink-0">
                            {(inq.name || '?')[0].toUpperCase()}
                          </div>
                          <div className="flex flex-col">
                            <span style={{ fontWeight: inq.status === 'new' ? 700 : 500 }}>
                              {inq.name}
                            </span>
                            {inq.assigned_admin_id && (
                              <span className="text-xs text-tertiary flex items-center gap-4">
                                <UserCheck size={10} aria-hidden="true" />
                                {inq.assigned_admin_id === user?.id ? 'You' : (inq.assigned_admin?.name || 'Assigned')}
                              </span>
                            )}
                          </div>
                        </div>
                      </td>
                      <td data-label="Contact" className="text-sm text-secondary">
                        <ContactLink inquiry={inq} className="text-secondary" />
                      </td>
                      <td data-label="Message">
                        <div
                          className="text-sm inquiry-message-preview"
                          style={{ fontWeight: inq.status === 'new' ? 600 : 400 }}
                        >
                          {inq.message}
                        </div>
                      </td>
                      <td data-label="Status">
                        <span className={`badge ${cfg.className}`}>{cfg.label}</span>
                      </td>
                      <td data-label="Date" className="text-sm text-secondary">
                        {new Date(inq.created_at).toLocaleDateString('en-PH', {
                          month: 'short', day: 'numeric', year: 'numeric',
                        })}
                      </td>
                      <td data-label="Actions">
                        <div className="flex gap-4" onClick={e => e.stopPropagation()}>
                          <button
                            className="btn-icon btn-ghost"
                            type="button"
                            title="View"
                            aria-label={`View inquiry from ${inq.name}`}
                            onClick={() => handleView(inq)}
                          >
                            <Eye size={16} />
                          </button>
                          {inq.status !== 'resolved' && (
                            <button
                              className="btn-icon btn-ghost"
                              type="button"
                              title="Mark as Resolved"
                              aria-label={`Mark inquiry from ${inq.name} as resolved`}
                              disabled={updating === inq.id}
                              onClick={() => handleStatusChange(inq.id, 'resolved')}
                            >
                              {updating === inq.id
                                ? <Loader size={14} className="animate-spin" />
                                : <CheckCircle size={16} color="var(--success)" />}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
          </table>
        </div>
      </div>
      )}

      {/* Detail Modal */}
      {selectedInquiry && (
        <FocusTrap active={!!selectedInquiry}>
          <div className="modal-overlay" onClick={() => setSelectedInquiry(null)}>
            <div className="modal" role="dialog" aria-modal="true" aria-labelledby="inquiry-modal-title" onClick={e => e.stopPropagation()} style={{ maxWidth: 520 }}>
              <div className="modal-header">
                <h3 id="inquiry-modal-title" className="flex items-center gap-8">
                <MessageSquare size={18} />
                Inquiry Details
              </h3>
              <button type="button" className="btn-icon btn-ghost" onClick={() => setSelectedInquiry(null)} aria-label="Close inquiry details">
                <X size={18} />
              </button>
            </div>
            <div className="modal-body">
              <div style={{
                background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)',
              }} className="p-16 mb-16 inquiry-identity-row">
                <div className="sidebar-user-avatar text-base flex-shrink-0" style={{ width: 36, height: 36 }}>
                  {(selectedInquiry.name || '?')[0].toUpperCase()}
                </div>
                <div>
                  <div className="fw-700 text-sm">{selectedInquiry.name}</div>
                  {selectedContact.phone && (
                    <div className="text-sm text-secondary flex items-center gap-4 mt-2">
                      <Phone size={12} />
                      <a
                        href={getContactHref(selectedContact.phone)}
                        className="text-secondary text-underline"
                        title={`Call ${selectedContact.phone}`}
                      >
                        {selectedContact.phone}
                      </a>
                    </div>
                  )}
                  {selectedContact.email && (
                    <div className="text-sm text-secondary flex items-center gap-4 mt-2">
                      <Mail size={12} />
                      <a
                        href={getContactHref(selectedContact.email)}
                        className="text-secondary text-underline"
                        title={`Email ${selectedContact.email}`}
                      >
                        {selectedContact.email}
                      </a>
                    </div>
                  )}
                </div>
                <div className="inquiry-identity-actions">
                  <span className={`badge ${(STATUS_CONFIG[selectedInquiry.status] || STATUS_CONFIG.new).className}`}>
                    {(STATUS_CONFIG[selectedInquiry.status] || STATUS_CONFIG.new).label}
                  </span>
                  <button
                    type="button"
                    className={`btn btn-sm ${selectedInquiry.assigned_admin_id ? 'btn-outline' : 'btn-secondary'}`}
                    onClick={() => handleAssign(selectedInquiry)}
                    // Strictly disabled, not just relabelled, once someone else
                    // holds it — a button reading "With [OtherAdmin]" that still
                    // works on click is how a claim gets stolen with one tap.
                    disabled={
                      updating === selectedInquiry.id ||
                      (selectedInquiry.assigned_admin_id && selectedInquiry.assigned_admin_id !== user?.id)
                    }
                    title={
                      selectedInquiry.assigned_admin_id && selectedInquiry.assigned_admin_id !== user?.id
                        ? `Already claimed by ${selectedInquiry.assigned_admin?.name || 'another admin'}`
                        : undefined
                    }
                  >
                    <UserCheck size={13} aria-hidden="true" />
                    {selectedInquiry.assigned_admin_id
                      ? (selectedInquiry.assigned_admin_id === user?.id ? 'Release' : `With ${selectedInquiry.assigned_admin?.name || 'admin'}`)
                      : 'Claim'}
                  </button>
                </div>
              </div>

              {selectedInquiry.first_response_at && (
                <div className="text-xs text-tertiary mb-16 flex items-center gap-4">
                  <Clock size={12} aria-hidden="true" />
                  First actioned {new Date(selectedInquiry.first_response_at).toLocaleString('en-PH', {
                    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
                  })}
                  {' · '}
                  {Math.round(
                    (new Date(selectedInquiry.first_response_at) - new Date(selectedInquiry.created_at)) / 3600000
                  )}h after it arrived
                </div>
              )}

              <div className="mb-16">
                <div className="text-xs text-tertiary font-bold mb-6 text-uppercase">
                  Message
                </div>
                <div className="p-16" style={{
                  background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
                  fontSize: '0.875rem', lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                }}>
                  {selectedInquiry.message}
                </div>
              </div>

              <div className="text-xs text-tertiary flex items-center gap-4">
                <Clock size={12} />
                Submitted {new Date(selectedInquiry.created_at).toLocaleString('en-PH', {
                  month: 'long', day: 'numeric', year: 'numeric',
                  hour: 'numeric', minute: '2-digit', hour12: true,
                })}
              </div>
            </div>
            <div className="modal-footer">
              {selectedInquiry.status !== 'resolved' ? (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => { handleStatusChange(selectedInquiry.id, 'resolved'); }}
                  disabled={updating === selectedInquiry.id}
                >
                  {updating === selectedInquiry.id
                    ? <Loader size={16} className="animate-spin" />
                    : <CheckCircle size={16} />}
                  Mark as Resolved
                </button>
              ) : (
                <span className="text-sm text-secondary flex items-center gap-6">
                  <CheckCircle size={14} color="var(--success)" /> Resolved
                </span>
              )}
              <button type="button" className="btn btn-outline" onClick={() => setSelectedInquiry(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
        </FocusTrap>
      )}
    </div>
  );
};

export default ContactInquiriesPage;
