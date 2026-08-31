import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, Cloud, CloudOff, Database, FileImage,
  HardDrive, Loader, Radio, RefreshCw, ShieldCheck, XCircle, Zap,
} from 'lucide-react';
import {
  checkPhotoStorageHealth, getPhotoStorageEvents, getPhotoStorageMode,
  getPhotoStorageSummary, setPhotoStorageMode,
} from '../../lib/database';
import { supabase } from '../../lib/supabase';
import { useToast } from '../../hooks/useToast';
import usePageTitle from '../../hooks/usePageTitle';
import { formatPhDateTime } from '../../utils/datetime';
import { CenteredSpinner } from '../../components/ui/Loader';
import ConfirmModal from '../../components/ui/ConfirmModal';
import PageTransition from '../../components/ui/PageTransition';

const FORCE_DURATIONS = [
  { value: 30, label: '30 minutes' },
  { value: 60, label: '1 hour' },
  { value: 120, label: '2 hours' },
  { value: 240, label: '4 hours' },
  { value: 480, label: '8 hours' },
  { value: 1440, label: '24 hours' },
];

const providerLabel = (provider) => provider === 'firebase' ? 'Firebase fallback' : provider === 'supabase' ? 'Supabase Storage' : 'System';
const number = (value) => Number(value || 0).toLocaleString('en-PH');

const HealthBadge = ({ provider, health }) => {
  const healthy = health?.status === 'healthy';
  const unavailable = health?.status === 'unavailable';
  const Icon = provider === 'supabase' ? HardDrive : Cloud;
  return (
    <div className="card" style={{ padding: 18, minWidth: 0 }}>
      <div className="flex items-center justify-between gap-12">
        <div className="flex items-center gap-8"><Icon size={19} className="text-primary" /><strong>{providerLabel(provider)}</strong></div>
        <span className={`badge ${healthy ? 'badge-success' : unavailable ? 'badge-error' : 'badge-warning'}`}>
          {healthy ? 'Healthy' : unavailable ? 'Unavailable' : 'Checking'}
        </span>
      </div>
      <p className="text-sm text-secondary" style={{ margin: '10px 0 0' }}>
        {healthy ? 'Connection was verified without changing stored photos.' : unavailable ? 'The latest non-destructive check could not verify this provider.' : 'Run a health check to verify this provider.'}
      </p>
    </div>
  );
};

const StorageMonitoringPage = () => {
  usePageTitle('Photo Storage Monitoring');
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [mode, setMode] = useState(null);
  const [summary, setSummary] = useState(null);
  const [events, setEvents] = useState([]);
  const [health, setHealth] = useState(null);
  const [selectedMode, setSelectedMode] = useState('automatic');
  const [duration, setDuration] = useState(60);
  const [reason, setReason] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const timerRef = useRef(null);

  const load = useCallback(async ({ runHealth = true, quiet = false } = {}) => {
    if (quiet) setRefreshing(true); else setLoading(true);
    try {
      const requests = [getPhotoStorageMode(), getPhotoStorageSummary(), getPhotoStorageEvents()];
      if (runHealth) requests.push(checkPhotoStorageHealth());
      const results = await Promise.allSettled(requests);
      const [modeResult, summaryResult, eventsResult, healthResult] = results;
      if (modeResult.status === 'rejected') throw modeResult.reason;
      setMode(modeResult.value);
      setSelectedMode(modeResult.value?.upload_mode || 'automatic');
      setReason(modeResult.value?.reason || '');
      if (summaryResult.status === 'fulfilled') setSummary(summaryResult.value);
      if (eventsResult.status === 'fulfilled') setEvents(eventsResult.value);
      if (healthResult?.status === 'fulfilled') setHealth(healthResult.value);
      if (summaryResult.status === 'rejected' || eventsResult.status === 'rejected') {
        toast.error('Storage settings loaded, but some monitoring data is unavailable.');
      }
    } catch (error) {
      toast.error(error?.message || 'Could not load photo storage monitoring.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
    const channel = supabase
      .channel('photo-storage-monitoring')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'photo_storage_events' }, () => {
        window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(() => void load({ runHealth: false, quiet: true }), 350);
      })
      .subscribe();
    const healthInterval = window.setInterval(() => void load({ runHealth: true, quiet: true }), 60000);
    return () => {
      window.clearTimeout(timerRef.current);
      window.clearInterval(healthInterval);
      void supabase.removeChannel(channel);
    };
  }, [load]);

  const requestChange = () => {
    if (selectedMode === mode?.upload_mode && selectedMode !== 'force_firebase') {
      toast.info('That upload mode is already active.');
      return;
    }
    setConfirmOpen(true);
  };

  const saveMode = async () => {
    try {
      setSaving(true);
      const expiresAt = selectedMode === 'force_firebase'
        ? new Date(Date.now() + Number(duration) * 60 * 1000).toISOString()
        : null;
      const updated = await setPhotoStorageMode(selectedMode, reason.trim() || null, expiresAt);
      setMode(updated);
      setSelectedMode(updated?.upload_mode || 'automatic');
      setReason(updated?.reason || '');
      setConfirmOpen(false);
      toast.success(selectedMode === 'force_firebase'
        ? `New evidence uploads will use Firebase until ${formatPhDateTime(expiresAt)}.`
        : 'Automatic upload routing is active.');
      await load({ runHealth: false, quiet: true });
    } catch (error) {
      toast.error(error?.message || 'Could not change photo upload routing.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <CenteredSpinner />;

  const isForceActive = mode?.upload_mode === 'force_firebase';
  const countCards = [
    { label: 'Supabase references', value: summary?.supabase_photo_count, icon: HardDrive },
    { label: 'Firebase references', value: summary?.firebase_photo_count, icon: Cloud },
    { label: 'Legacy references', value: summary?.legacy_photo_count, icon: FileImage },
    { label: 'Upload failures (24h)', value: summary?.failures_last_24h, icon: AlertTriangle },
  ];

  return (
    <PageTransition>
      <div className="admin-page-header">
        <div>
          <h1 className="admin-page-title"><Database size={24} color="var(--primary)" aria-hidden="true" />Photo Storage Monitoring</h1>
          <p className="admin-page-subtitle">Monitor photo storage and choose the route for new shipment evidence uploads.</p>
        </div>
        <button className="btn btn-outline" type="button" onClick={() => void load({ runHealth: true, quiet: true })} disabled={refreshing}>
          {refreshing ? <Loader size={16} className="animate-spin" /> : <RefreshCw size={16} />} Refresh
        </button>
      </div>

      <div className={`alert-banner ${isForceActive ? 'alert-banner-warning' : 'alert-banner-success'} mb-16`} role="status">
        {isForceActive ? <Zap size={18} /> : <ShieldCheck size={18} />}
        <span><strong>{isForceActive ? 'Force Firebase is active.' : 'Automatic routing is active.'}</strong>{' '}
          {isForceActive
            ? `New pickup, delivery, and receipt photos go directly to Firebase until ${formatPhDateTime(mode?.force_firebase_expires_at)}.`
            : 'New evidence uses Supabase first, then Firebase only if Supabase fails.'}
          {' '}Existing Supabase photos remain readable in both modes.</span>
      </div>

      <div className="grid grid-2 mb-24">
        <HealthBadge provider="supabase" health={health?.supabase} />
        <HealthBadge provider="firebase" health={health?.firebase} />
      </div>

      <div className="grid grid-4 mb-24">
        {countCards.map(({ label, value, icon: Icon }) => (
          <div className="stat-card stat-card-primary" key={label}>
            <div className="stat-icon"><Icon size={22} /></div>
            <div className="stat-value">{number(value)}</div>
            <div className="stat-label">{label}</div>
          </div>
        ))}
      </div>

      <section className="card admin-section-card mb-24">
        <div className="card-header"><h3><Radio size={17} className="inline mr-8" />New evidence upload routing</h3></div>
        <div className="card-body">
          <p className="text-sm text-secondary" style={{ marginTop: 0 }}>
            This is a temporary operational switch. It never disables the Supabase bucket, moves photos, or changes existing photo links.
          </p>
          <div className="grid grid-2" style={{ marginTop: 16 }}>
            <label className="card" style={{ padding: 16, cursor: 'pointer', border: selectedMode === 'automatic' ? '2px solid var(--primary)' : undefined }}>
              <div className="flex items-start gap-12">
                <input type="radio" name="storage-mode" value="automatic" checked={selectedMode === 'automatic'} onChange={() => setSelectedMode('automatic')} />
                <div><strong>Automatic</strong><p className="text-sm text-secondary" style={{ margin: '6px 0 0' }}>Supabase first. Firebase is used only if the primary upload fails.</p></div>
              </div>
            </label>
            <label className="card" style={{ padding: 16, cursor: 'pointer', border: selectedMode === 'force_firebase' ? '2px solid var(--warning)' : undefined }}>
              <div className="flex items-start gap-12">
                <input type="radio" name="storage-mode" value="force_firebase" checked={selectedMode === 'force_firebase'} onChange={() => setSelectedMode('force_firebase')} />
                <div><strong>Force Firebase for new evidence</strong><p className="text-sm text-secondary" style={{ margin: '6px 0 0' }}>Bypass Supabase for new pickup, delivery, and receipt uploads. It expires automatically.</p></div>
              </div>
            </label>
          </div>

          {selectedMode === 'force_firebase' && (
            <div className="grid grid-2" style={{ marginTop: 16 }}>
              <label className="form-group"><span className="form-label">Automatic expiry</span>
                <select value={duration} onChange={(event) => setDuration(Number(event.target.value))} className="form-select">
                  {FORCE_DURATIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
              <label className="form-group"><span className="form-label">Reason (optional)</span>
                <input className="form-input" maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Example: Supabase maintenance check" />
              </label>
            </div>
          )}
          {selectedMode === 'automatic' && (
            <label className="form-group" style={{ marginTop: 16 }}><span className="form-label">Reason (optional)</span>
              <input className="form-input" maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Example: Primary storage restored" />
            </label>
          )}
          <div className="flex justify-end" style={{ marginTop: 16 }}>
            <button className={`btn ${selectedMode === 'force_firebase' ? 'btn-secondary' : 'btn-primary'}`} type="button" onClick={requestChange} disabled={saving}>
              {selectedMode === 'force_firebase' ? <Zap size={16} /> : <ShieldCheck size={16} />} Apply routing
            </button>
          </div>
        </div>
      </section>

      <section className="card admin-section-card">
        <div className="card-header">
          <h3><CloudOff size={17} className="inline mr-8" />Recent storage activity</h3>
          <span className="text-xs text-secondary">Live updates</span>
        </div>
        {events.length === 0 ? (
          <div className="card-body text-sm text-secondary">No storage activity has been recorded yet.</div>
        ) : (
          <div className="table-container"><table className="data-table"><thead><tr><th scope="col">When</th><th scope="col">Provider</th><th scope="col">Result</th><th scope="col">Type</th><th scope="col">Details</th></tr></thead>
            <tbody>{events.map((event) => {
              const failed = event.outcome === 'failure';
              const Icon = failed ? XCircle : event.outcome === 'expired' ? AlertTriangle : CheckCircle2;
              return <tr key={event.id}>
                <td data-label="When" className="text-sm">{formatPhDateTime(event.created_at)}</td>
                <td data-label="Provider">{providerLabel(event.provider)}</td>
                <td data-label="Result"><span className={`badge ${failed ? 'badge-error' : event.outcome === 'expired' ? 'badge-warning' : 'badge-success'}`}><Icon size={13} /> {event.outcome}</span></td>
                <td data-label="Type">{event.photo_type || 'Routing'}</td>
                <td data-label="Details" className="text-sm text-secondary">{event.message || '—'}</td>
              </tr>;
            })}</tbody>
          </table></div>
        )}
      </section>

      <ConfirmModal
        isOpen={confirmOpen}
        onClose={() => !saving && setConfirmOpen(false)}
        onConfirm={() => void saveMode()}
        title={selectedMode === 'force_firebase' ? 'Route new evidence to Firebase?' : 'Restore Automatic routing?'}
        message={selectedMode === 'force_firebase'
          ? `Only new pickup, delivery, and receipt uploads will bypass Supabase for ${FORCE_DURATIONS.find(option => option.value === duration)?.label || 'the selected period'}. Existing photos remain unchanged.`
          : 'New evidence will use Supabase first and Firebase only if the primary upload fails. Existing photos remain unchanged.'}
        confirmLabel={selectedMode === 'force_firebase' ? 'Enable Force Firebase' : 'Use Automatic'}
        variant={selectedMode === 'force_firebase' ? 'warning' : 'success'}
        loading={saving}
      />
    </PageTransition>
  );
};

export default StorageMonitoringPage;
