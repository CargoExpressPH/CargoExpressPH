import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, CheckSquare, Database, HardDrive, Image as ImageIcon, Loader,
  Search, Square, Sparkles, Trash2, X,
} from 'lucide-react';
import {
  checkPhotoStorageHealth, deleteEvidencePhotos, getPhotoStorageSummary, listEvidencePhotos,
} from '../../lib/database';
import { resolvePhotoUrl } from '../../lib/storage';
import { useToast } from '../../hooks/useToast';
import usePageTitle from '../../hooks/usePageTitle';
import { formatPhDate } from '../../utils/datetime';
import { CenteredSpinner } from '../../components/ui/Loader';
import ConfirmModal from '../../components/ui/ConfirmModal';
import Pagination from '../../components/ui/Pagination';
import ImageLightbox from '../../components/ui/ImageLightbox';

const PAGE_SIZE = 20;
const SEARCH_DEBOUNCE_MS = 350;

const FILTERS = [
  { value: 'all', label: 'All Photos' },
  { value: 'eligible', label: 'Can Be Deleted' },
  { value: 'protected', label: 'Still Needed' },
];

const number = (value) => Number(value || 0).toLocaleString('en-PH');

const formatBytes = (value) => {
  if (value == null || !Number.isFinite(Number(value))) return 'Size unknown';
  const bytes = Number(value);
  if (bytes < 1024) return `${bytes.toLocaleString('en-PH')} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let amount = bytes;
  let unit = -1;
  do { amount /= 1024; unit += 1; } while (amount >= 1024 && unit < units.length - 1);
  return `${amount.toLocaleString('en-PH', { maximumFractionDigits: amount >= 100 ? 0 : 2 })} ${units[unit]}`;
};

// Never shows a misleading "0%" for a small but real amount, and never
// implies false precision at the high end.
const formatPercent = (percent) => {
  if (percent == null) return null;
  if (percent <= 0) return '0%';
  if (percent < 1) return '<1%';
  if (percent < 10) return `${percent.toLocaleString('en-PH', { maximumFractionDigits: 1 })}%`;
  return `${Math.round(percent)}%`;
};

const photoTypeLabel = (field) => (
  field === 'pickup' ? 'Pickup evidence'
    : field === 'delivery' ? 'Delivery evidence'
      : field === 'receipt' ? 'Receipt'
        : 'Photo'
);

const toDescriptor = (item) => (
  item.provider === 'firebase'
    ? { type: 'firestore_fallback', firestore_path: item.storage_path }
    : { type: 'supabase_storage', bucket: 'cargo-photos', path: item.storage_path }
);

const PhotoCard = ({ item, thumbUrl, selected, onToggleSelect, onPreview }) => {
  const canSelect = item.status === 'eligible';
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden', position: 'relative' }}>
      <button
        type="button"
        onClick={() => onPreview(item)}
        style={{
          display: 'block', width: '100%', aspectRatio: '1 / 1', border: 0, padding: 0,
          background: 'var(--bg-secondary)', cursor: 'pointer', position: 'relative',
        }}
        aria-label={`Preview ${photoTypeLabel(item.photo_field)} for ${item.tracking_number || 'unknown booking'}`}
      >
        {thumbUrl === undefined ? (
          <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Loader size={18} className="animate-spin text-secondary" />
          </span>
        ) : thumbUrl ? (
          <img src={thumbUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : (
          <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <ImageIcon size={22} className="text-secondary" />
          </span>
        )}
      </button>

      {canSelect && (
        <button
          type="button"
          onClick={() => onToggleSelect(item)}
          className="btn btn-icon"
          aria-pressed={selected}
          aria-label={selected ? 'Deselect this photo' : 'Select this photo'}
          style={{
            position: 'absolute', top: 8, left: 8, width: 28, height: 28, padding: 0,
            background: selected ? 'var(--primary)' : 'rgba(255,255,255,0.92)',
            color: selected ? '#fff' : 'var(--text)', borderRadius: 6,
          }}
        >
          {selected ? <CheckSquare size={16} /> : <Square size={16} />}
        </button>
      )}

      <span
        className={`badge ${canSelect ? 'badge-warning' : 'badge-default'}`}
        style={{ position: 'absolute', top: 8, right: 8 }}
      >
        {canSelect ? 'Can Be Deleted' : 'Still Needed'}
      </span>

      <div style={{ padding: 10 }}>
        <div className="text-sm" style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {item.tracking_number || 'No matching booking'}
        </div>
        <div className="text-xs text-secondary">{photoTypeLabel(item.photo_field)} · {item.taken_at ? formatPhDate(item.taken_at) : 'Date unknown'}</div>
        <div className="text-xs text-secondary">{formatBytes(item.size_bytes)}</div>
        <div className="text-xs text-secondary" style={{ marginTop: 4 }}>{item.reason}</div>
      </div>
    </div>
  );
};

const PhotoStorageTab = () => {
  usePageTitle('Storage Monitoring — Photo Storage');
  const toast = useToast();

  // Usage summary
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [health, setHealth] = useState(null);
  const [summary, setSummary] = useState(null);

  // Gallery
  const [items, setItems] = useState([]);
  const [itemsCount, setItemsCount] = useState(0);
  const [galleryLoading, setGalleryLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [thumbUrls, setThumbUrls] = useState({});
  const [selected, setSelected] = useState(() => new Map());

  // Deletion
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteResult, setDeleteResult] = useState(null);

  // Preview
  const [previewUrl, setPreviewUrl] = useState(null);

  const debounceTimer = useRef(null);
  const gallerySequence = useRef(0);

  useEffect(() => () => clearTimeout(debounceTimer.current), []);

  const loadOverview = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setOverviewLoading(true);
    try {
      const [healthResult, summaryResult] = await Promise.allSettled([
        checkPhotoStorageHealth(),
        getPhotoStorageSummary(),
      ]);
      if (healthResult.status === 'fulfilled') setHealth(healthResult.value);
      if (summaryResult.status === 'fulfilled') setSummary(summaryResult.value);
    } finally {
      setOverviewLoading(false);
    }
  }, []);

  const loadGallery = useCallback(async () => {
    const requestId = ++gallerySequence.current;
    setGalleryLoading(true);
    try {
      const { data, count } = await listEvidencePhotos({ filter, search: debouncedSearch, page, pageSize: PAGE_SIZE });
      if (requestId !== gallerySequence.current) return;
      setItems(data);
      setItemsCount(count);

      const toResolve = data.filter((item) => !(item.item_key in thumbUrls));
      if (toResolve.length > 0) {
        setThumbUrls((prev) => {
          const next = { ...prev };
          toResolve.forEach((item) => { next[item.item_key] = undefined; });
          return next;
        });
        const resolved = await Promise.allSettled(toResolve.map((item) => resolvePhotoUrl(toDescriptor(item))));
        if (requestId !== gallerySequence.current) return;
        setThumbUrls((prev) => {
          const next = { ...prev };
          toResolve.forEach((item, i) => {
            const result = resolved[i];
            next[item.item_key] = result.status === 'fulfilled' && result.value && result.value !== 'error://unavailable'
              ? result.value
              : null;
          });
          return next;
        });
      }
    } catch (error) {
      if (requestId !== gallerySequence.current) return;
      toast.error(error?.message || 'Could not load the photo gallery.');
    } finally {
      if (requestId === gallerySequence.current) setGalleryLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, debouncedSearch, page]);

  useEffect(() => { void loadOverview(); }, [loadOverview]);
  useEffect(() => { void loadGallery(); }, [loadGallery]);

  const handleFilterChange = (value) => {
    setFilter(value);
    setPage(1);
  };

  const handleSearchChange = (event) => {
    const value = event.target.value;
    setSearch(value);
    setPage(1);
    clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => setDebouncedSearch(value), SEARCH_DEBOUNCE_MS);
  };

  const toggleSelect = (item) => {
    if (item.status !== 'eligible') return;
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(item.item_key)) next.delete(item.item_key);
      else next.set(item.item_key, item);
      return next;
    });
  };

  const eligibleOnPage = useMemo(() => items.filter((item) => item.status === 'eligible'), [items]);
  const allPageSelected = eligibleOnPage.length > 0 && eligibleOnPage.every((item) => selected.has(item.item_key));

  const toggleSelectAllOnPage = () => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (allPageSelected) {
        eligibleOnPage.forEach((item) => next.delete(item.item_key));
      } else {
        eligibleOnPage.forEach((item) => next.set(item.item_key, item));
      }
      return next;
    });
  };

  const clearSelection = () => setSelected(new Map());

  const selectedList = useMemo(() => Array.from(selected.values()), [selected]);
  const selectedBytesKnown = selectedList.some((item) => item.size_bytes != null);
  const selectedBytesTotal = selectedList.reduce((sum, item) => sum + Number(item.size_bytes || 0), 0);

  const openPreview = async (item) => {
    const cached = thumbUrls[item.item_key];
    if (cached) { setPreviewUrl(cached); return; }
    const url = await resolvePhotoUrl(toDescriptor(item));
    if (url && url !== 'error://unavailable') setPreviewUrl(url);
    else toast.error('This photo could not be loaded for preview.');
  };

  const confirmDelete = async () => {
    setDeleting(true);
    try {
      const payload = selectedList.map((item) => ({
        order_id: item.order_id,
        photo_field: item.photo_field,
        provider: item.provider,
        storage_path: item.storage_path,
      }));
      const result = await deleteEvidencePhotos(payload);
      setDeleteResult(result);
      setConfirmOpen(false);
      clearSelection();

      if (result.failed_count === 0 && result.rejected.length === 0) {
        toast.success(`${result.deleted_count} photo${result.deleted_count === 1 ? '' : 's'} permanently removed.`);
      } else if (result.deleted_count > 0) {
        toast.error(`${result.deleted_count} removed, but ${result.failed_count + result.rejected.length} could not be. See details below.`);
      } else {
        toast.error('None of the selected photos could be removed. See details below.');
      }

      await Promise.allSettled([loadGallery(), loadOverview({ quiet: true })]);
    } catch (error) {
      toast.error(error?.message || 'Could not delete the selected photos.');
    } finally {
      setDeleting(false);
    }
  };

  if (overviewLoading && galleryLoading && items.length === 0) return <CenteredSpinner />;

  const liveStorage = health?.supabase_storage;
  const usedBytes = liveStorage?.total_size_bytes == null ? null : Number(liveStorage.total_size_bytes);
  const quotaBytes = liveStorage?.included_storage_bytes == null ? null : Number(liveStorage.included_storage_bytes);
  const usagePercent = usedBytes != null && quotaBytes > 0 ? (usedBytes / quotaBytes) * 100 : null;
  const boundedPercent = usagePercent == null ? 0 : Math.max(0, Math.min(usagePercent, 100));
  const availableBytes = usedBytes != null && quotaBytes > 0 ? Math.max(0, quotaBytes - usedBytes) : null;
  const usageTone = usagePercent >= 95 ? 'var(--error)' : usagePercent >= 80 ? 'var(--warning)' : 'var(--success)';

  const firebaseStorage = health?.firebase_storage;
  const firebasePhotoCount = Number(summary?.firebase_photo_count || 0);
  const firebaseEstimatedBytes = firebaseStorage?.estimated_photo_data_bytes == null
    ? null
    : Number(firebaseStorage.estimated_photo_data_bytes);

  const overviewStatus = (() => {
    if (health?.supabase?.status === 'unavailable') {
      return { badgeClass: 'badge-error', label: 'Action Needed', text: 'Photos cannot be saved to the main storage right now. New photos are automatically using Backup Storage until this is fixed.' };
    }
    if (usagePercent == null) {
      return liveStorage?.live_usage_status === 'available'
        ? { badgeClass: 'badge-info', label: 'No Fixed Limit', text: 'This plan does not have a fixed storage limit.' }
        : { badgeClass: 'badge-warning', label: 'Checking', text: 'Storage use could not be checked just now.' };
    }
    if (usagePercent >= 95) return { badgeClass: 'badge-error', label: 'Action Needed', text: 'Storage is almost full. Delete some eligible photos below to free up space.' };
    if (usagePercent >= 80) return { badgeClass: 'badge-warning', label: 'Getting Full', text: 'Space is filling up. Consider deleting eligible photos below.' };
    return { badgeClass: 'badge-success', label: 'Good', text: 'You have enough room for new photos.' };
  })();

  const failuresLast24h = Number(summary?.failures_last_24h || 0);

  return (
    <div>
      <div className="admin-page-header">
        <div>
          <h1 className="admin-page-title"><Database size={24} color="var(--primary)" aria-hidden="true" />Photo Storage</h1>
          <p className="admin-page-subtitle">See how much space is used and remove photos that are no longer needed.</p>
        </div>
      </div>

      {/* ── Storage Usage: the one card that answers "how much space is used?" ── */}
      <section className="card admin-section-card mb-24">
        <div className="card-header">
          <h3><HardDrive size={17} className="inline mr-8" />Storage Usage</h3>
          <span className={`badge ${overviewStatus.badgeClass}`}>{overviewStatus.label}</span>
        </div>
        <div className="card-body">
          {usagePercent != null && (
            <div className="flex items-center justify-between text-sm mb-8">
              <span>{formatPercent(usagePercent)} used · {formatBytes(usedBytes)} of {formatBytes(quotaBytes)}</span>
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
              <div style={{ width: `${Math.max(boundedPercent, usagePercent > 0 ? 1 : 0)}%`, height: '100%', background: usageTone, borderRadius: 999, transition: 'width 300ms ease' }} />
            </div>
          )}
          <p className="text-sm text-secondary" style={{ margin: usagePercent != null ? '12px 0 0' : 0 }}>{overviewStatus.text}</p>

          <p className="text-xs text-secondary" style={{ margin: '12px 0 0' }}>
            This total includes every file in photo storage, including website images. {number(itemsCount)} shipment photo{itemsCount === 1 ? '' : 's'} {filter === 'all' ? '' : 'match your current filter and '}are shown in the gallery below.
            {' '}Space used is measured live; the allowance shown is the published plan limit, not a number read from your account.
          </p>

          {firebasePhotoCount > 0 && (
            <p className="text-xs text-secondary" style={{ margin: '8px 0 0' }}>
              Backup storage separately holds {number(firebasePhotoCount)} photo{firebasePhotoCount === 1 ? '' : 's'}
              {firebaseEstimatedBytes != null ? ` (~${formatBytes(firebaseEstimatedBytes)} estimated)` : ''}. This is not included in the total above.
            </p>
          )}

          {failuresLast24h > 0 && (
            <div className="alert-banner alert-banner-warning mt-16" role="status">
              <AlertTriangle size={17} />
              <span>{failuresLast24h} photo{failuresLast24h === 1 ? '' : 's'} failed to save in the last 24 hours. Check the affected bookings.</span>
            </div>
          )}
        </div>
      </section>

      <div className="alert-banner alert-banner-info mb-24" role="status">
        <Sparkles size={18} />
        <span><strong>Automatic cleanup:</strong> pickup and delivery photos are permanently removed once a booking has been Delivered or Cancelled for more than 6 months. Receipts and photos featured on the website are always kept. This is permanent — there is no archive copy.</span>
      </div>

      {/* ── Gallery ─────────────────────────────────────────────────────── */}
      <section className="card admin-section-card">
        <div className="card-header" style={{ flexWrap: 'wrap', gap: 12 }}>
          <h3><ImageIcon size={17} className="inline mr-8" />Photos</h3>
          <div className="flex items-center gap-8" style={{ flexWrap: 'wrap' }}>
            {FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                className={`btn btn-sm ${filter === f.value ? 'btn-primary' : 'btn-outline'}`}
                onClick={() => handleFilterChange(f.value)}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        <div className="card-body" style={{ paddingBottom: 0 }}>
          <div className="form-group" style={{ maxWidth: 360, position: 'relative' }}>
            <Search size={15} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)' }} className="text-secondary" aria-hidden="true" />
            <input
              className="form-input"
              style={{ paddingLeft: 32 }}
              placeholder="Search by booking / tracking number"
              value={search}
              onChange={handleSearchChange}
              aria-label="Search photos by booking or tracking number"
            />
          </div>

          {deleteResult && (
            <div className={`alert-banner ${deleteResult.failed_count > 0 || deleteResult.rejected.length > 0 ? 'alert-banner-warning' : 'alert-banner-success'} mt-16`} role="status">
              <span style={{ flex: 1 }}>
                <strong>{deleteResult.deleted_count} photo{deleteResult.deleted_count === 1 ? '' : 's'} removed.</strong>
                {deleteResult.failed_count > 0 && ` ${deleteResult.failed_count} could not be removed and will be retried automatically.`}
                {deleteResult.rejected.length > 0 && ` ${deleteResult.rejected.length} photo${deleteResult.rejected.length === 1 ? ' was' : 's were'} skipped because ${deleteResult.rejected.length === 1 ? 'it is' : 'they are'} still needed.`}
                {' '}Storage totals refresh now — this can take a few seconds.
              </span>
              <button type="button" className="btn btn-icon" onClick={() => setDeleteResult(null)} aria-label="Dismiss">
                <X size={15} />
              </button>
            </div>
          )}

          {eligibleOnPage.length > 0 && (
            <div className="flex items-center justify-between mt-16" style={{ flexWrap: 'wrap', gap: 8 }}>
              <button type="button" className="btn btn-sm btn-outline" onClick={toggleSelectAllOnPage}>
                {allPageSelected ? <CheckSquare size={14} /> : <Square size={14} />}
                {' '}Select all eligible on this page
              </button>
            </div>
          )}
        </div>

        <div className="card-body">
          {galleryLoading && items.length === 0 ? (
            <CenteredSpinner />
          ) : items.length === 0 ? (
            <p className="text-sm text-secondary">No photos match your search and filters.</p>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 14 }}>
              {items.map((item) => (
                <PhotoCard
                  key={item.item_key}
                  item={item}
                  thumbUrl={thumbUrls[item.item_key]}
                  selected={selected.has(item.item_key)}
                  onToggleSelect={toggleSelect}
                  onPreview={openPreview}
                />
              ))}
            </div>
          )}

          <Pagination
            totalItems={itemsCount}
            currentPage={page}
            itemsPerPage={PAGE_SIZE}
            onPageChange={setPage}
          />
        </div>
      </section>

      {/* ── Selection bar ───────────────────────────────────────────────── */}
      {selectedList.length > 0 && (
        <div
          className="card"
          style={{
            position: 'sticky', bottom: 16, marginTop: 16, padding: 14,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap',
            boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
          }}
        >
          <span className="text-sm">
            <strong>{selectedList.length}</strong> photo{selectedList.length === 1 ? '' : 's'} selected
            {selectedBytesKnown && ` · ~${formatBytes(selectedBytesTotal)} to free`}
          </span>
          <div className="flex items-center gap-8">
            <button type="button" className="btn btn-outline btn-sm" onClick={clearSelection}>Clear</button>
            <button type="button" className="btn btn-secondary" onClick={() => setConfirmOpen(true)}>
              <Trash2 size={16} /> Delete Selected
            </button>
          </div>
        </div>
      )}

      <ConfirmModal
        isOpen={confirmOpen}
        onClose={() => !deleting && setConfirmOpen(false)}
        onConfirm={() => void confirmDelete()}
        title="Permanently delete these photos?"
        message={`${selectedList.length} photo${selectedList.length === 1 ? '' : 's'}${selectedBytesKnown ? ` (~${formatBytes(selectedBytesTotal)})` : ''} will be permanently removed from storage. This cannot be undone. The related booking and payment records are not affected — only the photo file itself is deleted.`}
        confirmLabel="Permanently Delete"
        variant="warning"
        loading={deleting}
      />

      {previewUrl && (
        <ImageLightbox images={[previewUrl]} initialIndex={0} onClose={() => setPreviewUrl(null)} />
      )}
    </div>
  );
};

export default PhotoStorageTab;
