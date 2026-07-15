import { useState, useEffect } from 'react';
import { getContactInquiries, updateContactInquiry } from '../../lib/database';
import { logChat } from '../../lib/activityLog';
import { SkeletonTableRow } from '../../components/ui/SkeletonLoader';
import EmptyState from '../../components/ui/EmptyState';
import ResponsiveFilterControls from '../../components/ui/ResponsiveFilterControls';
import {
  Mail, Phone, Clock, CheckCircle, Eye,
  Loader, MessageSquare, AlertCircle, X
} from 'lucide-react';
import usePageTitle from '../../hooks/usePageTitle';
import FocusTrap from '../../components/ui/FocusTrap';

const STATUS_CONFIG = {
  new: { label: 'New', className: 'badge-warning' },
  read: { label: 'Read', className: 'badge-info' },
  resolved: { label: 'Resolved', className: 'badge-success' },
};

const ContactInquiriesPage = () => {
  usePageTitle('Contact Inquiries');
  const [inquiries, setInquiries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [updating, setUpdating] = useState(null);
  const [selectedInquiry, setSelectedInquiry] = useState(null);
  const [filter, setFilter] = useState('all');

  useEffect(() => { loadInquiries(); }, []);

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

  const handleView = (inquiry) => {
    setSelectedInquiry(inquiry);
    if (inquiry.status === 'new') {
      handleStatusChange(inquiry.id, 'read');
    }
  };

  const handleInquiryRowKeyDown = (event, inquiry) => {
    if (event.target.closest('button, a, input, select, textarea')) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleView(inquiry);
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

  if (error && !loading && inquiries.length === 0) {
    return (
      <div className="page-transition">
        <div className="card text-center" style={{ padding: 40, color: 'var(--error)' }}>
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
          <h1 className="fw-800 text-2xl flex items-center gap-10">
            <Mail size={24} color="var(--primary)" />
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
      <div className="card">
        <div className="table-container">
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Phone</th>
                <th>Message</th>
                <th>Status</th>
                <th>Date</th>
                <th style={{ width: 100 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 5 }, (_, i) => <SkeletonTableRow key={i} cols={6} />)
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ padding: 40 }}>
                    <EmptyState
                      icon={Mail}
                      title="No Inquiries"
                      description={filter !== 'all' ? `No ${filter} inquiries found.` : 'No contact inquiries have been submitted yet.'}
                    />
                  </td>
                </tr>
              ) : (
                filtered.map(inq => {
                  const cfg = STATUS_CONFIG[inq.status] || STATUS_CONFIG.new;
                  return (
                    <tr
                      key={inq.id}
                      className="clickable"
                      role="button"
                      tabIndex={0}
                      aria-label={`View inquiry from ${inq.name}`}
                      style={{
                        background: inq.status === 'new' ? 'var(--warning-bg)' : undefined,
                      }}
                      onClick={() => handleView(inq)}
                      onKeyDown={event => handleInquiryRowKeyDown(event, inq)}
                    >
                      <td data-label="Name">
                        <div className="flex items-center gap-8">
                          <div className="sidebar-user-avatar w-32 h-32 text-xs flex-shrink-0">
                            {(inq.name || '?')[0].toUpperCase()}
                          </div>
                          <span style={{ fontWeight: inq.status === 'new' ? 700 : 500 }}>
                            {inq.name}
                          </span>
                        </div>
                      </td>
                      <td data-label="Phone" className="text-sm text-secondary">
                        {inq.phone || '—'}
                      </td>
                      <td data-label="Message">
                        <div
                          className="text-sm truncate"
                          style={{
                            maxWidth: 280,
                            fontWeight: inq.status === 'new' ? 600 : 400,
                          }}
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
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

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
                background: 'var(--bg-secondary)', borderRadius: 10,
              }} className="p-16 mb-16 flex items-center gap-12">
                <div className="sidebar-user-avatar text-base flex-shrink-0" style={{ width: 44, height: 44 }}>
                  {(selectedInquiry.name || '?')[0].toUpperCase()}
                </div>
                <div>
                  <div className="fw-700 text-base">{selectedInquiry.name}</div>
                  {selectedInquiry.phone && (
                    <div className="text-sm text-secondary flex items-center gap-4 mt-2">
                      <Phone size={12} /> {selectedInquiry.phone}
                    </div>
                  )}
                </div>
                <div className="ml-auto">
                  <span className={`badge ${(STATUS_CONFIG[selectedInquiry.status] || STATUS_CONFIG.new).className}`}>
                    {(STATUS_CONFIG[selectedInquiry.status] || STATUS_CONFIG.new).label}
                  </span>
                </div>
              </div>

              <div className="mb-16">
                <div className="text-xs text-tertiary font-bold mb-6 text-uppercase">
                  Message
                </div>
                <div className="p-16" style={{
                  background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10,
                  fontSize: '0.9375rem', lineHeight: 1.7, whiteSpace: 'pre-wrap',
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
