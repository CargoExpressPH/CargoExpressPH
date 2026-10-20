import { useState, useRef, useEffect, useCallback, useId, useMemo } from 'react';
import { createPortal } from 'react-dom';
import {
  X, CameraOff, RotateCcw, Loader, CheckCircle, AlertTriangle,
  Package, Search, Volume2, VolumeX, Zap, ZapOff, Check, ArrowRight,
  Truck, ShieldCheck, MapPin, Camera, Keyboard, CloudOff, RefreshCw, Flag, Ban
} from 'lucide-react';
import FocusTrap from './FocusTrap';
import useScrollLock from '../../hooks/useScrollLock';
import { useToast } from '../../hooks/useToast';
import { parseScanPayload, normalizeTrackingNumber } from '../../utils/scanPayload';
import {
  findOrderTripForScan,
  listLoadingShortfalls,
  recordBoxVerification,
  recordDeliveryPayment,
  reportAndApproveShortfall,
} from '../../lib/database';
import {
  SCAN_EVENT_TYPES,
  countPendingScans,
  findDuplicateScan,
  flushPendingScans,
  formatScanTime,
  getTripManifest,
  isNetworkError,
  queueScanEvent,
  recordSyncedScan,
  saveTripManifest,
  startOnlineSync,
} from '../../lib/offlineScannerQueue';
import ManualBoxMatchOverlay from './ManualBoxMatchOverlay';
import UnidentifiedBoxModal from './UnidentifiedBoxModal';
import ShortfallModal from './ShortfallModal';
import { orderPartyName } from '../../lib/orderParties';
import { logOrder, logTrip } from '../../lib/activityLog';
import { ORDER_STATUS } from '../../constants/status';
import DeliveryModal from './DeliveryModal';
import {
  playScanSuccessSound,
  playScanErrorSound,
  playScanDuplicateSound,
  playScanCompleteSound,
  playWrongRouteSound,
  setScanAudioMuted,
  isScanAudioMuted,
} from '../../utils/scanAudio';

// Replays a scan that was queued offline. record_box_verification() is idempotent, so a retry is always safe.
const sendQueuedScan = (event) => recordBoxVerification(event.order_id, event.box_number);

const SCAN_INTERVAL_MS = 120;
const SAME_CODE_COOLDOWN_MS = 1500;
const LIVE_MAX_SIDE = 720;
const PHOTO_MAX_SIDES = [1024, 2048];

let cameraQueue = Promise.resolve();

const stopStream = (stream) => {
  if (!stream) return;
  stream.getTracks().forEach((track) => {
    try { track.stop(); } catch { /* already stopped */ }
  });
};

const sourceSize = (source) => ({
  width: source.videoWidth || source.naturalWidth || source.width || 0,
  height: source.videoHeight || source.naturalHeight || source.height || 0,
});

let jsQrCanvas = null;

const decodeWithJsQr = (jsQR, source, maxSide, inversionAttempts) => {
  const { width, height } = sourceSize(source);
  if (!width || !height) return null;
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  if (!jsQrCanvas) jsQrCanvas = document.createElement('canvas');
  if (jsQrCanvas.width !== w) jsQrCanvas.width = w;
  if (jsQrCanvas.height !== h) jsQrCanvas.height = h;
  const ctx = jsQrCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, w, h);
  const image = ctx.getImageData(0, 0, w, h);
  const code = jsQR(image.data, w, h, { inversionAttempts });
  return code?.data || null;
};

const createDecoder = async () => {
  const Detector = typeof window !== 'undefined' ? window.BarcodeDetector : undefined;
  if (Detector) {
    try {
      const formats = typeof Detector.getSupportedFormats === 'function'
        ? await Detector.getSupportedFormats()
        : [];
      if (formats.includes('qr_code')) {
        const detector = new Detector({ formats: ['qr_code'] });
        return async (source) => {
          const codes = await detector.detect(source);
          const hit = codes.find((code) => code.rawValue);
          return hit ? hit.rawValue : null;
        };
      }
    } catch { /* fallback to jsQR */ }
  }

  const { default: jsQR } = await import('jsqr');
  return async (source, { photo = false } = {}) => {
    if (!photo) return decodeWithJsQr(jsQR, source, LIVE_MAX_SIDE, 'dontInvert');
    for (const maxSide of PHOTO_MAX_SIDES) {
      const text = decodeWithJsQr(jsQR, source, maxSide, 'attemptBoth');
      if (text) return text;
    }
    return null;
  };
};

const loadImage = (file) => new Promise((resolve, reject) => {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => resolve({ img, url });
  img.onerror = () => {
    URL.revokeObjectURL(url);
    reject(new Error('image-load-failed'));
  };
  img.src = url;
});

const TripScannerModal = ({
  trip,
  orders: initialOrders = [],
  onOrdersUpdate,
  onClose,
}) => {
  const titleId = useId();
  const toast = useToast();
  useScrollLock(true);

  // Local mirror of orders to allow instant optimistic UI updates on scan
  const [orders, setOrders] = useState(initialOrders);
  const ordersRef = useRef(orders);
  ordersRef.current = orders;

  // Sync if initialOrders changes externally
  useEffect(() => {
    setOrders(initialOrders);
  }, [initialOrders]);

  const isDeliveryMode = trip.status === 'arrived';
  const eventType = isDeliveryMode ? SCAN_EVENT_TYPES.DELIVERY_VERIFY : SCAN_EVENT_TYPES.LOAD_VERIFY;

  // Supervisor-approved loading shortfalls. They only release the trip's
  // departure: a held box is still missing at the door, so they are ignored
  // once the trip is unloading.
  const [shortfalls, setShortfalls] = useState([]);
  const heldKeys = useMemo(() => (
    isDeliveryMode ? new Set() : new Set(shortfalls.map((s) => `${s.order_id}:${s.box_number}`))
  ), [shortfalls, isDeliveryMode]);

  // Scanner state
  const videoRef = useRef(null);
  const decoderRef = useRef(null);
  const streamRef = useRef(null);
  const resolvingRef = useRef(false);
  const lastScanRef = useRef({ text: '', at: 0 });
  const mountedRef = useRef(true);

  const [cameraState, setCameraState] = useState('starting');
  const [cameraError, setCameraError] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);

  // Flashlight / torch
  const [hasTorch, setHasTorch] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

  // Audio feedback mute toggle
  const [muted, setMuted] = useState(isScanAudioMuted());

  // Scanner UI notices & animations
  const [notice, setNotice] = useState('');
  const [noticeTone, setNoticeTone] = useState('info');
  const [pulseState, setPulseState] = useState(''); // 'is-success-pulse' | 'is-error-pulse'
  const [lastScannedOrderId, setLastScannedOrderId] = useState(null);

  // Manifest checklist filter & search
  const [filterTab, setFilterTab] = useState('all'); // 'all' | 'pending' | 'verified'
  const [searchQuery, setSearchQuery] = useState('');

  // Field fallbacks & exceptions
  const [manualOpen, setManualOpen] = useState(false);       // Case A: QR unreadable
  const [unidentifiedOpen, setUnidentifiedOpen] = useState(false); // Case B: nothing readable
  const [shortfallMissing, setShortfallMissing] = useState(null);  // boxes for the Report Shortfall modal
  const [wrongRoute, setWrongRoute] = useState(null);        // hard-block: { label, tripNumber }
  const wrongRouteRef = useRef(null);

  // Offline queue
  const [pendingCount, setPendingCount] = useState(0);
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine !== false);

  // Proof of delivery in-place modal
  const [podOrder, setPodOrder] = useState(null);
  const [podOpen, setPodOpen] = useState(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Approved loading shortfalls for this trip (loading phase only).
  useEffect(() => {
    if (isDeliveryMode) return;
    listLoadingShortfalls(trip.id)
      .then((rows) => { if (mountedRef.current) setShortfalls(rows); })
      .catch(() => { /* offline or not migrated yet: the trip simply has no exceptions to show */ });
  }, [trip.id, isDeliveryMode]);

  // Keep a copy of the manifest on the device so labels still resolve with no signal,
  // and fall back to that copy if the modal opens before the page has any orders.
  useEffect(() => {
    if (orders.length > 0) saveTripManifest(trip.id, orders).catch(() => { /* cache is best-effort */ });
  }, [orders, trip.id]);

  useEffect(() => {
    if (initialOrders.length > 0) return;
    getTripManifest(trip.id)
      .then((cached) => { if (cached?.orders?.length && mountedRef.current) setOrders(cached.orders); })
      .catch(() => { /* nothing cached */ });
  }, [trip.id, initialOrders.length]);

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    setScanAudioMuted(next);
  };

  const toggleTorch = async () => {
    if (!streamRef.current) return;
    const track = streamRef.current.getVideoTracks()[0];
    if (!track) return;
    try {
      const next = !torchOn;
      await track.applyConstraints({ advanced: [{ torch: next }] });
      setTorchOn(next);
    } catch {
      toast.warning('Flashlight not available on this camera');
    }
  };

  const getDecoder = useCallback(async () => {
    if (!decoderRef.current) decoderRef.current = createDecoder();
    try {
      return await decoderRef.current;
    } catch (error) {
      decoderRef.current = null;
      throw error;
    }
  }, []);

  // ── Manifest Stats ───────────────────────────────────────────────────────
  const eligibleOrders = useMemo(() => (
    orders.filter((o) => !['Cancelled', 'Pending Cancellation', 'Pending', 'Assigned'].includes(o.status))
  ), [orders]);

  const totalTripBoxes = useMemo(() => (
    eligibleOrders.reduce((sum, o) => sum + (o.package_quantity || 1), 0)
  ), [eligibleOrders]);

  const totalScannedBoxes = useMemo(() => (
    eligibleOrders.reduce((sum, o) => {
      const qty = o.package_quantity || 1;
      return sum + (o.verified_boxes || []).filter((b) => b <= qty).length;
    }, 0)
  ), [eligibleOrders]);

  // Held boxes: approved shortfalls whose box has not turned up since.
  const totalHeldBoxes = useMemo(() => (
    eligibleOrders.reduce((sum, o) => {
      const qty = o.package_quantity || 1;
      const verified = o.verified_boxes || [];
      return sum + Array.from({ length: qty }, (_, i) => i + 1)
        .filter((b) => !verified.includes(b) && heldKeys.has(`${o.id}:${b}`)).length;
    }, 0)
  ), [eligibleOrders, heldKeys]);

  const allCargoVerified = totalTripBoxes > 0 && totalScannedBoxes === totalTripBoxes;
  const allCargoAccountedFor = totalTripBoxes > 0 && totalScannedBoxes + totalHeldBoxes === totalTripBoxes;

  /** Boxes neither scanned nor held — what "Finish loading" has to explain. */
  const missingBoxes = useMemo(() => eligibleOrders.flatMap((o) => {
    const qty = o.package_quantity || 1;
    const verified = o.verified_boxes || [];
    return Array.from({ length: qty }, (_, i) => i + 1)
      .filter((b) => !verified.includes(b) && !heldKeys.has(`${o.id}:${b}`))
      .map((b) => ({ order: o, box: b }));
  }), [eligibleOrders, heldKeys]);

  // Flash visual feedback
  const triggerPulse = (type) => {
    setPulseState(type);
    setTimeout(() => {
      if (mountedRef.current) setPulseState('');
    }, 600);
  };

  // ── Shared plumbing ──────────────────────────────────────────────────────
  const overlayOpenRef = useRef(false);
  overlayOpenRef.current = manualOpen || unidentifiedOpen || Boolean(shortfallMissing);

  const applyVerified = useCallback((orderId, boxes) => {
    const nextOrders = ordersRef.current.map((o) => (
      o.id === orderId ? { ...o, verified_boxes: boxes } : o
    ));
    setOrders(nextOrders);
    ordersRef.current = nextOrders;
    onOrdersUpdate?.(nextOrders);
    return nextOrders;
  }, [onOrdersUpdate]);

  const refreshPending = useCallback(() => {
    countPendingScans(trip.id)
      .then((n) => { if (mountedRef.current) setPendingCount(n); })
      .catch(() => { /* storage unavailable: the badge just stays at its last value */ });
  }, [trip.id]);

  const showWrongRoute = useCallback((info) => {
    playWrongRouteSound();
    triggerPulse('is-error-pulse');
    wrongRouteRef.current = info;
    setWrongRoute(info);
  }, []);

  const dismissWrongRoute = () => {
    wrongRouteRef.current = null;
    // The bad label is usually still in frame; don't re-fire the moment the block lifts.
    lastScanRef.current = { text: lastScanRef.current.text, at: Date.now() };
    setWrongRoute(null);
  };

  /**
   * Counts one box. QR scans, the Case A match, the Case B proof and the
   * per-box fallback button all go through here so they share the duplicate
   * check, the offline queue and the optimistic update.
   * Resolves { status: 'verified' | 'queued' | 'duplicate', ... } or throws a
   * server rejection (network failures are queued, never thrown).
   */
  const commitBox = useCallback(async (targetOrder, boxNumber, { method = 'qr', evidence = null } = {}) => {
    const current = ordersRef.current.find((o) => o.id === targetOrder.id) || targetOrder;
    const packageQty = current.package_quantity || 1;
    const currentVerified = current.verified_boxes || [];
    const scan = { orderId: current.id, box: boxNumber, eventType, tripId: trip.id };

    // A synced event only counts as a duplicate while the order still shows the
    // box as verified; the server may have reset it since (e.g. Out for Delivery).
    const earlier = await findDuplicateScan(scan).catch(() => null);
    if (currentVerified.includes(boxNumber) || earlier?.status === 'pending') {
      return { status: 'duplicate', at: earlier ? formatScanTime(earlier.scanned_at) : '', packageQty };
    }

    let newVerified = null;
    let queued = typeof navigator !== 'undefined' && navigator.onLine === false;
    if (!queued) {
      try {
        const list = await recordBoxVerification(current.id, boxNumber);
        newVerified = Array.isArray(list) ? list : null;
        await recordSyncedScan(scan).catch(() => { /* local cache only */ });
      } catch (err) {
        if (!isNetworkError(err)) throw err;
        queued = true;
      }
    }
    if (queued) {
      await queueScanEvent(scan);
      refreshPending();
    }
    if (!newVerified) {
      newVerified = Array.from(new Set([...currentVerified, boxNumber])).sort((a, b) => a - b);
    }
    if (!mountedRef.current) return { status: queued ? 'queued' : 'verified', packageQty, nextOrders: ordersRef.current };

    const nextOrders = applyVerified(current.id, newVerified);

    // A queued scan is logged when it syncs, so the log never claims a verification the server has not seen.
    if (!queued) {
      const labels = {
        qr: 'Cargo Box Verified via Trip Scanner',
        manual_match: 'Cargo Box Verified by Manual Match (QR unreadable)',
        manual_button: 'Cargo Box Verified Manually via Trip Scanner',
        strict_proof: 'Cargo Box Verified by Strict Proof (label unreadable)',
      };
      logOrder(labels[method] || labels.qr, current.id, current.tracking_number, {
        tripNumber: trip.trip_number,
        box: boxNumber,
        totalBoxes: packageQty,
        method,
        details: `Verified box ${boxNumber} of ${packageQty} in trip ${trip.trip_number} (${method}).${
          evidence ? ` Evidence: photo ${evidence.photoRef}; signature ${evidence.signatureRef}.` : ''
        }`,
      });
    }

    return { status: queued ? 'queued' : 'verified', packageQty, nextOrders };
  }, [applyVerified, eventType, refreshPending, trip.id, trip.trip_number]);

  /** Turns a commitBox() result into the notice, sound and pulse the driver sees. */
  const announceResult = useCallback((result, order, boxNumber) => {
    setLastScannedOrderId(order.id);
    const qty = result.packageQty;

    if (result.status === 'duplicate') {
      playScanDuplicateSound();
      setNoticeTone('warning');
      setNotice(`Box ${boxNumber} of ${qty} for ${order.tracking_number} is already scanned${result.at ? ` at ${result.at}` : ''}.`);
      return;
    }

    triggerPulse('is-success-pulse');
    const nextOrders = result.nextOrders || ordersRef.current;
    const scanned = nextOrders
      .filter((o) => !['Cancelled', 'Pending Cancellation', 'Pending', 'Assigned'].includes(o.status))
      .reduce((sum, o) => {
        const q = o.package_quantity || 1;
        return sum + (o.verified_boxes || []).filter((b) => b <= q).length;
      }, 0);
    const receiver = orderPartyName(order, 'receiver') || 'Receiver';

    if (result.status === 'queued') {
      playScanSuccessSound();
      setNoticeTone('warning');
      setNotice(`Saved offline: Box ${boxNumber}/${qty} for ${order.tracking_number}. It will sync when you are back online.`);
    } else if (scanned + totalHeldBoxes >= totalTripBoxes && totalTripBoxes > 0) {
      playScanCompleteSound();
      setNoticeTone('success');
      setNotice(`All ${totalTripBoxes} trip boxes verified! Van is ready for departure.`);
    } else {
      playScanSuccessSound();
      setNoticeTone('success');
      setNotice(`Verified: Box ${boxNumber}/${qty} for ${order.tracking_number} (${receiver})`);
    }
  }, [totalHeldBoxes, totalTripBoxes]);

  /**
   * A scan or typed code that is not on this trip. Asks the database which
   * trip it does belong to so the driver gets a hard "Wrong Route" block rather
   * than a generic warning; if that lookup is impossible (offline), it falls
   * back to the plain "do not load" notice.
   */
  const rejectForeign = useCallback(async (payload) => {
    resolvingRef.current = true;
    setBusy(true);
    const fallbackLabel = payload.trackingNumber || 'This package';
    try {
      const found = await findOrderTripForScan({
        orderId: payload.kind === 'order' ? payload.orderId : null,
        trackingNumber: payload.kind === 'tracking' ? payload.trackingNumber : null,
      });
      if (!mountedRef.current) return;
      if (found && found.tripId !== trip.id) {
        showWrongRoute({ label: found.trackingNumber, tripNumber: found.tripNumber });
        return;
      }
      playScanErrorSound();
      triggerPulse('is-error-pulse');
      setNoticeTone('danger');
      setNotice(found
        ? `${found.trackingNumber} is not on this trip's manifest. Do not load.`
        : `No booking found for ${fallbackLabel}.`);
    } catch {
      if (!mountedRef.current) return;
      playScanErrorSound();
      triggerPulse('is-error-pulse');
      setNoticeTone('danger');
      setNotice(`Warning: ${fallbackLabel} is not assigned to Trip ${trip.trip_number}. Do not load. (Could not check which trip it belongs to.)`);
    } finally {
      if (mountedRef.current) {
        setBusy(false);
        resolvingRef.current = false;
      }
    }
  }, [showWrongRoute, trip.id, trip.trip_number]);

  // ── Core QR Scan Handler ─────────────────────────────────────────────────
  const handleScan = useCallback(async (text) => {
    // A wrong-route block or an open fallback sheet owns the screen: ignore the camera until it is dismissed.
    if (resolvingRef.current || busy || wrongRouteRef.current || overlayOpenRef.current) return;

    const trimmed = String(text || '').trim();
    if (!trimmed) return;

    const last = lastScanRef.current;
    const now = Date.now();
    // Prevent repeated scans of the exact same code in a split second
    if (trimmed === last.text && now - last.at < SAME_CODE_COOLDOWN_MS) {
      return;
    }
    lastScanRef.current = { text: trimmed, at: now };

    const payload = parseScanPayload(trimmed);

    if (payload.kind === 'payment') {
      playScanErrorSound();
      triggerPulse('is-error-pulse');
      setNoticeTone('warning');
      setNotice('Scanned a GCash payment QR, not a package barcode label.');
      return;
    }

    if (payload.kind === 'unknown') {
      playScanErrorSound();
      triggerPulse('is-error-pulse');
      setNoticeTone('danger');
      setNotice('QR code is not recognized as a CargoExpress package label.');
      return;
    }

    // Identify which order in this trip this scan refers to
    const currentOrders = ordersRef.current;
    let targetOrder = null;

    if (payload.kind === 'order') {
      targetOrder = currentOrders.find((o) => o.id === payload.orderId);
    } else if (payload.kind === 'tracking') {
      targetOrder = currentOrders.find((o) => (
        o.tracking_number?.toUpperCase() === payload.trackingNumber?.toUpperCase()
      ));
    }

    // ── Wrong-route / foreign cargo check ──
    if (!targetOrder) {
      await rejectForeign(payload);
      return;
    }

    // Determine target box number
    const packageQty = targetOrder.package_quantity || 1;
    let boxNumber = payload.box;

    if (!boxNumber) {
      if (packageQty === 1) {
        boxNumber = 1;
      } else {
        // Auto-assign to the first unverified box for this booking
        const verified = targetOrder.verified_boxes || [];
        for (let b = 1; b <= packageQty; b += 1) {
          if (!verified.includes(b)) {
            boxNumber = b;
            break;
          }
        }
        if (!boxNumber) boxNumber = 1; // all already verified
      }
    }

    if (boxNumber > packageQty) {
      playScanErrorSound();
      triggerPulse('is-error-pulse');
      setNoticeTone('warning');
      setNotice(`Box ${boxNumber} is outside the booking limit (${packageQty} boxes total).`);
      return;
    }

    // ── Execute verification ──
    resolvingRef.current = true;
    setBusy(true);

    try {
      const result = await commitBox(targetOrder, boxNumber, { method: 'qr' });
      if (!mountedRef.current) return;
      announceResult(result, targetOrder, boxNumber);
    } catch (err) {
      if (!mountedRef.current) return;
      playScanErrorSound();
      triggerPulse('is-error-pulse');
      setNoticeTone('danger');
      setNotice(err?.message || 'Could not verify box. Please check connection and try again.');
    } finally {
      if (mountedRef.current) {
        setBusy(false);
        resolvingRef.current = false;
      }
    }
  }, [announceResult, busy, commitBox, rejectForeign]);

  // Keep ref up to date
  const handleScanRef = useRef(handleScan);
  handleScanRef.current = handleScan;

  // ── Fallback handlers ────────────────────────────────────────────────────
  // Runs a commit for a non-camera path and reports the outcome the same way a scan does.
  const runFallbackCommit = async (order, box, options) => {
    if (busy || resolvingRef.current) return;
    resolvingRef.current = true;
    setBusy(true);
    try {
      const result = await commitBox(order, box, options);
      if (mountedRef.current) announceResult(result, order, box);
    } finally {
      if (mountedRef.current) {
        setBusy(false);
        resolvingRef.current = false;
      }
    }
  };

  // Per-box "+ Verify Box N" button on a manifest card.
  const handleManualVerifyBox = async (order, boxNum) => {
    try {
      await runFallbackCommit(order, boxNum, { method: 'manual_button' });
    } catch (e) {
      playScanErrorSound();
      toast.error(e.message || 'Failed to verify box');
    }
  };

  // Case A: the driver typed the AWB / short code and confirmed the masked details match the box.
  const handleManualMatchConfirm = async (order, box) => {
    try {
      await runFallbackCommit(order, box, { method: 'manual_match' });
      setManualOpen(false);
    } catch (e) {
      playScanErrorSound();
      toast.error(e.message || 'Failed to verify box');
    }
  };

  // Case A, no match on this trip: ask the database whether it belongs elsewhere.
  const handleManualNotInManifest = (value) => {
    const payload = parseScanPayload(value);
    if (payload.kind === 'tracking') {
      setManualOpen(false);
      void rejectForeign(payload);
    } else {
      playScanErrorSound();
    }
  };

  // Case B: strict proof (photo + signature) was saved by the modal; count the box.
  const handleUnidentifiedMatch = async (order, box, evidence) => {
    await runFallbackCommit(order, box, { method: 'strict_proof', evidence });
    setUnidentifiedOpen(false);
  };

  // ── Offline queue sync ───────────────────────────────────────────────────
  const handleFlushed = useCallback((summary) => {
    refreshPending();
    summary.synced.forEach((event) => {
      const order = ordersRef.current.find((o) => o.id === event.order_id);
      if (!order) return;
      logOrder('Cargo Box Verified via Trip Scanner (synced from offline)', order.id, order.tracking_number, {
        tripNumber: trip.trip_number,
        box: event.box_number,
        details: `Box ${event.box_number} scanned offline at ${formatScanTime(event.scanned_at)} and synced.`,
      });
    });
    if (summary.synced.length) {
      toast.success(`${summary.synced.length} offline scan${summary.synced.length === 1 ? '' : 's'} synced.`);
    }
    if (summary.failed.length) {
      // The server refused these, so take the optimistic tick back.
      summary.failed.forEach((event) => {
        const order = ordersRef.current.find((o) => o.id === event.order_id);
        if (order) applyVerified(order.id, (order.verified_boxes || []).filter((b) => b !== event.box_number));
      });
      toast.error(`${summary.failed.length} offline scan${summary.failed.length === 1 ? ' was' : 's were'} rejected: ${summary.failed[0].last_error}. Scan again.`);
    }
  }, [applyVerified, refreshPending, toast, trip.trip_number]);

  const syncNow = () => {
    flushPendingScans(sendQueuedScan, { tripId: trip.id })
      .then((summary) => {
        if (summary.synced.length || summary.failed.length) handleFlushed(summary);
        else if (summary.remaining) toast.warning('Still offline — scans stay saved on this device.');
      })
      .catch(() => toast.error('Could not read the offline queue.'));
  };

  // ── Finish loading / shortfall ───────────────────────────────────────────
  const handleFinishLoading = () => {
    if (pendingCount > 0) {
      toast.warning(`${pendingCount} scan${pendingCount === 1 ? ' is' : 's are'} still waiting to sync. Reconnect before finishing.`);
      return;
    }
    if (missingBoxes.length === 0) {
      toast.success(allCargoVerified ? 'All cargo loaded.' : 'Loading finished with supervisor-approved shortfalls.');
      onClose();
      return;
    }
    setShortfallMissing(missingBoxes);
  };

  const handleShortfallSubmit = async ({ reason, supervisorCode }) => {
    const items = shortfallMissing || [];
    // Sequential: a wrong code must fail on the first box, not be counted once per box.
    for (let i = 0; i < items.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await reportAndApproveShortfall({
        tripId: trip.id,
        orderId: items[i].order.id,
        box: items[i].box,
        reason,
        supervisorCode,
      });
    }
    logTrip('Loading Shortfall Approved', trip.id, trip.trip_number, {
      details: `${items.length} box(es) released by supervisor approval (${reason}): ${
        items.map((m) => `${m.order.tracking_number} box ${m.box}`).join(', ')
      }.`,
    });
    toast.success('Shortfall approved. The trip can now start.');
    setShortfallMissing(null);
    onClose();
  };

  // ── Delivery / POD flow ──────────────────────────────────────────────────
  const handleOpenDelivery = (order) => {
    setPodOrder(order);
    setPodOpen(true);
  };

  const handleDeliverySubmit = async (deliveryData) => {
    if (!podOrder) return;
    await recordDeliveryPayment(podOrder.id, deliveryData);
    logOrder('Delivery Proof Uploaded via Trip Scanner', podOrder.id, podOrder.tracking_number, {
      details: `Delivery processed in trip ${trip.trip_number}. Photos: ${deliveryData.delivery_photos.length}`,
    });
    toast.success(`Delivery completed for ${podOrder.tracking_number}!`);

    // Update order status locally to 'Delivered'
    const nextOrders = ordersRef.current.map((o) => (
      o.id === podOrder.id ? { ...o, status: ORDER_STATUS.DELIVERED } : o
    ));
    setOrders(nextOrders);
    ordersRef.current = nextOrders;
    onOrdersUpdate?.(nextOrders);

    setPodOpen(false);
    setPodOrder(null);
  };

  // ── Camera Initialization & Loop ─────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    let stream = null;
    let rafId = null;
    let decoding = false;
    let lastScanAt = 0;
    const video = videoRef.current;

    const loop = (decode) => {
      const tick = () => {
        if (cancelled) return;
        const now = performance.now();
        if (!decoding && !resolvingRef.current && video && video.readyState >= 2 && now - lastScanAt >= SCAN_INTERVAL_MS) {
          lastScanAt = now;
          decoding = true;
          Promise.resolve()
            .then(() => decode(video))
            .then((text) => {
              if (text && !cancelled) return handleScanRef.current(text);
              return undefined;
            })
            .catch(() => { /* skip frame */ })
            .then(() => { decoding = false; });
        }
        rafId = requestAnimationFrame(tick);
      };
      rafId = requestAnimationFrame(tick);
    };

    const startCamera = async () => {
      setCameraState('starting');
      setCameraError(null);

      if (!window.isSecureContext || !navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
        setCameraState('error');
        setCameraError({
          title: 'Camera not available',
          message: 'Camera requires a secure HTTPS connection or supported browser.',
        });
        return;
      }

      const request = cameraQueue.then(async () => {
        if (cancelled) return null;
        return navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        });
      });
      cameraQueue = request.catch(() => null);

      try {
        stream = await request;
      } catch (err) {
        if (cancelled) return;
        setCameraState('error');
        setCameraError({
          title: 'Camera access error',
          message: err?.name === 'NotAllowedError'
            ? 'Camera permission denied. Allow camera in your browser settings.'
            : 'Could not access the camera. Check if another app is using it.',
        });
        return;
      }

      if (!stream || cancelled) {
        stopStream(stream);
        return;
      }

      streamRef.current = stream;

      // Check for torch capability
      const track = stream.getVideoTracks()[0];
      if (track && typeof track.getCapabilities === 'function') {
        const capabilities = track.getCapabilities();
        setHasTorch(Boolean(capabilities?.torch));
      }

      track?.addEventListener('ended', () => {
        if (mountedRef.current) {
          setCameraState('error');
          setCameraError({
            title: 'Camera disconnected',
            message: 'Camera stopped or was taken by another app.',
          });
        }
      });

      video.setAttribute('playsinline', '');
      video.setAttribute('muted', '');
      video.muted = true;
      video.srcObject = stream;

      try {
        await video.play();
      } catch {
        if (cancelled) return;
      }

      let decode;
      try {
        decode = await getDecoder();
      } catch {
        if (cancelled) return;
        setCameraState('error');
        setCameraError({
          title: 'Scanner engine failed',
          message: 'Could not load the QR decoder. Check your connection.',
        });
        return;
      }

      if (cancelled) return;
      setCameraState('live');
      loop(decode);
    };

    if (!podOpen) {
      void startCamera();
    }

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      stopStream(stream);
      streamRef.current = null;
      if (video) {
        try { video.pause(); } catch { /* ignore */ }
        video.srcObject = null;
      }
    };
  }, [attempt, podOpen, getDecoder]);

  // Offline queue: show the count, and flush it whenever connectivity returns.
  useEffect(() => {
    refreshPending();
    const markOnline = () => setOnline(true);
    const markOffline = () => setOnline(false);
    window.addEventListener('online', markOnline);
    window.addEventListener('offline', markOffline);
    const stopSync = startOnlineSync(sendQueuedScan, handleFlushed, { tripId: trip.id });
    return () => {
      window.removeEventListener('online', markOnline);
      window.removeEventListener('offline', markOffline);
      stopSync();
    };
  }, [handleFlushed, refreshPending, trip.id]);

  // Escape key closes modal
  useEffect(() => {
    const onKeyDown = (e) => {
      // A fallback sheet or the wrong-route block handles its own dismissal.
      if (e.key === 'Escape' && !podOpen && !overlayOpenRef.current && !wrongRouteRef.current) onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose, podOpen]);

  // ── Filtered Manifest List ──
  const filteredOrders = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    return orders.filter((o) => {
      // Exclude cancelled/pending
      if (['Cancelled', 'Pending Cancellation'].includes(o.status)) return false;

      const qty = o.package_quantity || 1;
      const verifiedCount = (o.verified_boxes || []).filter((b) => b <= qty).length;
      const isComplete = verifiedCount === qty;

      if (filterTab === 'pending' && isComplete) return false;
      if (filterTab === 'verified' && !isComplete) return false;

      if (!q) return true;

      const trackingMatch = o.tracking_number?.toLowerCase().includes(q);
      const receiverMatch = orderPartyName(o, 'receiver')?.toLowerCase().includes(q);
      const senderMatch = orderPartyName(o, 'sender')?.toLowerCase().includes(q);
      const cityMatch = o.receiver_city?.toLowerCase().includes(q);

      return trackingMatch || receiverMatch || senderMatch || cityMatch;
    });
  }, [orders, filterTab, searchQuery]);

  // If POD modal is active, display it in place
  if (podOpen && podOrder) {
    return (
      <DeliveryModal
        order={podOrder}
        onClose={() => { setPodOpen(false); setPodOrder(null); }}
        onSave={handleDeliverySubmit}
      />
    );
  }

  const completionPercent = totalTripBoxes > 0
    ? Math.round((totalScannedBoxes / totalTripBoxes) * 100)
    : 0;

  return createPortal(
    <FocusTrap active={!manualOpen && !unidentifiedOpen && !shortfallMissing && !wrongRoute}>
      <div
        className="modal-overlay trip-scanner-overlay"
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="trip-scanner-modal" onClick={(e) => e.stopPropagation()}>
          {/* Header */}
          <div className="trip-scanner-header">
            <div className="trip-scanner-heading">
              <h2 id={titleId} className="trip-scanner-title">
                {isDeliveryMode ? (
                  <>
                    <Truck size={20} className="trip-scanner-title-icon" aria-hidden="true" />
                    Trip Delivery & Unloading Scanner
                  </>
                ) : (
                  <>
                    <ShieldCheck size={20} className="trip-scanner-title-icon" aria-hidden="true" />
                    Trip Cargo Loading Scanner
                  </>
                )}
              </h2>
              <div className="trip-scanner-meta">
                <span className="trip-scanner-meta-item">
                  Trip: <strong>{trip.trip_number}</strong>
                </span>
                <span className="trip-scanner-meta-item">
                  {trip.origin} ➔ {trip.destination}
                </span>
              </div>
            </div>

            <div className="trip-scanner-controls">
              {hasTorch && (
                <button
                  type="button"
                  className={`btn-icon btn-ghost trip-scanner-control-btn ${torchOn ? 'text-primary' : ''}`}
                  onClick={toggleTorch}
                  title={torchOn ? 'Turn off flashlight' : 'Turn on flashlight'}
                  aria-label="Toggle flashlight"
                >
                  {torchOn ? <Zap size={18} /> : <ZapOff size={18} />}
                </button>
              )}

              <button
                type="button"
                className={`btn-icon btn-ghost trip-scanner-control-btn ${muted ? 'text-tertiary' : 'text-primary'}`}
                onClick={toggleMute}
                title={muted ? 'Unmute beeps' : 'Mute beeps'}
                aria-label="Toggle sound feedback"
              >
                {muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
              </button>

              <button
                type="button"
                className="btn-icon btn-ghost trip-scanner-control-btn"
                onClick={onClose}
                title="Close scanner"
                aria-label="Close scanner"
              >
                <X size={20} />
              </button>
            </div>
          </div>

          {/* Progress Tracker Card */}
          <div className="trip-scanner-progress-card">
            <div className="trip-scanner-progress-stats">
              <span className="trip-scanner-progress-count" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Package size={15} className="text-secondary" aria-hidden="true" />
                <span>{totalScannedBoxes} of {totalTripBoxes} Packages Verified{totalHeldBoxes > 0 ? ' (' + totalHeldBoxes + ' held)' : ''}</span>
              </span>
              <span className="trip-scanner-progress-pct">{completionPercent}%</span>
            </div>
            <div
              className="trip-scanner-progress-track"
              role="progressbar"
              aria-valuenow={totalScannedBoxes}
              aria-valuemin={0}
              aria-valuemax={totalTripBoxes}
            >
              <div className="trip-scanner-progress-fill" style={{ width: `${completionPercent}%` }} />
            </div>

            {allCargoVerified && (
              <div className="trip-scanner-complete-banner">
                <CheckCircle size={16} className="trip-scanner-complete-icon" aria-hidden="true" />
                <span>
                  All cargo verified! Van is ready for {isDeliveryMode ? 'delivery completion' : 'departure'}.
                </span>
              </div>
            )}
            {!allCargoVerified && allCargoAccountedFor && (
              <div className="trip-scanner-complete-banner">
                <Flag size={16} className="trip-scanner-complete-icon" aria-hidden="true" />
                <span>
                  {totalHeldBoxes} box{totalHeldBoxes === 1 ? '' : 'es'} held with supervisor approval. Van is ready for departure.
                </span>
              </div>
            )}
          </div>

          {(!online || pendingCount > 0) && (
            <div className="trip-scanner-notice trip-scanner-notice-warning" role="status">
              <CloudOff size={15} className="trip-scanner-notice-icon" aria-hidden="true" />
              <span>
                {!online ? 'Offline. ' : ''}
                {pendingCount > 0
                  ? pendingCount + ' scan' + (pendingCount === 1 ? '' : 's') + ' saved on this device and waiting to sync.'
                  : 'Scans will be saved on this device and synced automatically.'}
              </span>
              {pendingCount > 0 && online && (
                <button type="button" className="trip-scanner-manual-box-btn trip-scanner-sync-btn" onClick={syncNow}>
                  <RefreshCw size={11} className="inline mr-4" aria-hidden="true" /> Sync now
                </button>
              )}
            </div>
          )}

          {/* Camera Viewfinder */}
          <div className="trip-scanner-camera-section">
            <div className="trip-scanner-viewfinder">
              <div className={`trip-scanner-viewfinder-inner ${pulseState}`}>
                <video
                  ref={videoRef}
                  className="trip-scanner-video"
                  playsInline
                  muted
                  autoPlay
                  aria-hidden="true"
                />

                {cameraState === 'live' && !busy && (
                  <div className="trip-scanner-frame" aria-hidden="true">
                    <span className="trip-scanner-corner trip-scanner-corner-tl" />
                    <span className="trip-scanner-corner trip-scanner-corner-tr" />
                    <span className="trip-scanner-corner trip-scanner-corner-bl" />
                    <span className="trip-scanner-corner trip-scanner-corner-br" />
                    <span className="trip-scanner-line" />
                  </div>
                )}

                {cameraState === 'starting' && (
                  <div className="qr-scanner-state">
                    <Loader size={26} className="animate-spin" aria-hidden="true" />
                    <span className="qr-scanner-state-text">Starting camera…</span>
                  </div>
                )}

                {busy && (
                  <div className="qr-scanner-state">
                    <Loader size={26} className="animate-spin" aria-hidden="true" />
                    <span className="qr-scanner-state-text">Verifying cargo box…</span>
                  </div>
                )}

                {cameraState === 'error' && cameraError && (
                  <div className="qr-scanner-state qr-scanner-state-error">
                    <CameraOff size={28} aria-hidden="true" />
                    <span className="qr-scanner-state-title">{cameraError.title}</span>
                    <span className="qr-scanner-state-text">{cameraError.message}</span>
                    <button
                      type="button"
                      className="btn btn-sm qr-scanner-retry mt-8"
                      onClick={() => setAttempt((n) => n + 1)}
                    >
                      <RotateCcw size={14} className="inline mr-4" /> Try again
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Live Notice Banner */}
          {notice && (
            <div className={`trip-scanner-notice trip-scanner-notice-${noticeTone}`} role="status">
              {noticeTone === 'success' && <CheckCircle size={15} className="trip-scanner-notice-icon" aria-hidden="true" />}
              {noticeTone === 'danger' && <AlertTriangle size={15} className="trip-scanner-notice-icon" aria-hidden="true" />}
              {noticeTone === 'warning' && <AlertTriangle size={15} className="trip-scanner-notice-icon" aria-hidden="true" />}
              {noticeTone === 'info' && <Package size={15} className="trip-scanner-notice-icon" aria-hidden="true" />}
              <span>{notice}</span>
            </div>
          )}

          {/* Manifest Live Checklist */}
          <div className="trip-scanner-manifest">
            <div className="trip-scanner-manifest-header">
              <div className="trip-scanner-manifest-heading">
                <h3 className="trip-scanner-manifest-title">
                  Trip Manifest
                  <span className="trip-scanner-manifest-count">{filteredOrders.length}</span>
                </h3>
                <span className="trip-scanner-manifest-subtitle">
                  Scan QR or tap damaged boxes to verify
                </span>
              </div>

              <div className="trip-scanner-tabs">
                <button
                  type="button"
                  className={`trip-scanner-tab-btn ${filterTab === 'all' ? 'is-active' : ''}`}
                  onClick={() => setFilterTab('all')}
                >
                  All ({orders.length})
                </button>
                <button
                  type="button"
                  className={`trip-scanner-tab-btn ${filterTab === 'pending' ? 'is-active' : ''}`}
                  onClick={() => setFilterTab('pending')}
                >
                  Pending ({orders.filter(o => {
                    const q = o.package_quantity || 1;
                    return (o.verified_boxes || []).filter(b => b <= q).length < q;
                  }).length})
                </button>
                <button
                  type="button"
                  className={`trip-scanner-tab-btn ${filterTab === 'verified' ? 'is-active' : ''}`}
                  onClick={() => setFilterTab('verified')}
                >
                  Verified ({orders.filter(o => {
                    const q = o.package_quantity || 1;
                    return (o.verified_boxes || []).filter(b => b <= q).length === q;
                  }).length})
                </button>
              </div>
            </div>

            {/* Search filter */}
            <div className="trip-scanner-search-wrap">
              <Search size={15} className="trip-scanner-search-icon" aria-hidden="true" />
              <input
                type="search"
                className="trip-scanner-search-input"
                placeholder="Search by tracking number, customer, or city…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                aria-label="Filter assigned cargo checklist"
              />
            </div>

            {/* Card list */}
            <div className="trip-scanner-list" role="list">
              {filteredOrders.length === 0 ? (
                <div className="text-center py-16 text-secondary text-sm">
                  No matching cargo found.
                </div>
              ) : (
                filteredOrders.map((o) => {
                  const qty = o.package_quantity || 1;
                  const verified = o.verified_boxes || [];
                  const verifiedCount = verified.filter((b) => b <= qty).length;
                  const isComplete = verifiedCount === qty;
                  const heldCount = Array.from({ length: qty }, (_, idx) => idx + 1)
                    .filter((b) => !verified.includes(b) && heldKeys.has(o.id + ':' + b)).length;
                  const isReleased = !isComplete && verifiedCount + heldCount === qty;
                  const isJustScanned = o.id === lastScannedOrderId;
                  const receiver = orderPartyName(o, 'receiver') || 'Receiver';
                  const destination = [o.receiver_city, o.receiver_province].filter(Boolean).join(', ') || 'No destination set';
                  const nextBoxToVerify = Array.from({ length: qty }, (_, idx) => idx + 1).find((b) => !verified.includes(b) && !heldKeys.has(o.id + ':' + b));
                  const progressPct = Math.round((verifiedCount / qty) * 100);

                  return (
                    <div
                      key={o.id}
                      className={`trip-scanner-card ${isComplete ? 'is-complete' : ''} ${isJustScanned ? 'is-just-scanned' : ''}`}
                      role="listitem"
                    >
                      <div className="trip-scanner-card-head">
                        <div className="trip-scanner-card-id-block">
                          <span className="trip-scanner-tracking">{o.tracking_number}</span>
                          <span className="trip-scanner-receiver-name">{receiver}</span>
                        </div>
                        <span className={`trip-scanner-status-pill ${isComplete ? 'is-complete' : 'is-pending'}`}>
                          {isComplete ? 'Completed' : isReleased ? 'Held' : 'Pending'}
                        </span>
                      </div>

                      <div className="trip-scanner-card-dest">
                        <MapPin size={11} className="trip-scanner-dest-icon" aria-hidden="true" />
                        <span>{destination}</span>
                      </div>

                      {/* Box Counting & Progress Row */}
                      <div className="trip-scanner-counter-row">
                        <div className="trip-scanner-count-group">
                          <span className="trip-scanner-count-label">Boxes:</span>
                          <span className="trip-scanner-count-val">{verifiedCount}/{qty}</span>
                        </div>

                        <div className="trip-scanner-mini-bar-wrap">
                          <div
                            className="trip-scanner-mini-bar"
                            role="progressbar"
                            aria-valuenow={verifiedCount}
                            aria-valuemin={0}
                            aria-valuemax={qty}
                          >
                            <div className="trip-scanner-mini-bar-fill" style={{ width: `${progressPct}%` }} />
                          </div>
                          <span className="trip-scanner-mini-pct">{progressPct}%</span>
                        </div>

                        {!isComplete && !isReleased && nextBoxToVerify && (
                          <button
                            type="button"
                            className="trip-scanner-manual-box-btn"
                            onClick={() => handleManualVerifyBox(o, nextBoxToVerify)}
                            disabled={busy}
                            title={`Manually verify Box ${nextBoxToVerify} if label is unreadable`}
                          >
                            + Verify Box {nextBoxToVerify}
                          </button>
                        )}
                      </div>

                      {/* POD button if all boxes scanned during delivery phase */}
                      {isDeliveryMode && isComplete && o.status !== ORDER_STATUS.DELIVERED && (
                        <div className="trip-scanner-pod-action">
                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            onClick={() => handleOpenDelivery(o)}
                          >
                            <Camera size={14} className="inline mr-4" /> Complete Proof of Delivery
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Field fallbacks */}
          <div className="trip-scanner-fallbacks">
            <button
              type="button"
              className="btn btn-outline btn-sm"
              onClick={() => setManualOpen(true)}
              disabled={busy}
            >
              <Keyboard size={14} className="inline mr-4" aria-hidden="true" /> Can&apos;t Scan QR?
            </button>
            <button
              type="button"
              className="btn btn-outline btn-sm"
              onClick={() => setUnidentifiedOpen(true)}
              disabled={busy}
            >
              <AlertTriangle size={14} className="inline mr-4" aria-hidden="true" /> Damaged / Unidentified Label
            </button>
            {!isDeliveryMode && (
              <button
                type="button"
                className="btn btn-primary btn-sm trip-scanner-finish-btn"
                onClick={handleFinishLoading}
                disabled={busy}
              >
                <Flag size={14} className="inline mr-4" aria-hidden="true" /> Finish Loading
              </button>
            )}
          </div>

          {manualOpen && (
            <ManualBoxMatchOverlay
              orders={eligibleOrders}
              heldKeys={heldKeys}
              busy={busy}
              onConfirm={handleManualMatchConfirm}
              onNotInManifest={handleManualNotInManifest}
              onClose={() => setManualOpen(false)}
            />
          )}

          {unidentifiedOpen && (
            <UnidentifiedBoxModal
              orders={orders}
              heldKeys={heldKeys}
              isDeliveryMode={isDeliveryMode}
              onMatch={handleUnidentifiedMatch}
              onClose={() => setUnidentifiedOpen(false)}
            />
          )}

          {shortfallMissing && (
            <ShortfallModal
              tripNumber={trip.trip_number}
              missing={shortfallMissing}
              onSubmit={handleShortfallSubmit}
              onClose={() => setShortfallMissing(null)}
            />
          )}

          {wrongRoute && createPortal(
            <div className="trip-scanner-block" role="alertdialog" aria-modal="true" aria-labelledby={titleId + '-wrong'}>
              <Ban size={56} aria-hidden="true" />
              <h2 id={titleId + '-wrong'} className="trip-scanner-block-title">Wrong Route</h2>
              <p className="trip-scanner-block-text">
                {wrongRoute.tripNumber
                  ? <>This box belongs to <strong>Trip {wrongRoute.tripNumber}</strong>.</>
                  : <>{wrongRoute.label} is not assigned to any trip.</>}
                {' '}Do not load it on this van.
              </p>
              <p className="trip-scanner-block-ref">{wrongRoute.label}</p>
              <button type="button" className="btn btn-lg trip-scanner-block-btn" onClick={dismissWrongRoute} autoFocus>
                Set it aside
              </button>
            </div>,
            document.body,
          )}
        </div>
      </div>
    </FocusTrap>,
    document.body
  );
};

export default TripScannerModal;
