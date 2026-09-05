import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, Cloud, CloudOff, Database,
  HardDrive, Loader, Package, Radio, Receipt, ShieldCheck, Sparkles, Truck, XCircle, Zap,
} from 'lucide-react';
import {
  checkPhotoStorageHealth, checkUnusedPhotos, getPhotoStorageEvents,
  getPhotoStorageMode, getPhotoStorageSummary, removeUnusedPhotos, setPhotoStorageMode,
} from '../../lib/database';
import { supabase } from '../../lib/supabase';
import { useToast } from '../../hooks/useToast';
import usePageTitle from '../../hooks/usePageTitle';
import { formatPhDateTime } from '../../utils/datetime';
import { CenteredSpinner } from '../../components/ui/Loader';
import ConfirmModal from '../../components/ui/ConfirmModal';
import Pagination from '../../components/ui/Pagination';

const EVENTS_PAGE_SIZE = 10;

const FORCE_DURATIONS = [
  { value: 30, label: '30 minutes' },
  { value: 60, label: '1 hour' },
  { value: 120, label: '2 hours' },
  { value: 240, label: '4 hours' },
  { value: 480, label: '8 hours' },
  { value: 1440, label: '24 hours' },
];

const providerLabel = (provider) => provider === 'firebase' ? 'Backup Photos' : provider === 'supabase' ? 'Main Storage' : 'Photo Storage';
const photoTypeLabel = (type) => type === 'pickup' ? 'Pickup photo' : type === 'delivery' ? 'Delivery photo' : type === 'receipt' ? 'Receipt photo' : 'Photo';
const number = (value) => Number(value || 0).toLocaleString('en-PH');
const formatBytes = (value) => {
  if (value == null || !Number.isFinite(Number(value))) return 'Unavailable';
  const bytes = Number(value);
  if (bytes < 1024) return `${bytes.toLocaleString('en-PH')} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let amount = bytes;
  let unit = -1;
  do { amount /= 1024; unit += 1; } while (amount >= 1024 && unit < units.length - 1);
  return `${amount.toLocaleString('en-PH', { maximumFractionDigits: amount >= 100 ? 0 : 2 })} ${units[unit]}`;
};

const planLabel = (plan) => plan && plan !== 'unknown'
  ? `${plan.charAt(0).toUpperCase()}${plan.slice(1)} Plan`
  : 'Plan unavailable';

const storageAreaLabel = (bucketId) => bucketId === 'cargo-photos'
  ? 'Shipment photos'
  : bucketId === 'company-assets' ? 'Company images' : 'Other photos';

const activityName = (event) => {
  if (event.event_type === 'cleanup') {
    return event.metadata?.cleanup_kind === 'scheduled_old_photos' || event.metadata?.cleanup_kind === 'auto_archive'
      ? 'Old photos removed'
      : 'Unused photos removed';
  }
  if (event.event_type === 'mode_change') return 'Photo saving preference changed';
  if (event.event_type === 'health_check') return 'Storage check completed';
  if (event.event_type === 'upload') return event.outcome === 'success' ? `${photoTypeLabel(event.photo_type)} saved` : `${photoTypeLabel(event.photo_type)} not saved`;
  return 'Photo storage updated';
};

const activityStatus = (event) => event.outcome === 'failure'
  ? 'Needs attention'
  : event.outcome === 'expired' ? 'Ended automatically' : 'Completed';

const activityDetails = (event) => {
  const metadata = event.metadata || {};
  if (event.event_type === 'cleanup') {
    const oldPhotoCleanup = metadata.cleanup_kind === 'scheduled_old_photos' || metadata.cleanup_kind === 'auto_archive';
    const removed = Number(oldPhotoCleanup ? metadata.files_deleted : metadata.deleted_count) || 0;
    const failed = Number(oldPhotoCleanup
      ? Number(metadata.orders_failed || 0) + Number(metadata.files_failed || 0)
      : metadata.failed_count) || 0;
    const pending = Number(metadata.files_pending || 0);
    if (failed > 0) return `${removed} photo${removed === 1 ? '' : 's'} removed. The remaining work will be tried again automatically.`;
    if (pending > 0) return `${removed} photo${removed === 1 ? '' : 's'} removed. ${pending} more ${pending === 1 ? 'photo is' : 'photos are'} waiting for the next cleanup.`;
    return `${removed} photo${removed === 1 ? '' : 's'} permanently removed.`;
  }
  if (event.event_type === 'mode_change') {
    return metadata.upload_mode === 'force_firebase'
      ? 'New pickup, delivery, and receipt photos will use Firebase Backup for a limited time.'
      : 'New photos will use Supabase first and Firebase Backup only when needed.';
  }
  if (event.event_type === 'upload') {
    if (event.outcome === 'failure') return 'The photo could not be saved. Check the related order and try again.';
    return event.provider === 'firebase'
      ? 'The photo was safely saved in Firebase Backup.'
      : 'The photo was saved in Supabase.';
  }
  return event.outcome === 'failure' ? 'The check found a problem that needs attention.' : 'The photo storage check finished successfully.';
};

const HealthBadge = ({ provider, health, liveStatus }) => {
  const offline = liveStatus === 'offline';
  const reconnecting = liveStatus !== 'live' && !offline;
  const healthy = !offline && !reconnecting && health?.status === 'healthy';
  const unavailable = !offline && !reconnecting && health?.status === 'unavailable';
  const Icon = provider === 'supabase' ? HardDrive : Cloud;
  const statusText = offline ? 'Offline' : healthy ? 'Ready' : unavailable ? 'Not Ready' : 'Checking';
  const statusClass = healthy ? 'badge-success' : offline || unavailable ? 'badge-error' : 'badge-warning';
  const details = offline
    ? 'Waiting for the internet connection to return.'
    : reconnecting
      ? 'Refreshing the latest storage status.'
      : healthy
        ? 'Photos can be saved here.'
        : unavailable ? 'Photos cannot be saved here right now.' : 'Please wait while the system checks.';
  return (
    <div className="card" style={{ padding: 18, minWidth: 0 }}>
      <div className="flex items-center justify-between gap-12">
        <div className="flex items-center gap-8"><Icon size={19} className="text-primary" /><strong>{providerLabel(provider)}</strong></div>
        <span className={`badge ${statusClass}`}>{statusText}</span>
      </div>
      <p className="text-sm text-secondary" style={{ margin: '10px 0 0' }}>{details}</p>
    </div>
  );
};

const PhotoStorageTab = () => {
  usePageTitle('Storage Monitoring — Photo Storage');
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [mode, setMode] = useState(null);
  const [summary, setSummary] = useState(null);
  const [events, setEvents] = useState([]);
  const [eventsCount, setEventsCount] = useState(0);
  const [eventsPage, setEventsPage] = useState(1);
  const [health, setHealth] = useState(null);
  const [selectedMode, setSelectedMode] = useState('automatic');
  const [duration, setDuration] = useState(60);
  const [reason, setReason] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [cleanupConfirmOpen, setCleanupConfirmOpen] = useState(false);
  const [cleanupPreview, setCleanupPreview] = useState(null);
  // Collapsed by default: Backup Photos and the routing override are
  // secondary to "is the main photo storage okay," which is what an admin
  // checks this page for. Technical Details holds the provider-level
  // numbers (bytes, plan names, bucket names) that only matter when
  // something needs deeper investigation.
  const [showBackup, setShowBackup] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showTechnical, setShowTechnical] = useState(false);
  const [liveStatus, setLiveStatus] = useState(() => (
    typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'connecting'
  ));
  const liveUpdateTimerRef = useRef(null);
  const eventsPageRef = useRef(1);

  useEffect(() => {
    eventsPageRef.current = eventsPage;
  }, [eventsPage]);

  const load = useCallback(async ({ runHealth = true, quiet = false } = {}) => {
    if (!quiet) setLoading(true);
    try {
      const requests = [getPhotoStorageMode(), getPhotoStorageSummary()];
      if (runHealth) requests.push(checkPhotoStorageHealth());
      const results = await Promise.allSettled(requests);
      const [modeResult, summaryResult, healthResult] = results;
      if (modeResult.status === 'rejected') throw modeResult.reason;
      setMode(modeResult.value);
      setSelectedMode(modeResult.value?.upload_mode || 'automatic');
      setReason(modeResult.value?.reason || '');
      if (summaryResult.status === 'fulfilled') setSummary(summaryResult.value);
      if (healthResult?.status === 'fulfilled') setHealth(healthResult.value);
      if (summaryResult.status === 'rejected') {
        toast.error('Photo settings loaded, but some information could not be shown.');
      }
    } catch (error) {
      toast.error(error?.message || 'Could not load Photo Storage.');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  const loadEvents = useCallback(async (page) => {
    try {
      const { data, count } = await getPhotoStorageEvents({ page, pageSize: EVENTS_PAGE_SIZE });
      setEvents(data);
      setEventsCount(count);
    } catch (error) {
      toast.error(error?.message || 'Could not load Recent Photo Activity.');
    }
  }, [toast]);

  useEffect(() => {
    void loadEvents(eventsPage);
  }, [eventsPage, loadEvents]);

  useEffect(() => {
    let active = true;
    const isOnline = () => typeof navigator === 'undefined' || navigator.onLine;

    void load();

    const scheduleLiveUpdate = ({ runHealth = true, delay = 350 } = {}) => {
      window.clearTimeout(liveUpdateTimerRef.current);
      liveUpdateTimerRef.current = window.setTimeout(() => {
        if (active && isOnline() && document.visibilityState === 'visible') {
          void load({ runHealth, quiet: true });
          void loadEvents(eventsPageRef.current);
        }
      }, delay);
    };

    const channel = supabase
      .channel('photo-storage-monitoring')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'photo_storage_events' }, () => {
        // Every managed upload, fallback, cleanup, and mode change records an
        // event. Recheck the complete monitor so totals, capacity, health,
        // mode, and recent activity move together without a manual refresh.
        scheduleLiveUpdate({ runHealth: true });
      })
      .subscribe((status) => {
        if (!active) return;
        if (!isOnline()) {
          setLiveStatus('offline');
        } else if (status === 'SUBSCRIBED') {
          setLiveStatus('live');
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          setLiveStatus('reconnecting');
        }
      });

    // Provider outages and dashboard-side changes do not always create a
    // database event. Reconcile them automatically while this page is open.
    const healthInterval = window.setInterval(() => {
      if (isOnline() && document.visibilityState === 'visible') {
        void load({ runHealth: true, quiet: true });
      }
    }, 60000);

    const refreshWhenVisible = () => {
      if (isOnline() && document.visibilityState === 'visible') scheduleLiveUpdate({ runHealth: true });
    };
    const handleOffline = () => {
      window.clearTimeout(liveUpdateTimerRef.current);
      setLiveStatus('offline');
    };
    const handleOnline = () => {
      // Realtime reconnects automatically, while this full reload recovers any
      // events and totals that changed during the offline gap.
      setLiveStatus('reconnecting');
      supabase.realtime.connect();
      scheduleLiveUpdate({ runHealth: true, delay: 750 });
    };
    window.addEventListener('focus', refreshWhenVisible);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    document.addEventListener('visibilitychange', refreshWhenVisible);

    return () => {
      active = false;
      window.clearTimeout(liveUpdateTimerRef.current);
      window.clearInterval(healthInterval);
      window.removeEventListener('focus', refreshWhenVisible);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
      void supabase.removeChannel(channel);
    };
  }, [load, loadEvents]);

  const requestChange = () => {
    if (selectedMode === mode?.upload_mode && selectedMode !== 'force_firebase') {
      toast.info('That photo saving option is already active.');
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
        ? `New photos will use Firebase Backup until ${formatPhDateTime(expiresAt)}.`
        : 'Automatic photo saving is active.');
      await load({ runHealth: false, quiet: true });
      // Jump to page 1 so the mode-change event this just produced is visible.
      setEventsPage(1);
    } catch (error) {
      toast.error(error?.message || 'Could not change where new photos are saved.');
    } finally {
      setSaving(false);
    }
  };

  const previewCleanup = async () => {
    try {
      setCleaning(true);
      const preview = await checkUnusedPhotos();
      if (!preview?.candidate_count) {
        toast.success('No unused photos were found. Nothing was deleted.');
        setCleanupPreview(null);
        setCleanupConfirmOpen(false);
        return;
      }
      setCleanupPreview(preview);
      setCleanupConfirmOpen(true);
    } catch (error) {
      toast.error(error?.message || 'Could not check for unused photos.');
    } finally {
      setCleaning(false);
    }
  };

  const runCleanup = async () => {
    try {
      setCleaning(true);
      const result = await removeUnusedPhotos(cleanupPreview?.confirmation_token);
      setCleanupConfirmOpen(false);
      setCleanupPreview(null);
      const deleted = result?.deleted_count || 0;
      const freed = formatBytes(result?.freed_bytes);
      toast.success(`${deleted} unused photo${deleted === 1 ? '' : 's'} permanently removed${freed !== 'Unavailable' ? `, freeing ${freed}` : ''}.`);
      if (result?.failed_count) {
        toast.error(`${result.failed_count} photo${result.failed_count === 1 ? '' : 's'} could not be removed. See Recent Photo Activity.`);
      }
      await load({ runHealth: true, quiet: true });
      // Jump to page 1 so the cleanup events this just produced are visible.
      setEventsPage(1);
    } catch (error) {
      setCleanupConfirmOpen(false);
      setCleanupPreview(null);
      toast.error(error?.message || 'Could not remove unused photos. Check again and retry.');
    } finally {
      setCleaning(false);
    }
  };

  if (loading) return <CenteredSpinner />;

  const isForceActive = mode?.upload_mode === 'force_firebase';

  const liveStorage = health?.supabase_storage;
  const usedBytes = liveStorage?.total_size_bytes == null ? null : Number(liveStorage.total_size_bytes);
  const quotaBytes = liveStorage?.included_storage_bytes == null ? null : Number(liveStorage.included_storage_bytes);
  const usagePercent = usedBytes != null && quotaBytes > 0 ? (usedBytes / quotaBytes) * 100 : null;
  const boundedPercent = usagePercent == null ? 0 : Math.max(0, Math.min(usagePercent, 100));
  const availableBytes = usedBytes != null && quotaBytes > 0 ? Math.max(0, quotaBytes - usedBytes) : null;
  const usageTone = usagePercent >= 95 ? 'var(--error)' : usagePercent >= 80 ? 'var(--warning)' : 'var(--success)';

  // Firebase fallback = the photoFallbacks Firestore collection (there is no
  // Cloud Storage bucket in this app's Firebase project — see store-photo-fallback).
  const firebaseStorage = health?.firebase_storage;
  const firebaseEstimatedBytes = firebaseStorage?.estimated_photo_data_bytes == null
    ? null
    : Number(firebaseStorage.estimated_photo_data_bytes);
  const firebaseFreePlanReference = firebaseStorage?.free_tier_reference_bytes == null
    ? null
    : Number(firebaseStorage.free_tier_reference_bytes);
  const firebaseGuideRemainingBytes = firebaseEstimatedBytes != null && firebaseFreePlanReference > 0
    ? Math.max(0, firebaseFreePlanReference - firebaseEstimatedBytes)
    : null;
  const liveStatusClass = liveStatus === 'live'
    ? 'badge-success'
    : liveStatus === 'offline' ? 'badge-error' : 'badge-warning';
  const liveStatusText = liveStatus === 'live'
    ? 'Live updates on'
    : liveStatus === 'offline' ? 'Offline — updates paused' : 'Reconnecting…';
  const storageBadge = (available) => {
    if (liveStatus === 'offline') return { className: 'badge-error', text: 'Offline' };
    if (liveStatus !== 'live') return { className: 'badge-warning', text: 'Checking' };
    return available
      ? { className: 'badge-success', text: 'Live' }
      : { className: 'badge-warning', text: 'Unavailable' };
  };
  const supabaseStorageBadge = storageBadge(liveStorage?.live_usage_status === 'available');
  const firebaseStorageBadge = storageBadge(firebaseStorage?.status === 'available');

  // Plain-language status for the overview card. These three labels are a
  // new UX layer only — they sit on top of the SAME 80%/95% color
  // breakpoints already used above (`usageTone`), and on the same
  // healthy/unavailable signal `HealthBadge` already reads. No new backend
  // rule is introduced; this just gives the existing numbers a one-word
  // plain-English answer instead of a raw percentage.
  const overviewStatus = (() => {
    if (liveStatus === 'offline') {
      return { badgeClass: 'badge-warning', label: 'Checking', text: 'Waiting for the internet connection to return.' };
    }
    if (health?.supabase?.status === 'unavailable') {
      return {
        badgeClass: 'badge-error',
        label: 'Action Needed',
        text: 'Photos cannot be saved to the main storage right now. New photos are automatically using Backup Photos until this is fixed.',
      };
    }
    if (usagePercent == null) {
      return liveStorage?.live_usage_status === 'available'
        ? { badgeClass: 'badge-info', label: 'No Fixed Limit', text: 'This plan does not have a fixed storage limit, so a fill percentage is not available.' }
        : { badgeClass: 'badge-warning', label: 'Checking', text: 'Storage use could not be checked just now. This will update automatically.' };
    }
    if (usagePercent >= 95) {
      return { badgeClass: 'badge-error', label: 'Action Needed', text: 'Photo storage is almost full. New photos may fail to save — clear unused photos or use Backup Photos soon.' };
    }
    if (usagePercent >= 80) {
      return { badgeClass: 'badge-warning', label: 'Getting Full', text: 'Space is filling up. Consider clearing unused photos soon.' };
    }
    return { badgeClass: 'badge-success', label: 'Good', text: 'You have enough room for new photos.' };
  })();

  const failuresLast24h = Number(summary?.failures_last_24h || 0);

  const usageCards = [
    { label: 'Pickup Photos', value: summary?.pickup_photo_count, icon: Package },
    { label: 'Delivery Photos', value: summary?.delivery_photo_count, icon: Truck },
    { label: 'Receipt Photos', value: summary?.receipt_photo_count, icon: Receipt },
  ];

  return (
    <div>
      <div className="admin-page-header">
        <div>
          <h1 className="admin-page-title"><Database size={24} color="var(--primary)" aria-hidden="true" />Photo Storage</h1>
          <p className="admin-page-subtitle">Check available space for shipment photos and choose what to do if it's getting full.</p>
        </div>
        <div className="flex items-center gap-8">
          <span className={`badge ${liveStatusClass}`} role="status" aria-live="polite">
            {liveStatus === 'offline' ? <CloudOff size={13} aria-hidden="true" /> : <Radio size={13} aria-hidden="true" />}
            {' '}{liveStatusText}
          </span>
          <button className="btn btn-outline" type="button" onClick={() => void previewCleanup()} disabled={cleaning}>
            {cleaning ? <Loader size={16} className="animate-spin" /> : <Sparkles size={16} />} Check Unused Photos
          </button>
        </div>
      </div>

      <div className={`alert-banner ${isForceActive ? 'alert-banner-warning' : 'alert-banner-success'} mb-16`} role="status">
        {isForceActive ? <Zap size={18} /> : <ShieldCheck size={18} />}
        <span><strong>{isForceActive ? 'Backup Photos is temporarily handling new photos.' : 'Automatic photo saving is on.'}</strong>{' '}
          {isForceActive
            ? `This will return to Automatic on ${formatPhDateTime(mode?.force_firebase_expires_at)}.`
            : 'New photos are saved to the main photo storage. Backup Photos is used automatically only if that ever fails.'}
          {' '}Existing photos stay where they are and remain available.</span>
      </div>

      {/* ── Overview: the one card that answers "is storage okay?" ──────── */}
      <section className="card admin-section-card mb-24">
        <div className="card-header">
          <h3><HardDrive size={17} className="inline mr-8" />Storage Usage</h3>
          <span className={`badge ${overviewStatus.badgeClass}`}>{overviewStatus.label}</span>
        </div>
        <div className="card-body">
          {usagePercent != null && (
            <div className="flex items-center justify-between text-sm mb-8">
              <span>{usagePercent.toLocaleString('en-PH', { maximumFractionDigits: 0 })}% used · {formatBytes(usedBytes)} of {formatBytes(quotaBytes)}</span>
              {availableBytes != null && <span className="text-secondary">{formatBytes(availableBytes)} left</span>}
            </div>
          )}
          {usagePercent != null && (
            <div
              role="progressbar"
              aria-label="Photo storage used"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(boundedPercent)}
              style={{ height: 12, borderRadius: 999, overflow: 'hidden', background: 'var(--bg-secondary)' }}
            >
              <div style={{ width: `${boundedPercent}%`, height: '100%', background: usageTone, borderRadius: 999, transition: 'width 300ms ease' }} />
            </div>
          )}
          <p className="text-sm text-secondary" style={{ margin: usagePercent != null ? '12px 0 0' : 0 }}>{overviewStatus.text}</p>

          {failuresLast24h > 0 && (
            <div className="alert-banner alert-banner-warning mt-16" role="status">
              <AlertTriangle size={17} />
              <span>{failuresLast24h} photo{failuresLast24h === 1 ? '' : 's'} failed to save in the last 24 hours. See Recent Photo Activity below for which ones.</span>
            </div>
          )}

          <div style={{ marginTop: 20 }}>
            <div className="text-xs text-secondary mb-8">What's using the space</div>
            <div className="grid grid-3">
              {usageCards.map(({ label, value, icon: Icon }) => (
                <div className="flex items-center gap-8 card" style={{ padding: 12 }} key={label}>
                  <Icon size={16} className="text-secondary" aria-hidden="true" />
                  <div><div className="text-sm">{label}</div><strong>{number(value)}</strong></div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <div className="alert-banner alert-banner-info mb-24" role="status">
        <Sparkles size={18} />
        <span><strong>Automatic cleanup:</strong> Every day, pickup and delivery photos are permanently removed once an order has been Delivered or Cancelled for more than 6 months. Receipt photos and photos featured on the public website are always kept. This is permanent — there is no archive copy.</span>
      </div>

      {/* ── Backup Photos: secondary, collapsed by default ──────────────── */}
      <section className="card admin-section-card mb-24">
        <button
          type="button"
          className="card-header"
          style={{ width: '100%', border: 0, background: 'transparent', cursor: 'pointer' }}
          onClick={() => setShowBackup(v => !v)}
          aria-expanded={showBackup}
        >
          <h3><Cloud size={17} className="inline mr-8" />Backup Photos <span className="text-secondary text-sm" style={{ fontWeight: 400 }}>· {number(summary?.firebase_photo_count)} in use</span></h3>
          <span className="flex items-center gap-8">
            <span className={`badge ${firebaseStorageBadge.className}`}>{firebaseStorageBadge.text}</span>
            {showBackup ? <ChevronUp size={18} aria-hidden="true" /> : <ChevronDown size={18} aria-hidden="true" />}
          </span>
        </button>
        {showBackup && (
          <div className="card-body">
            <p className="text-sm text-secondary" style={{ marginTop: 0 }}>
              Backup Photos is used automatically only when a new photo cannot be saved to the main photo storage.
            </p>
            <div className="grid grid-2 mb-16">
              <div><div className="text-xs text-secondary">Photos in use</div><strong>{number(summary?.firebase_photo_count)}</strong></div>
              <div><div className="text-xs text-secondary">Estimated space used</div><strong>{formatBytes(firebaseEstimatedBytes)}</strong></div>
              <div><div className="text-xs text-secondary">Reference limit</div><strong>{firebaseFreePlanReference != null ? formatBytes(firebaseFreePlanReference) : 'Unavailable'}</strong></div>
              <div><div className="text-xs text-secondary">Estimated space left</div><strong>{formatBytes(firebaseGuideRemainingBytes)}</strong></div>
            </div>

            {firebaseStorage?.status !== 'available' && (
              <div className="alert-banner alert-banner-warning" role="status">
                <AlertTriangle size={17} />
                <span>Backup Photos could not be checked. Live monitoring will try again automatically.</span>
              </div>
            )}

            <p className="text-xs text-secondary" style={{ margin: '16px 0 0' }}>
              Photos in use are linked to current pickup, delivery, or receipt records. The space estimate includes all saved backup photo data
              {firebaseStorage?.measured_at ? ` checked on ${formatPhDateTime(firebaseStorage.measured_at)}` : ''}.
              {' '}The reference limit and space-left amount are a published guide, not a detected live limit for this account.
            </p>
          </div>
        )}
      </section>

      {/* ── Advanced routing override: secondary, collapsed by default ──── */}
      <section className="card admin-section-card mb-24">
        <button
          type="button"
          className="card-header"
          style={{ width: '100%', border: 0, background: 'transparent', cursor: 'pointer' }}
          onClick={() => setShowAdvanced(v => !v)}
          aria-expanded={showAdvanced}
        >
          <h3><Radio size={17} className="inline mr-8" />Advanced: Where New Photos Are Saved <span className="text-secondary text-sm" style={{ fontWeight: 400 }}>· {isForceActive ? 'Backup Photos (temporary)' : 'Automatic'}</span></h3>
          {showAdvanced ? <ChevronUp size={18} aria-hidden="true" /> : <ChevronDown size={18} aria-hidden="true" />}
        </button>
        {showAdvanced && (
        <div className="card-body">
          <p className="text-sm text-secondary" style={{ marginTop: 0 }}>
            This choice affects only new pickup, delivery, and receipt photos. Existing photos stay where they are. Most admins will not need to change this — it exists as a safety valve if the main photo storage is having problems.
          </p>
          <div className="grid grid-2" style={{ marginTop: 16 }}>
            <label className="card" style={{ padding: 16, cursor: 'pointer', border: selectedMode === 'automatic' ? '2px solid var(--primary)' : undefined }}>
              <div className="flex items-start gap-12">
                <input type="radio" name="storage-mode" value="automatic" checked={selectedMode === 'automatic'} onChange={() => setSelectedMode('automatic')} />
                <div><strong>Automatic (recommended)</strong><p className="text-sm text-secondary" style={{ margin: '6px 0 0' }}>Save to the main photo storage first. Use Backup Photos automatically only if that fails.</p></div>
              </div>
            </label>
            <label className="card" style={{ padding: 16, cursor: 'pointer', border: selectedMode === 'force_firebase' ? '2px solid var(--warning)' : undefined }}>
              <div className="flex items-start gap-12">
                <input type="radio" name="storage-mode" value="force_firebase" checked={selectedMode === 'force_firebase'} onChange={() => setSelectedMode('force_firebase')} />
                <div><strong>Use Backup Photos temporarily</strong><p className="text-sm text-secondary" style={{ margin: '6px 0 0' }}>Save all new photos to Backup Photos for the selected time, then return to Automatic.</p></div>
              </div>
            </label>
          </div>

          {selectedMode === 'force_firebase' && (
            <div className="grid grid-2" style={{ marginTop: 16 }}>
              <label className="form-group"><span className="form-label">Return to Automatic after</span>
                <select value={duration} onChange={(event) => setDuration(Number(event.target.value))} className="form-select">
                  {FORCE_DURATIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
              <label className="form-group"><span className="form-label">Reason (optional)</span>
                <input className="form-input" maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Example: Main storage is being checked" />
              </label>
            </div>
          )}
          {selectedMode === 'automatic' && (
            <label className="form-group" style={{ marginTop: 16 }}><span className="form-label">Reason (optional)</span>
              <input className="form-input" maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Example: Main storage is working again" />
            </label>
          )}
          <div className="flex justify-end" style={{ marginTop: 16 }}>
            <button className={`btn ${selectedMode === 'force_firebase' ? 'btn-secondary' : 'btn-primary'}`} type="button" onClick={requestChange} disabled={saving}>
              {selectedMode === 'force_firebase' ? <Zap size={16} /> : <ShieldCheck size={16} />} Save Choice
            </button>
          </div>
        </div>
        )}
      </section>

      <section className="card admin-section-card mb-24">
        <div className="card-header">
          <h3><CloudOff size={17} className="inline mr-8" />Recent Photo Activity</h3>
          <span className="text-xs text-secondary">Updates automatically</span>
        </div>
        {events.length === 0 ? (
          <div className="card-body text-sm text-secondary">No photo activity yet.</div>
        ) : (
          <>
            <div className="table-container"><table className="data-table"><thead><tr><th scope="col">Date</th><th scope="col">Activity</th><th scope="col">Saved In</th><th scope="col">Status</th><th scope="col">What Happened</th></tr></thead>
              <tbody>{events.map((event) => {
                const failed = event.outcome === 'failure';
                const Icon = failed ? XCircle : event.outcome === 'expired' ? AlertTriangle : CheckCircle2;
                return <tr key={event.id}>
                  <td data-label="Date" className="text-sm">{formatPhDateTime(event.created_at)}</td>
                  <td data-label="Activity">{activityName(event)}</td>
                  <td data-label="Saved In">{providerLabel(event.provider)}</td>
                  <td data-label="Status"><span className={`badge ${failed ? 'badge-error' : event.outcome === 'expired' ? 'badge-warning' : 'badge-success'}`}><Icon size={13} /> {activityStatus(event)}</span></td>
                  <td data-label="What Happened" className="text-sm text-secondary">{activityDetails(event)}</td>
                </tr>;
              })}</tbody>
            </table></div>
            <Pagination
              totalItems={eventsCount}
              currentPage={eventsPage}
              itemsPerPage={EVENTS_PAGE_SIZE}
              onPageChange={setEventsPage}
            />
          </>
        )}
      </section>

      {/* ── Technical Details: provider names, exact bytes, plan/quota
          source, bucket names — everything a developer or a very detail-
          oriented admin might want, kept out of the primary business view. */}
      <section className="card admin-section-card">
        <button
          type="button"
          className="card-header"
          style={{ width: '100%', border: 0, background: 'transparent', cursor: 'pointer' }}
          onClick={() => setShowTechnical(v => !v)}
          aria-expanded={showTechnical}
        >
          <h3><Database size={17} className="inline mr-8" />Technical Details</h3>
          {showTechnical ? <ChevronUp size={18} aria-hidden="true" /> : <ChevronDown size={18} aria-hidden="true" />}
        </button>
        {showTechnical && (
          <div className="card-body">
            <div className="grid grid-2 mb-24">
              <HealthBadge provider="supabase" health={health?.supabase} liveStatus={liveStatus} />
              <HealthBadge provider="firebase" health={health?.firebase} liveStatus={liveStatus} />
            </div>

            <div className="flex items-center justify-between mb-8">
              <strong className="text-sm">Main Storage (Supabase)</strong>
              <span className={`badge ${supabaseStorageBadge.className}`}>{supabaseStorageBadge.text}</span>
            </div>
            <div className="grid grid-2 mb-16">
              <div><div className="text-xs text-secondary">Plan</div><strong>{planLabel(liveStorage?.plan)}</strong></div>
              <div><div className="text-xs text-secondary">Space used</div><strong>{formatBytes(usedBytes)}</strong></div>
              <div><div className="text-xs text-secondary">Plan allowance</div><strong>{quotaBytes != null ? formatBytes(quotaBytes) : 'Custom (no fixed figure)'}</strong></div>
              <div><div className="text-xs text-secondary">Stored files</div><strong>{number(liveStorage?.object_count)}</strong></div>
            </div>

            {Array.isArray(liveStorage?.buckets) && liveStorage.buckets.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <div className="text-xs text-secondary mb-8">Storage areas (buckets)</div>
                <div className="grid grid-2">
                  {liveStorage.buckets.map((bucket) => (
                    <div className="flex items-center justify-between card" style={{ padding: 12 }} key={bucket.bucket_id}>
                      <span className="text-sm">{storageAreaLabel(bucket.bucket_id)} <span className="text-xs text-secondary">({bucket.bucket_id})</span></span>
                      <span className="text-sm"><strong>{formatBytes(bucket.size_bytes)}</strong> · {number(bucket.object_count)} files</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <p className="text-xs text-secondary" style={{ margin: '0 0 16px' }}>
              The plan allowance is the published quota for the Supabase plan detected for this project — Supabase's API does not expose an exact live quota figure, so this is a reference value, not a metered reading. Usage figures themselves (space used, stored files, buckets) are read live from Supabase Storage
              {liveStorage?.measured_at ? `, last checked on ${formatPhDateTime(liveStorage.measured_at)}` : ''}.
              {liveStatus === 'offline'
                ? ' The last successful values remain visible and will update when the internet returns.'
                : ' They are checked again automatically every minute while this screen is open.'}
              {' '}An admin notification is sent automatically once usage reaches 85% of the plan allowance.
            </p>
            {Number(liveStorage?.organization_project_count || 1) > 1 && (
              <p className="text-xs" style={{ color: 'var(--warning-text)', margin: '0 0 16px' }}>
                This Supabase account has {number(liveStorage.organization_project_count)} projects sharing one allowance. The space used above is for CargoExpress PH only.
              </p>
            )}

            <div className="flex items-center justify-between mb-8" style={{ marginTop: 8 }}>
              <strong className="text-sm">Backup Photos (Firebase / Firestore)</strong>
              <span className={`badge ${firebaseStorageBadge.className}`}>{firebaseStorageBadge.text}</span>
            </div>
            <p className="text-xs text-secondary" style={{ margin: '0 0 8px' }}>
              Backup photos are stored as documents in a Firestore collection, not a Cloud Storage bucket. The space figure above is estimated from the stored image data (accounting for base64 encoding overhead), since Firestore has no built-in "bytes used" reading. The 1 GB reference is the publicly published Firestore free-tier figure, not a value detected from this project's actual billing plan — check the Firebase console for the exact plan and usage.
            </p>

            <p className="text-xs text-secondary" style={{ margin: '16px 0 0' }}>
              "Legacy" photo references (older records saved before this monitoring existed) are counted separately in the backend and are not broken out on this page; they do not affect the Main Storage or Backup Photos figures above.
            </p>
          </div>
        )}
      </section>

      <ConfirmModal
        isOpen={confirmOpen}
        onClose={() => !saving && setConfirmOpen(false)}
        onConfirm={() => void saveMode()}
        title={selectedMode === 'force_firebase' ? 'Use Firebase Backup temporarily?' : 'Return to Automatic photo saving?'}
        message={selectedMode === 'force_firebase'
          ? `New pickup, delivery, and receipt photos will be saved in Firebase Backup for ${FORCE_DURATIONS.find(option => option.value === duration)?.label || 'the selected time'}. Existing photos will not change.`
          : 'New photos will be saved in Supabase first and Firebase Backup will be used only when needed. Existing photos will not change.'}
        confirmLabel={selectedMode === 'force_firebase' ? 'Use Firebase Backup' : 'Use Automatic'}
        variant={selectedMode === 'force_firebase' ? 'warning' : 'success'}
        loading={saving}
      />

      <ConfirmModal
        isOpen={cleanupConfirmOpen}
        onClose={() => {
          if (!cleaning) {
            setCleanupConfirmOpen(false);
            setCleanupPreview(null);
          }
        }}
        onConfirm={() => void runCleanup()}
        title="Permanently remove unused photos?"
        message={`${number(cleanupPreview?.candidate_count)} unused photo${Number(cleanupPreview?.candidate_count) === 1 ? '' : 's'} (${formatBytes(cleanupPreview?.estimated_bytes)}) were found. Nothing has been deleted yet. Continue only if you want to permanently remove these photos. This cannot be undone.`}
        confirmLabel="Permanently Remove"
        variant="warning"
        loading={cleaning}
      />
    </div>
  );
};

export default PhotoStorageTab;
