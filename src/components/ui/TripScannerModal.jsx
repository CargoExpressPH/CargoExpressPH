import { useState, useRef, useEffect, useCallback, useId, useMemo } from 'react';
import { createPortal } from 'react-dom';
import {
  X, CameraOff, RotateCcw, ImagePlus, Loader, CheckCircle, AlertTriangle,
  Package, Search, Volume2, VolumeX, Zap, ZapOff, Check, ArrowRight,
  Truck, ShieldCheck, CheckSquare, Sparkles
} from 'lucide-react';
import FocusTrap from './FocusTrap';
import useScrollLock from '../../hooks/useScrollLock';
import { useToast } from '../../hooks/useToast';
import { parseScanPayload, normalizeTrackingNumber } from '../../utils/scanPayload';
import { recordBoxVerification, recordDeliveryPayment } from '../../lib/database';
import { orderPartyName } from '../../lib/orderParties';
import { logOrder } from '../../lib/activityLog';
import { ORDER_STATUS } from '../../constants/status';
import DeliveryModal from './DeliveryModal';
import {
  playScanSuccessSound,
  playScanErrorSound,
  playScanDuplicateSound,
  playScanCompleteSound,
  setScanAudioMuted,
  isScanAudioMuted,
} from '../../utils/scanAudio';

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

  const isDeliveryMode = trip.status === 'in_progress' || trip.status === 'arrived';

  // Scanner state
  const videoRef = useRef(null);
  const fileInputRef = useRef(null);
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
  const [manualCode, setManualCode] = useState('');

  // Proof of delivery in-place modal
  const [podOrder, setPodOrder] = useState(null);
  const [podOpen, setPodOpen] = useState(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

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

  const allCargoVerified = totalTripBoxes > 0 && totalScannedBoxes === totalTripBoxes;

  // Flash visual feedback
  const triggerPulse = (type) => {
    setPulseState(type);
    setTimeout(() => {
      if (mountedRef.current) setPulseState('');
    }, 600);
  };

  // ── Core QR Scan Handler ─────────────────────────────────────────────────
  const handleScan = useCallback(async (text) => {
    if (resolvingRef.current || busy) return;

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
      setNotice('⚠️ Scanned a GCash payment QR, not a package barcode label.');
      return;
    }

    if (payload.kind === 'unknown') {
      playScanErrorSound();
      triggerPulse('is-error-pulse');
      setNoticeTone('danger');
      setNotice('⚠️ QR code is not recognized as a CargoExpress package label.');
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

    // ── Foreign Cargo Check ──
    if (!targetOrder) {
      playScanErrorSound();
      triggerPulse('is-error-pulse');
      setNoticeTone('danger');
      const identifier = payload.trackingNumber || 'This package';
      setNotice(`🛑 Warning: ${identifier} is NOT assigned to Trip ${trip.trip_number}! Do not load.`);
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
      setNotice(`⚠️ Box ${boxNumber} is outside the booking limit (${packageQty} boxes total).`);
      return;
    }

    const currentVerified = targetOrder.verified_boxes || [];
    const alreadyVerified = currentVerified.includes(boxNumber);

    if (alreadyVerified) {
      playScanDuplicateSound();
      setNoticeTone('warning');
      setLastScannedOrderId(targetOrder.id);
      setNotice(`ℹ️ Box ${boxNumber} of ${packageQty} for ${targetOrder.tracking_number} is already verified.`);
      return;
    }

    // ── Execute verification ──
    resolvingRef.current = true;
    setBusy(true);

    try {
      const updatedVerifiedList = await recordBoxVerification(targetOrder.id, boxNumber);
      if (!mountedRef.current) return;

      const newVerified = Array.isArray(updatedVerifiedList)
        ? updatedVerifiedList
        : [...currentVerified, boxNumber];

      // Optimistically update local orders list
      const nextOrders = currentOrders.map((o) => {
        if (o.id === targetOrder.id) {
          return { ...o, verified_boxes: newVerified };
        }
        return o;
      });

      setOrders(nextOrders);
      ordersRef.current = nextOrders;
      onOrdersUpdate?.(nextOrders);

      setLastScannedOrderId(targetOrder.id);
      triggerPulse('is-success-pulse');

      logOrder('Cargo Box Verified via Trip Scanner', targetOrder.id, targetOrder.tracking_number, {
        tripNumber: trip.trip_number,
        box: boxNumber,
        totalBoxes: packageQty,
        details: `Verified box ${boxNumber} of ${packageQty} in trip ${trip.trip_number}.`,
      });

      // Check if all boxes for the entire trip are verified
      const newTotalScanned = nextOrders
        .filter((o) => !['Cancelled', 'Pending Cancellation', 'Pending', 'Assigned'].includes(o.status))
        .reduce((sum, o) => {
          const qty = o.package_quantity || 1;
          return sum + (o.verified_boxes || []).filter((b) => b <= qty).length;
        }, 0);

      const receiver = orderPartyName(targetOrder, 'receiver') || 'Receiver';

      if (newTotalScanned >= totalTripBoxes && totalTripBoxes > 0) {
        playScanCompleteSound();
        setNoticeTone('success');
        setNotice(`🎉 All ${totalTripBoxes} trip boxes verified! Van is ready for departure.`);
      } else {
        playScanSuccessSound();
        setNoticeTone('success');
        setNotice(`✓ Verified: Box ${boxNumber}/${packageQty} for ${targetOrder.tracking_number} (${receiver})`);
      }
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
  }, [busy, onOrdersUpdate, totalTripBoxes, trip.trip_number]);

  // Keep ref up to date
  const handleScanRef = useRef(handleScan);
  handleScanRef.current = handleScan;

  // ── Manual Box Click Verify (e.g. damaged sticker) ───────────────────────
  const handleManualVerifyBox = async (order, boxNum) => {
    if ((order.verified_boxes || []).includes(boxNum) || busy) return;
    setBusy(true);
    try {
      const updatedVerifiedList = await recordBoxVerification(order.id, boxNum);
      const newVerified = Array.isArray(updatedVerifiedList)
        ? updatedVerifiedList
        : [...(order.verified_boxes || []), boxNum];

      const nextOrders = ordersRef.current.map((o) => (
        o.id === order.id ? { ...o, verified_boxes: newVerified } : o
      ));

      setOrders(nextOrders);
      ordersRef.current = nextOrders;
      onOrdersUpdate?.(nextOrders);

      setLastScannedOrderId(order.id);
      playScanSuccessSound();
      setNoticeTone('success');
      setNotice(`✓ Manually verified: Box ${boxNum} of ${order.tracking_number}`);
    } catch (e) {
      playScanErrorSound();
      toast.error(e.message || 'Failed to verify box');
    } finally {
      setBusy(false);
    }
  };

  // ── Manual Input Form ────────────────────────────────────────────────────
  const handleManualSubmit = (e) => {
    e.preventDefault();
    const clean = manualCode.trim();
    if (!clean) return;
    setManualCode('');
    void handleScan(clean);
  };

  // ── Photo Upload Scan ────────────────────────────────────────────────────
  const handlePhotoScan = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file || resolvingRef.current) return;

    resolvingRef.current = true;
    setBusy(true);
    setNoticeTone('info');
    setNotice('Reading photo barcode…');

    let loaded = null;
    let text = null;
    try {
      loaded = await loadImage(file);
      const decode = await getDecoder();
      text = await decode(loaded.img, { photo: true });
    } catch {
      text = null;
    } finally {
      if (loaded) URL.revokeObjectURL(loaded.url);
      resolvingRef.current = false;
      setBusy(false);
    }

    if (!mountedRef.current) return;

    if (!text) {
      playScanErrorSound();
      setNoticeTone('warning');
      setNotice('Could not find a clear QR code in that photo. Try again with good lighting.');
      return;
    }

    lastScanRef.current = { text: '', at: 0 };
    await handleScan(text);
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

  // Escape key closes modal
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'Escape' && !podOpen) onClose();
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
    <FocusTrap active>
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
              <span className="trip-scanner-progress-count">
                📦 {totalScannedBoxes} of {totalTripBoxes} Boxes Verified
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
          </div>

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

            {/* Quick camera actions */}
            <div className="trip-scanner-camera-actions">
              <button
                type="button"
                className="btn btn-outline btn-sm trip-scanner-camera-btn"
                onClick={() => fileInputRef.current && fileInputRef.current.click()}
                disabled={busy}
              >
                <ImagePlus size={14} className="inline mr-4" /> Scan Photo
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                className="qr-scanner-file-input"
                onChange={handlePhotoScan}
                tabIndex={-1}
                aria-label="Upload label photo"
              />
            </div>
          </div>

          {/* Live Notice Banner */}
          {notice && (
            <div className={`trip-scanner-notice trip-scanner-notice-${noticeTone}`} role="status">
              {notice}
            </div>
          )}

          {/* Manifest Live Checklist */}
          <div className="trip-scanner-manifest">
            <div className="trip-scanner-manifest-header">
              <h3 className="trip-scanner-manifest-title">
                <CheckSquare size={17} aria-hidden="true" />
                Assigned Cargo Checklist ({filteredOrders.length})
              </h3>

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
                  Completed ({orders.filter(o => {
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
                  const isComplete = verified.filter((b) => b <= qty).length === qty;
                  const isJustScanned = o.id === lastScannedOrderId;
                  const receiver = orderPartyName(o, 'receiver') || 'Receiver';

                  return (
                    <div
                      key={o.id}
                      className={`trip-scanner-card ${isComplete ? 'is-complete' : ''} ${isJustScanned ? 'is-just-scanned' : ''}`}
                      role="listitem"
                    >
                      <div className="trip-scanner-card-head">
                        <span className="trip-scanner-tracking">{o.tracking_number}</span>
                        {isComplete ? (
                          <span className="badge badge-success text-xs" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            <CheckCircle size={11} /> All Scanned ({qty}/{qty})
                          </span>
                        ) : (
                          <span className="badge badge-warning text-xs">
                            {verified.length}/{qty} Scanned
                          </span>
                        )}
                      </div>

                      <div className="trip-scanner-card-meta">
                        <span>👤 {receiver}</span>
                        <span>📍 {[o.receiver_city, o.receiver_province].filter(Boolean).join(', ') || '—'}</span>
                      </div>

                      {/* Box Pills */}
                      <div className="trip-scanner-box-pills">
                        {Array.from({ length: qty }, (_, idx) => {
                          const boxNum = idx + 1;
                          const isBoxDone = verified.includes(boxNum);
                          return (
                            <button
                              key={boxNum}
                              type="button"
                              className={`trip-scanner-box-pill ${isBoxDone ? 'is-verified' : 'is-unverified'}`}
                              onClick={() => !isBoxDone && handleManualVerifyBox(o, boxNum)}
                              disabled={isBoxDone || busy}
                              title={isBoxDone ? `Box ${boxNum} verified` : `Click to manually verify Box ${boxNum}`}
                            >
                              {isBoxDone ? (
                                <>
                                  <Check size={11} className="trip-scanner-pill-icon" aria-hidden="true" />
                                  Box {boxNum}
                                </>
                              ) : (
                                <>○ Box {boxNum}</>
                              )}
                            </button>
                          );
                        })}
                      </div>

                      {/* POD button if all boxes scanned during delivery phase */}
                      {isDeliveryMode && isComplete && o.status !== ORDER_STATUS.DELIVERED && (
                        <div className="trip-scanner-pod-action">
                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            onClick={() => handleOpenDelivery(o)}
                          >
                            📷 Complete Proof of Delivery
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Manual Barcode Entry Fallback */}
          <div className="trip-scanner-manual-wrap">
            <form className="trip-scanner-manual-form" onSubmit={handleManualSubmit}>
              <input
                type="text"
                className="trip-scanner-manual-input"
                placeholder="Type tracking number (e.g. CE-20261019-1234)…"
                value={manualCode}
                onChange={(e) => setManualCode(e.target.value)}
                aria-label="Manual barcode or tracking number input"
              />
              <button
                type="submit"
                className="btn btn-outline btn-sm trip-scanner-manual-btn"
                disabled={!manualCode.trim() || busy}
              >
                Verify
              </button>
            </form>
          </div>
        </div>
      </div>
    </FocusTrap>,
    document.body
  );
};

export default TripScannerModal;
