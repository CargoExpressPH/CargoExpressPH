import { useState, useEffect, useCallback } from 'react';
import { getActivityLogs } from '../../lib/database';
import { supabase } from '../../lib/supabase';
import Breadcrumb from '../../components/ui/Breadcrumb';
import { SkeletonText } from '../../components/ui/SkeletonLoader';
import CustomSelect from '../../components/ui/CustomSelect';
import usePageTitle from '../../hooks/usePageTitle';
import {
  ClipboardList, Search, Filter, ChevronLeft, ChevronRight,
  Download, Package, Truck, CreditCard, MessageSquare, Shield, Settings,
  RefreshCw, Clock, User
} from 'lucide-react';

const MODULE_COLORS = {
  Orders:         { bg: 'var(--primary-glow)', color: 'var(--primary)', icon: Package },
  Trips:          { bg: 'var(--success-glow)', color: 'var(--success)', icon: Truck },
  Payments:       { bg: 'var(--warning-bg)', color: 'var(--warning)', icon: CreditCard },
  Chat:           { bg: 'color-mix(in srgb, var(--chart-purple) 12%, transparent)', color: 'var(--chart-purple)', icon: MessageSquare },
  Authentication: { bg: 'var(--error-glow)', color: 'var(--error)', icon: Shield },
  System:         { bg: 'var(--border-light)', color: 'var(--text-secondary)', icon: Settings },
};

const MODULES = ['All', 'Orders', 'Trips', 'Payments', 'Chat', 'Authentication', 'System'];

const ModuleBadge = ({ module }) => {
  const cfg = MODULE_COLORS[module] || MODULE_COLORS.System;
  const Icon = cfg.icon;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '2px 8px', borderRadius: 20, fontSize: '0.7rem',
      fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase',
      background: cfg.bg, color: cfg.color,
    }}>
      <Icon size={10} />
      {module}
    </span>
  );
};

const formatDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })
    + ' ' + d.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' });
};

const ActivityLogsPage = () => {
  usePageTitle('Activity Logs');

  const [logs, setLogs] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 50;

  // Filters
  const [search, setSearch] = useState('');
  const [module, setModule] = useState('');
  const [actionFilter, setActionFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [adminList, setAdminList] = useState([]);
  const [adminId, setAdminId] = useState('');

  // Debounced search
  const [searchInput, setSearchInput] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), 400);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Load admin list for dropdown
  useEffect(() => {
    supabase.from('profiles').select('id, name').eq('role', 'admin').order('name')
      .then(({ data }) => setAdminList(data || []));
  }, []);

  const loadLogs = useCallback(async () => {
    setLoading(true);
    try {
      const result = await getActivityLogs({
        module: module || null,
        action: actionFilter || null,
        adminId: adminId || null,
        dateFrom: dateFrom ? `${dateFrom}T00:00:00` : null,
        dateTo: dateTo ? `${dateTo}T23:59:59` : null,
        search: search || null,
        page,
        pageSize: PAGE_SIZE,
      });
      setLogs(result.logs);
      setTotal(result.total);
    } catch (err) {
      console.error('Failed to load activity logs:', err);
    } finally {
      setLoading(false);
    }
  }, [module, actionFilter, adminId, dateFrom, dateTo, search, page]);

  useEffect(() => {
    setPage(1);
  }, [module, actionFilter, adminId, dateFrom, dateTo, search]);

  useEffect(() => {
    loadLogs();
  }, [loadLogs]);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  const exportCSV = () => {
    const headers = ['Date & Time', 'Admin', 'Module', 'Action', 'Reference', 'Details'];
    const rows = logs.map(l => [
      formatDate(l.created_at),
      l.admin_name,
      l.module,
      l.action,
      l.record_ref || '',
      l.details || '',
    ]);
    const csv = [headers, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `activity-logs-${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="page-transition">
      <Breadcrumb items={[
        { label: 'Dashboard', to: '/admin' },
        { label: 'Activity Logs' },
      ]} />

      <div className="flex items-center justify-between mb-8 flex-wrap gap-12">
        <div>
          <h1 className="fw-800 text-2xl flex items-center gap-10">
            <ClipboardList size={26} color="var(--primary)" />
            Activity Logs
          </h1>
          <p className="text-secondary text-sm mt-4">Complete audit trail of all admin actions</p>
        </div>
        <div className="flex items-center gap-8">
          <button className="btn btn-ghost btn-sm" onClick={loadLogs} title="Refresh">
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
          </button>
          <button className="btn btn-outline btn-sm" onClick={exportCSV} disabled={logs.length === 0}>
            <Download size={15} /> Export CSV
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="card mb-16 stagger-item activity-logs-filters">
        <div className="card-body">
          <div className="flex items-center gap-8 mb-12">
            <Filter size={14} color="var(--text-secondary)" />
            <span className="text-xs text-secondary font-bold text-uppercase">Filters</span>
          </div>
          <div className="activity-logs-filter-grid">
            <div className="form-group m-0">
              <label className="form-label">Search</label>
              <div className="form-input-wrapper">
                <Search size={15} className="form-input-icon" />
                <input
                  type="text"
                  className="form-input form-input-icon-left"
                  placeholder="Action, admin, ref..."
                  value={searchInput}
                  onChange={e => setSearchInput(e.target.value)}
                />
              </div>
            </div>

            <div className="form-group m-0">
              <label className="form-label">Module</label>
              <CustomSelect className="form-control" value={module} onChange={e => setModule(e.target.value)}>
                {MODULES.map(m => <option key={m} value={m === 'All' ? '' : m}>{m}</option>)}
              </CustomSelect>
            </div>

            <div className="form-group m-0">
              <label className="form-label">Action</label>
              <input
                type="text"
                className="form-control"
                placeholder="Filter by action..."
                value={actionFilter}
                onChange={e => setActionFilter(e.target.value)}
              />
            </div>

            <div className="form-group m-0">
              <label className="form-label">Admin</label>
              <CustomSelect className="form-control" value={adminId} onChange={e => setAdminId(e.target.value)}>
                <option value="">All Admins</option>
                {adminList.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </CustomSelect>
            </div>

            <div className="form-group m-0">
              <label className="form-label">From Date</label>
              <input type="date" className="form-control" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
            </div>

            <div className="form-group m-0">
              <label className="form-label">To Date</label>
              <input type="date" className="form-control" value={dateTo} onChange={e => setDateTo(e.target.value)} />
            </div>

            <div className="form-group m-0 flex items-end">
              <button className="btn btn-ghost btn-sm w-full" onClick={() => {
                setSearchInput(''); setSearch(''); setModule(''); setActionFilter(''); setAdminId(''); setDateFrom(''); setDateTo('');
              }}>Clear Filters</button>
            </div>
          </div>
        </div>
      </div>
      {/* Results summary */}
      <div className="flex items-center justify-between mb-12 text-sm text-secondary">
        <span>{total.toLocaleString()} {total === 1 ? 'entry' : 'entries'} found</span>
        {totalPages > 1 && (
          <span>Page {page} of {totalPages}</span>
        )}
      </div>

      {/* Table */}
      <div className="card stagger-item activity-logs-table-card">
        {loading ? (
          <div className="card-body"><SkeletonText lines={8} /></div>
        ) : logs.length === 0 ? (
          <div className="card-body text-center" style={{ padding: '48px 24px' }}>
            <ClipboardList size={40} style={{ opacity: 0.25, margin: '0 auto 12px' }} />
            <p className="text-secondary">No activity logs found.</p>
            <p className="text-xs text-tertiary mt-4">Actions performed by admins will appear here.</p>
          </div>
        ) : (
          <div className="table-container">
            <table className="data-table">
              <thead>
                <tr>
                  {['Date & Time', 'Admin', 'Module', 'Action', 'Reference', 'Details'].map(h => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr key={log.id}>
                    <td data-label="Date & Time">
                      <div className="flex items-center gap-6 text-secondary">
                        <Clock size={12} />
                        {formatDate(log.created_at)}
                      </div>
                    </td>
                    <td data-label="Admin">
                      <div className="flex items-center gap-6">
                        <User size={12} color="var(--text-tertiary)" />
                        <span className="font-bold">{log.admin_name}</span>
                      </div>
                    </td>
                    <td data-label="Module">
                      <ModuleBadge module={log.module} />
                    </td>
                    <td data-label="Action" className="font-semibold">
                      {log.action}
                    </td>
                    <td data-label="Reference">
                      {log.record_ref ? (
                        <span style={{
                          fontFamily: 'monospace',
                          background: 'var(--bg-secondary)',
                          padding: '2px 7px',
                          borderRadius: 4,
                          fontSize: '0.78rem',
                          border: '1px solid var(--border)',
                        }}>{log.record_ref}</span>
                      ) : '—'}
                    </td>
                    <td data-label="Details" className="details-cell">
                      <span style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                        {log.details || '—'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-8 mt-16">
          <button
            className="btn btn-outline btn-sm"
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page === 1}
          >
            <ChevronLeft size={16} /> Prev
          </button>
          <span className="text-sm text-secondary">
            {page} / {totalPages}
          </span>
          <button
            className="btn btn-outline btn-sm"
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
          >
            Next <ChevronRight size={16} />
          </button>
        </div>
      )}
    </div>
  );
};

export default ActivityLogsPage;
