import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowLeft, CheckSquare, Database, Folder, FolderOpen,
  HardDrive, Image as ImageIcon, Loader, Search, Square, Trash2, X,
} from 'lucide-react';
import {
  checkCompanyAssetDeletable, checkPhotoStorageHealth, deleteEvidencePhotos,
  getPhotoStorageSummary, listEvidenceFolders, listFolderPhotos,
} from '../../lib/database';
import { resolvePhotoUrl } from '../../lib/storage';
import { supabase } from '../../lib/supabase';
import { useToast } from '../../hooks/useToast';
import usePageTitle from '../../hooks/usePageTitle';
import { formatPhDate } from '../../utils/datetime';
import { CenteredSpinner } from '../../components/ui/Loader';
import ConfirmModal from '../../components/ui/ConfirmModal';
import Pagination from '../../components/ui/Pagination';

const FOLDER_PAGE_SIZE = 20;
const SEARCH_DEBOUNCE_MS = 350;
const UNBOOKED = '__unbooked__';

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

/* ============================================================================
 * LEFT column — booking folders
 * ==========================================================================*/
const FolderList = ({ folders, selectedKey, onSelect, loading }) => (
  <div className="storage-folder-list" role="list" aria-label="Booking folders">
    {folders.map((f) => {
      const isUnbooked = f.folder_key === UNBOOKED;
      const active = f.folder_key === selectedKey;
      return (
        <button
          key={f.folder_key}
          type="button"
          role="listitem"
          onClick={() => onSelect(f.folder_key)}
          className={`storage-folder-row ${active ? 'storage-folder-row-active' : ''}`}
          disabled={loading && active}
        >
          {active ? <FolderOpen size={16} aria-hidden="true" /> : <Folder size={16} aria-hidden="true" />}
          <span className="storage-folder-row-text">
            <span className="storage-folder-row-title">
              {isUnbooked ? 'Photos Without Bookings' : f.folder_key}
            </span>
            {!isUnbooked && (f.customer_name || f.order_status) && (
              <span className="storage-folder-row-sub">
                {[f.customer_name, f.order_status].filter(Boolean).join(' · ')}
              </span>
            )}
          </span>
          <span className="storage-folder-row-count">{number(f.photo_count)}</span>
        </button>
      );
    })}
    {!loading && folders.length === 0 && (
      <p className="text-sm text-secondary" style={{ padding: '16px 12px' }}>No folders match your search.</p>
    )}
  </div>
);

/* ============================================================================
 * MIDDLE column — one folder's photos
 * ==========================================================================*/
const PhotoRow = ({ item, thumbUrl, selected, active, onToggleSelect, onOpen }) => {
  const canSelect = item.status === 'eligible';
  return (
    <div className={`storage-photo-row ${active ? 'storage-photo-row-active' : ''}`}>
      <button
        type="button"
        className="storage-photo-row-checkbox"
        onClick={() => canSelect && onToggleSelect(item)}
        disabled={!canSelect}
        aria-label={selected ? 'Deselect this photo' : canSelect ? 'Select this photo' : 'This photo cannot be selected'}
        aria-pressed={selected}
      >
        {canSelect ? (selected ? <CheckSquare size={16} /> : <Square size={16} />) : <Square size={16} style={{ opacity: 0.25 }} />}
      </button>
      <button type="button" className="storage-photo-row-thumb" onClick={() => onOpen(item)} aria-label={`Preview ${photoTypeLabel(item.photo_field)}`}>
        {thumbUrl === undefined ? (
          <Loader size={14} className="animate-spin text-secondary" />
        ) : thumbUrl ? (
          <img src={thumbUrl} alt="" />
        ) : (
          <ImageIcon size={16} className="text-secondary" />
        )}
      </button>
      <button type="button" className="storage-photo-row-info" onClick={() => onOpen(item)}>
        <span className="storage-photo-row-title">
          {photoTypeLabel(item.photo_field)}
          {item.source === 'orphan' && <span className="badge badge-default" style={{ marginLeft: 6 }}>No booking</span>}
        </span>
        <span className="storage-photo-row-meta">
          {item.taken_at ? formatPhDate(item.taken_at) : 'Date unknown'} · {formatBytes(item.size_bytes)}
        </span>
      </button>
      {item.status === 'protected' && (
        <span className="storage-photo-row-reason" title={item.reason}>{item.reason}</span>
      )}
    </div>
  );
};

/* ============================================================================
 * RIGHT column — preview
 * ==========================================================================*/
const PreviewPane = ({ item, url, urlState, onDelete, canDelete }) => {
  if (!item) {
    return (
      <div className="storage-preview-empty">
        <ImageIcon size={32} className="text-secondary" aria-hidden="true" />
        <p className="text-sm text-secondary" style={{ margin: '10px 0 0' }}>Select a photo to preview it here.</p>
      </div>
    );
  }
  return (
    <div className="storage-preview">
      <div className="storage-preview-image-wrap">
        {urlState === 'loading' ? (
          <Loader size={22} className="animate-spin text-secondary" />
        ) : urlState === 'error' || !url ? (
          <div className="text-center">
            <AlertTriangle size={22} className="text-secondary" aria-hidden="true" />
            <p className="text-xs text-secondary" style={{ margin: '8px 0 0' }}>This photo could not be loaded.</p>
          </div>
        ) : (
          <img src={url} alt={`${photoTypeLabel(item.photo_field)} for ${item.tracking_number || 'unbooked photo'}`} />
        )}
      </div>
      <div className="storage-preview-details">
        <div className="text-sm fw-700">{photoTypeLabel(item.photo_field)}</div>
        <div className="text-xs text-secondary" style={{ marginTop: 2 }}>
          {item.tracking_number || 'No matching booking'}
        </div>
        <div className="text-xs text-secondary">
          {item.taken_at ? formatPhDate(item.taken_at) : 'Date unknown'} · {formatBytes(item.size_bytes)}
        </div>
        {item.status === 'protected' ? (
          <p className="text-xs" style={{ color: 'var(--warning-text)', marginTop: 10 }}>{item.reason}</p>
        ) : (
          <button type="button" className="btn btn-secondary btn-sm mt-12" onClick={() => onDelete(item)} disabled={!canDelete}>
            <Trash2 size={14} /> Delete This Photo
          </button>
        )}
      </div>
    </div>
  );
};

/* ============================================================================
 * Cargo Photos — the three-column booking-folder browser
 * ==========================================================================*/
const CargoPhotoBrowser = () => {
  const toast = useToast();

  const [folders, setFolders] = useState([]);
  const [foldersCount, setFoldersCount] = useState(0);
  const [foldersLoading, setFoldersLoading] = useState(true);
  const [folderPage, setFolderPage] = useState(1);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const debounceTimer = useRef(null);

  const [selectedFolder, setSelectedFolder] = useState(null);
  const [folderPhotos, setFolderPhotos] = useState([]);
  const [folderPhotosCount, setFolderPhotosCount] = useState(0);
  const [photosLoading, setPhotosLoading] = useState(false);
  const [thumbUrls, setThumbUrls] = useState({});

  const [previewItem, setPreviewItem] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [previewState, setPreviewState] = useState('idle'); // idle | loading | ready | error

  const [selected, setSelected] = useState(() => new Map());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmTarget, setConfirmTarget] = useState(null); // null = bulk selection, item = single
  const [deleting, setDeleting] = useState(false);
  const [deleteResult, setDeleteResult] = useState(null);

  const folderSeq = useRef(0);
  const photoSeq = useRef(0);
  const previewSeq = useRef(0);

  useEffect(() => () => clearTimeout(debounceTimer.current), []);

  const loadFolders = useCallback(async () => {
    const requestId = ++folderSeq.current;
    setFoldersLoading(true);
    try {
      const { data, count } = await listEvidenceFolders({ search: debouncedSearch, page: folderPage, pageSize: FOLDER_PAGE_SIZE });
      if (requestId !== folderSeq.current) return;
      setFolders(data);
      setFoldersCount(count);
    } catch (error) {
      if (requestId !== folderSeq.current) return;
      toast.error(error?.message || 'Could not load booking folders.');
    } finally {
      if (requestId === folderSeq.current) setFoldersLoading(false);
    }
  }, [debouncedSearch, folderPage, toast]);

  useEffect(() => { void loadFolders(); }, [loadFolders]);

  const loadFolderPhotos = useCallback(async (folderKey) => {
    if (!folderKey) return;
    const requestId = ++photoSeq.current;
    setPhotosLoading(true);
    try {
      const { data, count } = await listFolderPhotos(folderKey);
      // A stale response for a folder the admin has already navigated away
      // from must never overwrite what's now on screen.
      if (requestId !== photoSeq.current) return;
      setFolderPhotos(data);
      setFolderPhotosCount(count);

      const toResolve = data.filter((item) => !(item.item_key in thumbUrls));
      if (toResolve.length > 0) {
        setThumbUrls((prev) => {
          const next = { ...prev };
          toResolve.forEach((item) => { next[item.item_key] = undefined; });
          return next;
        });
        const resolved = await Promise.allSettled(toResolve.map((item) => resolvePhotoUrl(toDescriptor(item))));
        if (requestId !== photoSeq.current) return;
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
      if (requestId !== photoSeq.current) return;
      toast.error(error?.message || 'Could not load this folder.');
    } finally {
      if (requestId === photoSeq.current) setPhotosLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast]);

  const openFolder = (folderKey) => {
    setSelectedFolder(folderKey);
    setPreviewItem(null);
    setPreviewUrl(null);
    void loadFolderPhotos(folderKey);
  };

  const backToFolders = () => setSelectedFolder(null);
  const backToPhotos = () => setPreviewItem(null);

  const openPreview = async (item) => {
    setPreviewItem(item);
    const requestId = ++previewSeq.current;
    const cached = thumbUrls[item.item_key];
    if (cached) { setPreviewUrl(cached); setPreviewState('ready'); return; }
    setPreviewState('loading');
    setPreviewUrl(null);
    const url = await resolvePhotoUrl(toDescriptor(item));
    if (requestId !== previewSeq.current) return;
    if (url && url !== 'error://unavailable') {
      setPreviewUrl(url);
      setPreviewState('ready');
    } else {
      setPreviewState('error');
    }
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

  const eligibleLoaded = useMemo(() => folderPhotos.filter((i) => i.status === 'eligible'), [folderPhotos]);
  const eligibleLoadedSelected = eligibleLoaded.length > 0 && eligibleLoaded.every((i) => selected.has(i.item_key));
  const hasMoreUnloaded = folderPhotosCount > folderPhotos.length;

  const toggleSelectAllLoaded = () => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (eligibleLoadedSelected) eligibleLoaded.forEach((i) => next.delete(i.item_key));
      else eligibleLoaded.forEach((i) => next.set(i.item_key, i));
      return next;
    });
  };

  const clearSelection = () => setSelected(new Map());
  const selectedList = useMemo(() => Array.from(selected.values()), [selected]);
  const selectedBytesKnown = selectedList.some((i) => i.size_bytes != null);
  const selectedBytesTotal = selectedList.reduce((sum, i) => sum + Number(i.size_bytes || 0), 0);

  const deleteTargets = confirmTarget ? [confirmTarget] : selectedList;
  const deleteTargetsBytesKnown = deleteTargets.some((i) => i.size_bytes != null);
  const deleteTargetsBytesTotal = deleteTargets.reduce((sum, i) => sum + Number(i.size_bytes || 0), 0);

  const runDelete = async () => {
    setDeleting(true);
    try {
      const payload = deleteTargets.map((item) => ({
        order_id: item.order_id, photo_field: item.photo_field, provider: item.provider, storage_path: item.storage_path,
      }));
      const result = await deleteEvidencePhotos(payload);
      setDeleteResult(result);
      setConfirmOpen(false);
      setConfirmTarget(null);
      const deletedKeys = new Set(deleteTargets.map((i) => i.item_key));
      setSelected((prev) => {
        const next = new Map(prev);
        deletedKeys.forEach((k) => next.delete(k));
        return next;
      });
      if (previewItem && deletedKeys.has(previewItem.item_key)) {
        setPreviewItem(null);
        setPreviewUrl(null);
      }

      if (result.failed_count === 0 && result.rejected.length === 0) {
        toast.success(`${result.deleted_count} photo${result.deleted_count === 1 ? '' : 's'} permanently removed.`);
      } else if (result.deleted_count > 0) {
        toast.error(`${result.deleted_count} removed, but ${result.failed_count + result.rejected.length} could not be. See details below.`);
      } else {
        toast.error('None of the selected photos could be removed. See details below.');
      }

      await Promise.allSettled([
        loadFolders(),
        selectedFolder ? loadFolderPhotos(selectedFolder) : Promise.resolve(),
      ]);
    } catch (error) {
      toast.error(error?.message || 'Could not delete the selected photos.');
    } finally {
      setDeleting(false);
    }
  };

  // Derived, CSS-only mobile pane: preview > photos > folders. All three
  // columns stay mounted at all times — only visibility changes — so
  // switching panes never loses scroll position or in-flight state.
  const activePane = previewItem ? 'preview' : selectedFolder ? 'photos' : 'folders';
  const selectedFolderMeta = folders.find((f) => f.folder_key === selectedFolder);
  const folderTitle = selectedFolder === UNBOOKED ? 'Photos Without Bookings' : (selectedFolder || '');

  return (
    <>
      <div className="storage-browser" data-pane={activePane}>
        <div className="storage-col storage-col-folders" data-pane="folders">
          <div className="storage-col-header">
            <div className="form-group mb-0" style={{ position: 'relative', flex: 1 }}>
              <Search size={14} style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)' }} className="text-secondary" aria-hidden="true" />
              <input
                className="form-input"
                style={{ paddingLeft: 28, padding: '7px 10px 7px 28px', fontSize: '0.8125rem' }}
                placeholder="Search tracking number"
                value={search}
                onChange={(e) => {
                  const value = e.target.value;
                  setSearch(value);
                  setFolderPage(1);
                  clearTimeout(debounceTimer.current);
                  debounceTimer.current = setTimeout(() => setDebouncedSearch(value), SEARCH_DEBOUNCE_MS);
                }}
                aria-label="Search booking folders by tracking number"
              />
            </div>
          </div>
          {foldersLoading && folders.length === 0 ? (
            <CenteredSpinner />
          ) : (
            <FolderList folders={folders} selectedKey={selectedFolder} onSelect={openFolder} loading={foldersLoading} />
          )}
          <div className="storage-col-footer">
            <Pagination totalItems={foldersCount} currentPage={folderPage} itemsPerPage={FOLDER_PAGE_SIZE} onPageChange={setFolderPage} />
          </div>
        </div>

        <div className="storage-col storage-col-photos" data-pane="photos">
          <div className="storage-col-header">
            <button type="button" className="btn-icon storage-browser-mobile-back" onClick={backToFolders} aria-label="Back to folders">
              <ArrowLeft size={18} />
            </button>
            <span className="text-sm fw-700" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {selectedFolder ? folderTitle : 'Select a folder'}
            </span>
            {selectedFolderMeta && (
              <span className="text-xs text-secondary" style={{ marginLeft: 'auto' }}>{number(selectedFolderMeta.photo_count)} photos</span>
            )}
          </div>

          {!selectedFolder ? (
            <p className="text-sm text-secondary" style={{ padding: '16px 12px' }}>Choose a folder on the left to see its photos.</p>
          ) : photosLoading && folderPhotos.length === 0 ? (
            <CenteredSpinner />
          ) : (
            <>
              {eligibleLoaded.length > 0 && (
                <div className="storage-col-toolbar">
                  <button type="button" className="btn btn-sm btn-outline" onClick={toggleSelectAllLoaded}>
                    {eligibleLoadedSelected ? <CheckSquare size={14} /> : <Square size={14} />}
                    {' '}Select all eligible {hasMoreUnloaded ? '(loaded)' : ''}
                  </button>
                  {hasMoreUnloaded && (
                    <span className="text-xs text-secondary">Showing {folderPhotos.length} of {folderPhotosCount} — more not loaded</span>
                  )}
                </div>
              )}
              <div className="storage-photo-list" role="list" aria-label="Photos in this folder">
                {folderPhotos.map((item) => (
                  <PhotoRow
                    key={item.item_key}
                    item={item}
                    thumbUrl={thumbUrls[item.item_key]}
                    selected={selected.has(item.item_key)}
                    active={previewItem?.item_key === item.item_key}
                    onToggleSelect={toggleSelect}
                    onOpen={openPreview}
                  />
                ))}
                {folderPhotos.length === 0 && (
                  <p className="text-sm text-secondary" style={{ padding: '16px 12px' }}>This folder has no photos.</p>
                )}
              </div>
            </>
          )}
        </div>

        <div className="storage-col storage-col-preview" data-pane="preview">
          <div className="storage-col-header">
            <button type="button" className="btn-icon storage-browser-mobile-back" onClick={backToPhotos} aria-label="Back to photos">
              <ArrowLeft size={18} />
            </button>
            <span className="text-sm fw-700">Preview</span>
          </div>
          <PreviewPane
            item={previewItem}
            url={previewUrl}
            urlState={previewState}
            canDelete={!deleting}
            onDelete={(item) => { setConfirmTarget(item); setConfirmOpen(true); }}
          />
        </div>
      </div>

      {deleteResult && (
        <div className={`alert-banner ${deleteResult.failed_count > 0 || deleteResult.rejected.length > 0 ? 'alert-banner-warning' : 'alert-banner-success'} mt-16`} role="status">
          <span style={{ flex: 1 }}>
            <strong>{deleteResult.deleted_count} photo{deleteResult.deleted_count === 1 ? '' : 's'} removed.</strong>
            {deleteResult.failed_count > 0 && ` ${deleteResult.failed_count} could not be removed and will be retried automatically.`}
            {deleteResult.rejected.length > 0 && ` ${deleteResult.rejected.length} photo${deleteResult.rejected.length === 1 ? ' was' : 's were'} skipped: ${deleteResult.rejected.map((r) => r.reason).slice(0, 2).join('; ')}${deleteResult.rejected.length > 2 ? '…' : ''}`}
            {' '}Storage totals refresh now — this can take a few seconds.
          </span>
          <button type="button" className="btn btn-icon" onClick={() => setDeleteResult(null)} aria-label="Dismiss"><X size={15} /></button>
        </div>
      )}

      {selectedList.length > 0 && (
        <div className="card storage-selection-bar">
          <span className="text-sm">
            <strong>{selectedList.length}</strong> photo{selectedList.length === 1 ? '' : 's'} selected
            {selectedBytesKnown && ` · ~${formatBytes(selectedBytesTotal)} to free`}
          </span>
          <div className="flex items-center gap-8">
            <button type="button" className="btn btn-outline btn-sm" onClick={clearSelection}>Clear</button>
            <button type="button" className="btn btn-secondary" onClick={() => { setConfirmTarget(null); setConfirmOpen(true); }}>
              <Trash2 size={16} /> Delete Selected
            </button>
          </div>
        </div>
      )}

      <ConfirmModal
        isOpen={confirmOpen}
        onClose={() => { if (!deleting) { setConfirmOpen(false); setConfirmTarget(null); } }}
        onConfirm={() => void runDelete()}
        title="Permanently delete this photo evidence?"
        message={`${deleteTargets.length} photo${deleteTargets.length === 1 ? '' : 's'}${deleteTargetsBytesKnown ? ` (~${formatBytes(deleteTargetsBytesTotal)})` : ''} will be permanently removed from storage. This cannot be undone. The related booking and payment records remain — only the photo file itself will no longer be available.`}
        confirmLabel="Permanently Delete"
        variant="warning"
        loading={deleting}
      />
    </>
  );
};

/* ============================================================================
 * Company Images — company-assets bucket. Groups by its own existing storage
 * folders (banner/hero/...), no invented booking structure. Listing/reading
 * uses the Storage SDK directly (admin RLS already permits it); only the
 * eligibility check ("is this the live site banner") is server-side.
 * ==========================================================================*/
const COMPANY_BUCKET = 'company-assets';

const CompanyImagesBrowser = () => {
  const toast = useToast();
  const [groups, setGroups] = useState(null); // null = loading
  const [selectedGroup, setSelectedGroup] = useState(null);
  const [files, setFiles] = useState([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [thumbUrls, setThumbUrls] = useState({});
  const [previewFile, setPreviewFile] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [previewState, setPreviewState] = useState('idle');
  const [deletability, setDeletability] = useState({});
  const [selected, setSelected] = useState(() => new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmTarget, setConfirmTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const loadGroups = useCallback(async () => {
    setGroups(null);
    try {
      const { data, error } = await supabase.storage.from(COMPANY_BUCKET).list('', { limit: 200, sortBy: { column: 'name', order: 'asc' } });
      if (error) throw error;
      // Storage .list() returns both folders (id === null) and any stray
      // top-level files together — this bucket is only ever meant to hold
      // folders, but a stray file is still shown rather than hidden.
      setGroups((data || []).filter((entry) => entry.name));
    } catch (error) {
      toast.error(error?.message || 'Could not load Company Images.');
      setGroups([]);
    }
  }, [toast]);

  useEffect(() => { void loadGroups(); }, [loadGroups]);

  const openGroup = async (name) => {
    setSelectedGroup(name);
    setPreviewFile(null);
    setPreviewUrl(null);
    setFilesLoading(true);
    try {
      const { data, error } = await supabase.storage.from(COMPANY_BUCKET).list(name, { limit: 200, sortBy: { column: 'name', order: 'desc' } });
      if (error) throw error;
      const rows = (data || []).filter((f) => f.id).map((f) => ({ ...f, fullPath: `${name}/${f.name}` }));
      setFiles(rows);

      const paths = rows.map((f) => f.fullPath);
      if (paths.length > 0) {
        const checks = await checkCompanyAssetDeletable(paths).catch(() => []);
        setDeletability(Object.fromEntries(checks.map((c) => [c.storage_path, c])));
      } else {
        setDeletability({});
      }

      setThumbUrls((prev) => {
        const next = { ...prev };
        rows.forEach((f) => { if (!(f.fullPath in next)) next[f.fullPath] = undefined; });
        return next;
      });
      const resolved = await Promise.allSettled(rows.map((f) => resolvePhotoUrl({ type: 'supabase_storage', bucket: COMPANY_BUCKET, path: f.fullPath })));
      setThumbUrls((prev) => {
        const next = { ...prev };
        rows.forEach((f, i) => {
          const r = resolved[i];
          next[f.fullPath] = r.status === 'fulfilled' && r.value ? r.value : null;
        });
        return next;
      });
    } catch (error) {
      toast.error(error?.message || 'Could not load this folder.');
    } finally {
      setFilesLoading(false);
    }
  };

  const openPreview = (file) => {
    setPreviewFile(file);
    setPreviewState('loading');
    const cached = thumbUrls[file.fullPath];
    if (cached) { setPreviewUrl(cached); setPreviewState('ready'); }
    else setPreviewState('error');
  };

  const toggleSelect = (file) => {
    const d = deletability[file.fullPath];
    if (d && d.deletable === false) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(file.fullPath)) next.delete(file.fullPath);
      else next.add(file.fullPath);
      return next;
    });
  };

  const runDelete = async () => {
    const targets = confirmTarget ? [confirmTarget] : Array.from(selected);
    setDeleting(true);
    try {
      const checks = await checkCompanyAssetDeletable(targets);
      const byPath = Object.fromEntries(checks.map((c) => [c.storage_path, c]));
      const approved = targets.filter((p) => byPath[p]?.deletable);
      const blocked = targets.filter((p) => !byPath[p]?.deletable);

      if (approved.length > 0) {
        const { error } = await supabase.storage.from(COMPANY_BUCKET).remove(approved);
        if (error) throw error;
      }

      if (blocked.length > 0) {
        toast.error(`${approved.length} removed. ${blocked.length} could not be: ${byPath[blocked[0]]?.reason || 'currently in use'}.`);
      } else {
        toast.success(`${approved.length} file${approved.length === 1 ? '' : 's'} permanently removed.`);
      }

      setConfirmOpen(false);
      setConfirmTarget(null);
      setSelected((prev) => { const next = new Set(prev); approved.forEach((p) => next.delete(p)); return next; });
      if (previewFile && approved.includes(previewFile.fullPath)) { setPreviewFile(null); setPreviewUrl(null); }
      if (selectedGroup) await openGroup(selectedGroup);
    } catch (error) {
      toast.error(error?.message || 'Could not delete the selected files.');
    } finally {
      setDeleting(false);
    }
  };

  const activePane = previewFile ? 'preview' : selectedGroup ? 'photos' : 'folders';
  const selectedList = Array.from(selected);
  const deleteTargets = confirmTarget ? [confirmTarget] : selectedList;

  return (
    <>
      <div className="storage-browser" data-pane={activePane}>
        <div className="storage-col storage-col-folders" data-pane="folders">
          <div className="storage-col-header"><span className="text-sm fw-700">Groups</span></div>
          {groups == null ? <CenteredSpinner /> : (
            <div className="storage-folder-list" role="list">
              {groups.map((g) => (
                <button
                  key={g.name}
                  type="button"
                  role="listitem"
                  onClick={() => openGroup(g.name)}
                  className={`storage-folder-row ${selectedGroup === g.name ? 'storage-folder-row-active' : ''}`}
                >
                  {selectedGroup === g.name ? <FolderOpen size={16} /> : <Folder size={16} />}
                  <span className="storage-folder-row-text"><span className="storage-folder-row-title">{g.name}</span></span>
                </button>
              ))}
              {groups.length === 0 && <p className="text-sm text-secondary" style={{ padding: '16px 12px' }}>No company images found.</p>}
            </div>
          )}
        </div>

        <div className="storage-col storage-col-photos" data-pane="photos">
          <div className="storage-col-header">
            <button type="button" className="btn-icon storage-browser-mobile-back" onClick={() => setSelectedGroup(null)} aria-label="Back to groups"><ArrowLeft size={18} /></button>
            <span className="text-sm fw-700">{selectedGroup || 'Select a group'}</span>
          </div>
          {!selectedGroup ? (
            <p className="text-sm text-secondary" style={{ padding: '16px 12px' }}>Choose a group on the left.</p>
          ) : filesLoading ? <CenteredSpinner /> : (
            <div className="storage-photo-list" role="list">
              {files.map((f) => {
                const d = deletability[f.fullPath];
                const blocked = d?.deletable === false;
                return (
                  <div key={f.fullPath} className={`storage-photo-row ${previewFile?.fullPath === f.fullPath ? 'storage-photo-row-active' : ''}`}>
                    <button type="button" className="storage-photo-row-checkbox" onClick={() => toggleSelect(f)} disabled={blocked} aria-label={selected.has(f.fullPath) ? 'Deselect' : 'Select'}>
                      {blocked ? <Square size={16} style={{ opacity: 0.25 }} /> : selected.has(f.fullPath) ? <CheckSquare size={16} /> : <Square size={16} />}
                    </button>
                    <button type="button" className="storage-photo-row-thumb" onClick={() => openPreview(f)}>
                      {thumbUrls[f.fullPath] === undefined ? <Loader size={14} className="animate-spin text-secondary" /> : thumbUrls[f.fullPath] ? <img src={thumbUrls[f.fullPath]} alt="" /> : <ImageIcon size={16} className="text-secondary" />}
                    </button>
                    <button type="button" className="storage-photo-row-info" onClick={() => openPreview(f)}>
                      <span className="storage-photo-row-title">{f.name}</span>
                      <span className="storage-photo-row-meta">{formatBytes(f.metadata?.size)}</span>
                    </button>
                    {blocked && <span className="storage-photo-row-reason" title={d.reason}>{d.reason}</span>}
                  </div>
                );
              })}
              {files.length === 0 && <p className="text-sm text-secondary" style={{ padding: '16px 12px' }}>This group has no files.</p>}
            </div>
          )}
        </div>

        <div className="storage-col storage-col-preview" data-pane="preview">
          <div className="storage-col-header">
            <button type="button" className="btn-icon storage-browser-mobile-back" onClick={() => setPreviewFile(null)} aria-label="Back to files"><ArrowLeft size={18} /></button>
            <span className="text-sm fw-700">Preview</span>
          </div>
          {!previewFile ? (
            <div className="storage-preview-empty">
              <ImageIcon size={32} className="text-secondary" aria-hidden="true" />
              <p className="text-sm text-secondary" style={{ margin: '10px 0 0' }}>Select a file to preview it here.</p>
            </div>
          ) : (
            <div className="storage-preview">
              <div className="storage-preview-image-wrap">
                {previewState === 'error' || !previewUrl ? (
                  <AlertTriangle size={22} className="text-secondary" aria-hidden="true" />
                ) : (
                  <img src={previewUrl} alt={previewFile.name} />
                )}
              </div>
              <div className="storage-preview-details">
                <div className="text-sm fw-700">{previewFile.name}</div>
                <div className="text-xs text-secondary">{formatBytes(previewFile.metadata?.size)}</div>
                {deletability[previewFile.fullPath]?.deletable === false ? (
                  <p className="text-xs" style={{ color: 'var(--warning-text)', marginTop: 10 }}>{deletability[previewFile.fullPath].reason}</p>
                ) : (
                  <button type="button" className="btn btn-secondary btn-sm mt-12" onClick={() => { setConfirmTarget(previewFile.fullPath); setConfirmOpen(true); }}>
                    <Trash2 size={14} /> Delete This File
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {selectedList.length > 0 && (
        <div className="card storage-selection-bar">
          <span className="text-sm"><strong>{selectedList.length}</strong> file{selectedList.length === 1 ? '' : 's'} selected</span>
          <div className="flex items-center gap-8">
            <button type="button" className="btn btn-outline btn-sm" onClick={() => setSelected(new Set())}>Clear</button>
            <button type="button" className="btn btn-secondary" onClick={() => { setConfirmTarget(null); setConfirmOpen(true); }}><Trash2 size={16} /> Delete Selected</button>
          </div>
        </div>
      )}

      <ConfirmModal
        isOpen={confirmOpen}
        onClose={() => { if (!deleting) { setConfirmOpen(false); setConfirmTarget(null); } }}
        onConfirm={() => void runDelete()}
        title="Permanently delete these files?"
        message={`${deleteTargets.length} file${deleteTargets.length === 1 ? '' : 's'} will be permanently removed from storage. This cannot be undone.`}
        confirmLabel="Permanently Delete"
        variant="warning"
        loading={deleting}
      />
    </>
  );
};

/* ============================================================================
 * Top level — storage usage card + bucket selector + chosen browser
 * ==========================================================================*/
const PhotoStorageTab = () => {
  usePageTitle('Storage Monitoring — Photo Storage');

  const [overviewLoading, setOverviewLoading] = useState(true);
  const [health, setHealth] = useState(null);
  const [summary, setSummary] = useState(null);
  const [bucket, setBucket] = useState('cargo'); // 'cargo' | 'company'

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setOverviewLoading(true);
      const [healthResult, summaryResult] = await Promise.allSettled([checkPhotoStorageHealth(), getPhotoStorageSummary()]);
      if (cancelled) return;
      if (healthResult.status === 'fulfilled') setHealth(healthResult.value);
      if (summaryResult.status === 'fulfilled') setSummary(summaryResult.value);
      setOverviewLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  if (overviewLoading) return <CenteredSpinner />;

  const liveStorage = health?.supabase_storage;
  const usedBytes = liveStorage?.total_size_bytes == null ? null : Number(liveStorage.total_size_bytes);
  const quotaBytes = liveStorage?.included_storage_bytes == null ? null : Number(liveStorage.included_storage_bytes);
  const usagePercent = usedBytes != null && quotaBytes > 0 ? (usedBytes / quotaBytes) * 100 : null;
  const boundedPercent = usagePercent == null ? 0 : Math.max(0, Math.min(usagePercent, 100));
  const availableBytes = usedBytes != null && quotaBytes > 0 ? Math.max(0, quotaBytes - usedBytes) : null;
  const usageTone = usagePercent >= 95 ? 'var(--error)' : usagePercent >= 80 ? 'var(--warning)' : 'var(--success)';

  const firebasePhotoCount = Number(summary?.firebase_photo_count || 0);
  const failuresLast24h = Number(summary?.failures_last_24h || 0);

  return (
    <div>
      <div className="admin-page-header">
        <div>
          <h1 className="admin-page-title"><Database size={24} color="var(--primary)" aria-hidden="true" />Photo Storage</h1>
          <p className="admin-page-subtitle">See how much space is used, open a folder, and delete photos that are no longer needed.</p>
        </div>
      </div>

      {/* ── Storage Usage: compact card ── */}
      <section className="card admin-section-card mb-24">
        <div className="card-header"><h3><HardDrive size={17} className="inline mr-8" />Storage Usage</h3></div>
        <div className="card-body">
          {usagePercent != null ? (
            <>
              <div className="flex items-center justify-between text-sm mb-8">
                <span>{formatPercent(usagePercent)} used · {formatBytes(usedBytes)} of {formatBytes(quotaBytes)}</span>
                {availableBytes != null && <span className="text-secondary">{formatBytes(availableBytes)} available</span>}
              </div>
              <div role="progressbar" aria-label="Photo storage used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(boundedPercent)}
                style={{ height: 10, borderRadius: 999, overflow: 'hidden', background: 'var(--bg-secondary)' }}>
                <div style={{ width: `${Math.max(boundedPercent, usagePercent > 0 ? 1 : 0)}%`, height: '100%', background: usageTone, borderRadius: 999, transition: 'width 300ms ease' }} />
              </div>
            </>
          ) : (
            <p className="text-sm text-secondary" style={{ margin: 0 }}>
              {liveStorage?.live_usage_status === 'available' ? 'This plan does not have a fixed storage limit.' : 'Storage use could not be checked just now.'}
            </p>
          )}
          <p className="text-xs text-secondary" style={{ margin: '10px 0 0' }}>
            Space used is measured live across all files (cargo photos and website images); the allowance shown is the published plan limit, not a number read from your account.
            {firebasePhotoCount > 0 && ` Backup storage separately holds ${number(firebasePhotoCount)} photo${firebasePhotoCount === 1 ? '' : 's'} — not included above.`}
          </p>
          {failuresLast24h > 0 && (
            <div className="alert-banner alert-banner-warning mt-12" role="status">
              <AlertTriangle size={16} />
              <span>{failuresLast24h} photo{failuresLast24h === 1 ? '' : 's'} failed to save in the last 24 hours.</span>
            </div>
          )}
        </div>
      </section>

      <div className="alert-banner alert-banner-info mb-24" role="status">
        <span>
          <strong>Manual deletion:</strong> admins can delete an eligible pickup/delivery photo from a Delivered or Cancelled booking at any time.{' '}
          <strong>Automatic cleanup:</strong> if not deleted manually, those same photos are permanently removed on their own after 6 months. Receipts, website-featured photos, and photos tied to a payment still being reconciled are always kept either way.
        </span>
      </div>

      <div className="flex gap-8 mb-16">
        <button type="button" className={`btn btn-sm ${bucket === 'cargo' ? 'btn-primary' : 'btn-outline'}`} onClick={() => setBucket('cargo')}>Cargo Photos</button>
        <button type="button" className={`btn btn-sm ${bucket === 'company' ? 'btn-primary' : 'btn-outline'}`} onClick={() => setBucket('company')}>Company Images</button>
      </div>

      <section className="card admin-section-card storage-browser-card">
        {bucket === 'cargo' ? <CargoPhotoBrowser /> : <CompanyImagesBrowser />}
      </section>
    </div>
  );
};

export default PhotoStorageTab;
