import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { CameraOff, Keyboard, Loader, PackageCheck, RotateCcw, X } from 'lucide-react';
import FocusTrap from './FocusTrap';
import useScrollLock from '../../hooks/useScrollLock';
import DeliveryModal from './DeliveryModal';
import ManualBoxMatchOverlay from './ManualBoxMatchOverlay';
import { findOrderIdByTrackingNumber, getOrderById, recordBoxVerification, recordDeliveryPayment } from '../../lib/database';
import { supabase } from '../../lib/supabase';
import { logActivity, logOrder } from '../../lib/activityLog';
import { ORDER_STATUS } from '../../constants/status';
import { ORDER_PARTY_NAME_COLUMNS, orderPartyName } from '../../lib/orderParties';
import { useToast } from '../../hooks/useToast';
import { normalizeTrackingNumber, orderRouteForScan, parseScanPayload } from '../../utils/scanPayload';
import { playScanErrorSound, playScanSuccessSound, playWrongRouteSound } from '../../utils/scanAudio';

/**
 * QrScannerModal — the admin topbar's "Scan package QR" camera.
 *
 * Reads the per-box labels PackageQrLabels.jsx prints and opens that booking
 * in place, so staff never leave the app for the phone's camera app. Loaded on
 * demand by AdminLayout; nothing here ships until the first tap.
 *
 * Decoding: the native BarcodeDetector where it exists (Chrome on Android),
 * otherwise jsQR on downscaled canvas frames. iOS Safari has no
 * BarcodeDetector, so jsQR is the path every iPhone takes.
 *
 * Fallbacks for when the live camera is unavailable (blocked permission, no
 * camera, plain-http dev host, an older iOS home-screen app): decode a photo
 * of the label, or type the tracking number.
 */

const SCAN_INTERVAL_MS = 150;
// A handled code stays in frame while the admin reads the result (or moves to
// the next box); without this the same message would be re-announced on every
// frame.
const SCAN_COOLDOWN_MS = 3000;
const LIVE_MAX_SIDE = 720;
const PHOTO_MAX_SIDES = [1024, 2048];

const SCAN_ORDER_COLUMNS = `id, status, tracking_number, package_quantity, verified_boxes, ${ORDER_PARTY_NAME_COLUMNS}`;

const boxNumbersFor = (quantity) => Array.from({ length: quantity }, (_, i) => i + 1);

/** Box numbers of the active session that have not been verified yet. */
const missingBoxes = (session) => boxNumbersFor(session.packageQuantity)
  .filter((box) => !session.verified.includes(box));

const boxCount = (count) => `${count} box${count === 1 ? '' : 'es'}`;

const cameraErrorFor = (error) => {
  const name = error?.name || '';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
    return {
      title: 'Camera access is blocked',
      message: 'Allow camera access for this site in your browser settings, then try again. You can also scan from a photo or type the tracking number below.',
      retry: true,
    };
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
    return {
      title: 'No camera found',
      message: 'This device has no camera we can use. Scan from a photo or type the tracking number below.',
      retry: false,
    };
  }
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
    return {
      title: 'The camera is busy',
      message: 'Another app may be using the camera. Close it, then try again.',
      retry: true,
    };
  }
  return {
    title: 'The camera could not start',
    message: 'Try again, or scan from a photo or type the tracking number below.',
    retry: true,
  };
};

const UNSUPPORTED_CAMERA = {
  title: 'Live scanning is not available here',
  message: 'This browser cannot open the camera on this page. Scan from a photo or type the tracking number below.',
  retry: false,
};

// Camera requests run one at a time. Closing and reopening quickly (or React
// StrictMode's double mount in dev) would otherwise ask for the camera while
// the previous request is still pending, and some devices never answer the
// second one — the dialog then sits on "Starting camera…" for good.
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

/**
 * Returns `decode(source, { photo })` resolving to the QR text or null.
 * Prefers the native detector; falls back to jsQR, loaded on first use.
 */
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
    } catch { /* fall through to jsQR */ }
  }

  const { default: jsQR } = await import('jsqr');
  return async (source, { photo = false } = {}) => {
    if (!photo) return decodeWithJsQr(jsQR, source, LIVE_MAX_SIDE, 'dontInvert');
    // Phone photos are large and the label may fill only part of the frame,
    // so try a fast pass first and a sharper one before giving up.
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

const QrScannerModal = ({ onClose, initialOrder = null }) => {
  const navigate = useNavigate();
  const titleId = useId();
  const descriptionId = useId();
  const manualInputId = useId();
  const manualErrorId = useId();

  const videoRef = useRef(null);
  const fileInputRef = useRef(null);
  const decoderRef = useRef(null);
  const resolvingRef = useRef(false);
  const lastScanRef = useRef({ text: '', at: 0 });
  const mountedRef = useRef(true);
  const toast = useToast();

  // Live camera: 'starting' → 'live', or 'error' when it cannot be used.
  // `busy` is separate — a lookup, box verification or photo decode can run in
  // any of them.
  const [cameraState, setCameraState] = useState('starting');
  const [busy, setBusy] = useState(false);
  const [cameraError, setCameraError] = useState(null);
  const [notice, setNotice] = useState('');
  const [noticeTone, setNoticeTone] = useState('warning');
  const [attempt, setAttempt] = useState(0);
  const [pageHidden, setPageHidden] = useState(() => typeof document !== 'undefined' && document.hidden);

  // Delivery session: set by initialOrder if passed, or by the first box scan
  // of an Out for Delivery package.
  const [session, setSession] = useState(() => {
    if (initialOrder && (initialOrder.status === ORDER_STATUS.OUT_FOR_DELIVERY || initialOrder.tracking_number)) {
      return {
        orderId: initialOrder.id,
        trackingNumber: initialOrder.tracking_number,
        customerName: orderPartyName(initialOrder, 'receiver'),
        packageQuantity: initialOrder.package_quantity || 1,
        verified: [...(initialOrder.verified_boxes || [])],
        order: initialOrder,
      };
    }
    return null;
  });
  const sessionRef = useRef(session);
  const updateSession = useCallback((next) => {
    sessionRef.current = next;
    setSession(next);
  }, []);

  // Field fallback: Manual Box Match overlay ("Can't Scan QR?")
  const [manualOpen, setManualOpen] = useState(false);
  const [candidateOrders, setCandidateOrders] = useState(() => (initialOrder ? [initialOrder] : []));

  useEffect(() => {
    if (!initialOrder) {
      supabase
        .from('orders')
        .select(`id, status, tracking_number, package_quantity, verified_boxes, receiver_city, receiver_province, actual_weight, ${ORDER_PARTY_NAME_COLUMNS}`)
        .in('status', ['Out for Delivery', 'Picked Up', 'Arrived at Hub'])
        .limit(100)
        .then(({ data }) => {
          if (data && mountedRef.current) setCandidateOrders(data);
        });
    }
  }, [initialOrder]);

  // Proof of delivery runs in place of the camera, so the session survives a
  // cancelled POD and the camera restarts once the delivery is saved.
  const [podOrder, setPodOrder] = useState(null);
  const [podOpen, setPodOpen] = useState(false);

  useScrollLock(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const getDecoder = useCallback(async () => {
    if (!decoderRef.current) decoderRef.current = createDecoder();
    try {
      return await decoderRef.current;
    } catch (error) {
      decoderRef.current = null; // a failed chunk load must not poison later attempts
      throw error;
    }
  }, []);

  const goTo = useCallback((route) => {
    if (navigator.vibrate) {
      try { navigator.vibrate(60); } catch { /* unsupported */ }
    }
    navigate(route);
    onClose();
  }, [navigate, onClose]);

  // Ends one scan: releases the decode lock and shows the result. `tone` picks
  // the notice colour — warnings for anything the admin must act on.
  const settle = useCallback((message, tone) => {
    resolvingRef.current = false;
    if (!mountedRef.current) return;
    setNoticeTone(tone);
    setNotice(message);
    setBusy(false);
  }, []);

  const reject = useCallback((message) => settle(message, 'warning'), [settle]);

  const openTrackingNumber = useCallback(async (trackingNumber) => {
    resolvingRef.current = true;
    setBusy(true);
    setNotice('');
    try {
      const orderId = await findOrderIdByTrackingNumber(trackingNumber);
      if (!mountedRef.current) return;
      if (orderId) {
        goTo(`/admin/orders/${orderId}`);
        return;
      }
      reject(`No booking found for ${trackingNumber}.`);
    } catch {
      reject(`Could not look up ${trackingNumber}. Check your connection and try again.`);
    }
  }, [goTo, reject]);

  // Starts a delivery session on the first box of an Out for Delivery package.
  // Only the first scan of a package is logged as "initiated", as before.
  const startSession = useCallback((order) => {
    logActivity({
      module: 'Deliveries',
      action: 'Delivery initiated via QR scan',
      recordType: 'order',
      recordId: order.id,
      recordRef: order.tracking_number || null,
      details: `Scanned package ${order.tracking_number || order.id}, opening delivery flow.`,
    });
    const next = {
      orderId: order.id,
      trackingNumber: order.tracking_number,
      customerName: orderPartyName(order, 'receiver'),
      packageQuantity: order.package_quantity || 1,
      verified: [...(order.verified_boxes || [])],
    };
    updateSession(next);
    return next;
  }, [updateSession]);

  /**
   * Acts on decoded QR text. Label scans of Out for Delivery packages are
   * counted against the active delivery session, so the camera stays on one
   * screen and no page is navigated. Everything else opens the booking as before.
   */
  const handleScan = useCallback(async (text) => {
    if (resolvingRef.current) return;
    const last = lastScanRef.current;
    if (text === last.text && Date.now() - last.at < SCAN_COOLDOWN_MS) return;
    lastScanRef.current = { text, at: Date.now() };

    const payload = parseScanPayload(text);
    if (payload.kind === 'payment') {
      reject('That is a GCash payment QR, not a package label.');
      return;
    }
    if (payload.kind === 'unknown') {
      reject('This QR code is not a CargoExpress package label.');
      return;
    }
    if (payload.kind === 'tracking' && !sessionRef.current) {
      await openTrackingNumber(payload.trackingNumber);
      return;
    }

    resolvingRef.current = true;
    setBusy(true);
    setNotice('');
    try {
      const orderId = payload.kind === 'order'
        ? payload.orderId
        : await findOrderIdByTrackingNumber(payload.trackingNumber);
      if (!mountedRef.current) return;
      if (!orderId) {
        reject(`No booking found for ${payload.trackingNumber}.`);
        return;
      }

      const { data: order, error } = await supabase
        .from('orders')
        .select(SCAN_ORDER_COLUMNS)
        .eq('id', orderId)
        .single();
      if (!mountedRef.current) return;
      if (error || !order) {
        // No session and the lookup failed: open the plain order page, which is
        // what a scan did before deliveries had a session.
        if (!sessionRef.current && payload.kind === 'order') {
          goTo(orderRouteForScan(payload));
          return;
        }
        reject('Could not look up this package. Check your connection and try again.');
        return;
      }

      let active = sessionRef.current;
      if (!active) {
        if (order.status !== ORDER_STATUS.OUT_FOR_DELIVERY) {
          // If this is a specific box scan on a Picked Up order (loading onto a trip),
          // verify the box in-place so the operator can keep scanning smoothly without full page reload.
          if (payload.box && order.status === ORDER_STATUS.PICKED_UP) {
            const currentVerified = order.verified_boxes || [];
            if (currentVerified.includes(payload.box)) {
              settle(`Box ${payload.box} of ${order.package_quantity || 1} is already verified for ${order.tracking_number}.`, 'info');
              return;
            }
            await recordBoxVerification(order.id, payload.box);
            logActivity({
              module: 'Deliveries',
              action: 'Package box verified via QR scan',
              recordType: 'order',
              recordId: order.id,
              recordRef: order.tracking_number || null,
              details: `Box ${payload.box} of ${order.package_quantity || 1} verified.`,
            });
            settle(`✓ Box ${payload.box} of ${order.package_quantity || 1} verified for ${order.tracking_number}! Continue scanning next box.`, 'success');
            return;
          }

          goTo(orderRouteForScan(payload));
          return;
        }
        active = startSession(order);
      }

      // A different package never resets the session; the admin keeps scanning
      // the current one.
      if (order.id !== active.orderId) {
        const customer = orderPartyName(order, 'receiver') || 'another customer';
        const message = `Wrong package: ${order.tracking_number} belongs to ${customer}. Still scanning ${active.trackingNumber} (${active.customerName}).`;
        // Same hard-block cue as the trip scanner: a different box at this stop must be unmistakable.
        playWrongRouteSound();
        toast.warning(`Wrong package: ${order.tracking_number} belongs to ${customer}.`);
        reject(message);
        return;
      }

      if (order.status !== ORDER_STATUS.OUT_FOR_DELIVERY) {
        reject(`This package is no longer Out for Delivery (now "${order.status}").`);
        return;
      }
      if (payload.kind !== 'order') {
        reject('Scan the QR label on a box to count it. A tracking number does not identify a box.');
        return;
      }
      const box = payload.box;
      if (!box) {
        reject('This label has no box number. Scan the label printed on the box itself.');
        return;
      }
      if (box > active.packageQuantity) {
        reject(`Box ${box} does not belong to this booking. It has ${boxCount(active.packageQuantity)}.`);
        return;
      }
      if (active.verified.includes(box)) {
        reject(`Box ${box} of ${active.packageQuantity} is already scanned for ${active.trackingNumber}. Scan the next box.`);
        return;
      }

      // Each box is recorded on its own. The RPC is idempotent and returns the
      // full verified set, which becomes the session's source of truth.
      const verifiedBoxes = await recordBoxVerification(order.id, box);
      if (!mountedRef.current) return;
      const next = {
        ...active,
        verified: Array.isArray(verifiedBoxes) ? verifiedBoxes : [...active.verified, box],
      };
      updateSession(next);
      logActivity({
        module: 'Deliveries',
        action: 'Package box verified via QR scan',
        recordType: 'order',
        recordId: order.id,
        recordRef: order.tracking_number || null,
        details: `Box ${box} of ${active.packageQuantity} verified.`,
      });

      const remaining = missingBoxes(next);
      settle(
        remaining.length
          ? `Box ${box} verified. ${boxCount(remaining.length)} left.`
          : 'All boxes scanned. Proceed to proof of delivery.',
        'success',
      );
    } catch (error) {
      if (!mountedRef.current) return;
      reject(error?.message || 'Could not verify this box. Check your connection and try again.');
    }
  }, [goTo, openTrackingNumber, reject, settle, startSession, toast, updateSession]);

  // Opens proof of delivery for a complete session. The order is re-read first,
  // so the boxes checked here are the ones the server has recorded.
  const openPod = async () => {
    const active = sessionRef.current;
    if (!active || busy) return;
    resolvingRef.current = true;
    setBusy(true);
    setNotice('');
    try {
      const full = await getOrderById(active.orderId);
      if (!mountedRef.current) return;
      const next = { ...active, verified: [...(full.verified_boxes || [])] };
      updateSession(next);
      const remaining = missingBoxes(next);
      if (remaining.length > 0) {
        reject(`Scan the remaining boxes first: ${remaining.map((box) => `Box ${box}`).join(', ')}.`);
        return;
      }
      if (full.status !== ORDER_STATUS.OUT_FOR_DELIVERY) {
        reject(`This package is no longer Out for Delivery (now "${full.status}").`);
        return;
      }
      setPodOrder(full);
      setPodOpen(true);
      settle('', 'success');
    } catch {
      reject('Could not load this booking for proof of delivery. Check your connection and try again.');
    }
  };

  const closePod = useCallback(() => {
    setPodOpen(false);
    setPodOrder(null);
  }, []);

  // Saves the proof of delivery with the same RPC the order page uses, then
  // clears the session. Closing the POD clears the session, so the scanner
  // is ready for the next parcel without a page change.
  const handleDeliverySubmit = async (payload) => {
    if (!podOrder) return;
    await recordDeliveryPayment(podOrder.id, payload);
    logOrder('Delivery Proof Uploaded', podOrder.id, podOrder.tracking_number, {
      details: `Delivery processed. Photos uploaded: ${payload.delivery_photos.length}`,
    });
    toast.success(`Delivered ${podOrder.tracking_number}.`);
    lastScanRef.current = { text: '', at: 0 };
    resolvingRef.current = false;
    setBusy(false);
    setNotice('');
    setPodOpen(false);
    setPodOrder(null);
    updateSession(null);
    onClose?.();
  };

  const handleManualMatchConfirm = async (order, box) => {
    try {
      setBusy(true);
      const verifiedBoxes = await recordBoxVerification(order.id, box);
      logActivity({
        module: 'Deliveries',
        action: 'Package box verified via manual match',
        recordType: 'order',
        recordId: order.id,
        recordRef: order.tracking_number || null,
        details: `Box ${box} of ${order.package_quantity || 1} verified via manual match.`,
      });
      logOrder('Box Verified (Manual Match)', order.id, order.tracking_number, {
        details: `Box ${box} of ${order.package_quantity || 1} manually verified (unreadable QR fallback).`,
      });

      const nextVerified = Array.isArray(verifiedBoxes)
        ? verifiedBoxes
        : [...(session?.verified || order.verified_boxes || []), box];

      const updatedOrder = {
        ...order,
        verified_boxes: nextVerified,
      };

      const nextSession = {
        orderId: order.id,
        trackingNumber: order.tracking_number,
        customerName: orderPartyName(order, 'receiver'),
        packageQuantity: order.package_quantity || 1,
        verified: nextVerified,
        order: updatedOrder,
      };
      updateSession(nextSession);
      setManualOpen(false);

      const rem = boxNumbersFor(nextSession.packageQuantity).filter((b) => !nextVerified.includes(b));
      settle(
        rem.length
          ? `Box ${box} verified. ${boxCount(rem.length)} left.`
          : 'All boxes verified. Proceed to proof of delivery.',
        'success',
      );
      playScanSuccessSound();
      toast.success(`Box ${box} of ${nextSession.packageQuantity} verified!`);
    } catch (err) {
      playScanErrorSound();
      toast.error(err?.message || 'Could not verify box.');
      reject(err?.message || 'Could not verify box.');
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  // The decode loop reads the latest handler through a ref, so a new parent
  // render (e.g. an unread-count update in the topbar) never restarts the
  // camera.
  const handleScanRef = useRef(handleScan);
  useEffect(() => { handleScanRef.current = handleScan; }, [handleScan]);

  // ── Pause the camera while the app is in the background ──────────────────
  // Keeping the stream open there drains the battery, and iOS freezes the
  // video anyway; coming back restarts it cleanly.
  useEffect(() => {
    const onVisibility = () => setPageHidden(document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // ── Live camera + decode loop ────────────────────────────────────────────
  useEffect(() => {
    // Off while the proof of delivery is open: its photos and payment do not
    // need the camera, and the stream is released until the POD closes.
    if (pageHidden || podOpen) return undefined;

    let cancelled = false;
    let stream = null;
    let rafId = 0;
    let lastScanAt = 0;
    let decoding = false;
    const video = videoRef.current;

    const fail = (err) => {
      if (cancelled) return;
      setCameraError(err);
      setCameraState('error');
    };

    const loop = (decode) => {
      const tick = () => {
        if (cancelled) return;
        const now = performance.now();
        if (!decoding && !resolvingRef.current && video && video.readyState >= 2 && now - lastScanAt >= SCAN_INTERVAL_MS) {
          lastScanAt = now;
          decoding = true;
          Promise.resolve()
            .then(() => decode(video))
            .then((text) => { if (text && !cancelled) return handleScanRef.current(text); return undefined; })
            .catch(() => { /* a dropped frame is not an error */ })
            .then(() => { decoding = false; });
        }
        rafId = requestAnimationFrame(tick);
      };
      rafId = requestAnimationFrame(tick);
    };

    const start = async () => {
      setCameraState('starting');
      setCameraError(null);

      if (!window.isSecureContext || !navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
        fail(UNSUPPORTED_CAMERA);
        return;
      }

      // The queued job resolves only once a cancelled request's stream has
      // been stopped, so the next request starts against a free camera.
      const request = cameraQueue.then(async () => {
        if (cancelled) return null;
        const acquired = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        });
        // Closed (or backgrounded) while the permission prompt was up.
        if (cancelled || !video) {
          stopStream(acquired);
          return null;
        }
        return acquired;
      });
      cameraQueue = request.catch(() => null);

      try {
        stream = await request;
      } catch (error) {
        fail(cameraErrorFor(error));
        return;
      }
      if (!stream) return;
      if (cancelled) {
        // Cleanup ran before this continuation and saw no stream to stop.
        stopStream(stream);
        return;
      }

      stream.getVideoTracks().forEach((track) => {
        track.addEventListener('ended', () => {
          fail({
            title: 'The camera stopped',
            message: 'The camera was turned off or taken by another app. Try again to restart it.',
            retry: true,
          });
        });
      });

      // iOS only plays a camera stream inline when these are set before play().
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
        fail({
          title: 'The scanner could not load',
          message: 'Check your connection and try again.',
          retry: true,
        });
        return;
      }
      if (cancelled) return;

      setCameraState('live');
      loop(decode);
    };

    start();

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      stopStream(stream);
      if (video) {
        try { video.pause(); } catch { /* not playing */ }
        video.srcObject = null;
      }
    };
  }, [attempt, pageHidden, podOpen, getDecoder]);

  // ── Escape closes ────────────────────────────────────────────────────────
  // While the POD is open, Escape belongs to DeliveryModal (it cancels the
  // POD and keeps the session).
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'Escape' && !podOpen) onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose, podOpen]);

  const handlePhoto = async (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = ''; // picking the same photo again must still fire change
    if (!file || resolvingRef.current) return;

    // Holds the live loop off while the photo is decoded.
    resolvingRef.current = true;
    setBusy(true);
    setNotice('');
    let loaded = null;
    let text = null;
    let unreadable = false;
    try {
      loaded = await loadImage(file);
      const decode = await getDecoder();
      text = await decode(loaded.img, { photo: true });
    } catch {
      unreadable = true;
    } finally {
      if (loaded) URL.revokeObjectURL(loaded.url);
      resolvingRef.current = false;
    }
    if (!mountedRef.current) return;
    setBusy(false);
    if (unreadable) {
      reject('That photo could not be read. Try another one.');
      return;
    }
    if (!text) {
      reject('No QR code found in that photo. Try again with the label filling more of the picture.');
      return;
    }
    // A photo is a deliberate choice, so its result is never cooled down.
    lastScanRef.current = { text: '', at: 0 };
    await handleScan(text);
  };

  const handleManualSubmit = (event) => {
    event.preventDefault();
    if (resolvingRef.current) return;
    const trackingNumber = normalizeTrackingNumber(manualValue);
    if (!trackingNumber) {
      setManualError('Enter a tracking number like CE-20260801-3261.');
      return;
    }
    setManualError('');
    lastScanRef.current = { text: '', at: 0 };
    handleScan(trackingNumber);
  };

  const handleOverlayClick = (e) => {
    if (e.target === e.currentTarget) onClose();
  };

  // The proof of delivery replaces the camera view in place. Its own overlay
  // sits above this one, and the session is untouched until it is saved.
  if (podOpen && podOrder) {
    return (
      <DeliveryModal order={podOrder} onClose={closePod} onSave={handleDeliverySubmit} />
    );
  }

  const boxes = session ? boxNumbersFor(session.packageQuantity) : [];
  const remaining = session ? missingBoxes(session) : [];
  const verifiedCount = boxes.length - remaining.length;

  // Portalled to <body> for the same reason ConfirmModal is: the admin page
  // sits inside a transformed <PageTransition>, which would trap a fixed
  // overlay in its stacking context.
  return createPortal(
    <FocusTrap active>
      <div
        className="modal-overlay qr-scanner-overlay"
        onClick={handleOverlayClick}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <div className="qr-scanner-modal" onClick={(e) => e.stopPropagation()}>
          <div className="qr-scanner-header">
            <div className="qr-scanner-heading">
              <h2 id={titleId} className="qr-scanner-title">Scan package QR</h2>
              <p id={descriptionId} className="qr-scanner-subtitle">
                {session
                  ? 'Keep the camera on each box label in turn. No need to tap between boxes.'
                  : 'Point the camera at the QR label on a box.'}
              </p>
            </div>
            <button
              type="button"
              className="btn-icon btn-ghost qr-scanner-close"
              onClick={onClose}
              aria-label="Close scanner"
              title="Close"
            >
              <X size={20} aria-hidden="true" />
            </button>
          </div>

          {session && (
            <section className="qr-scanner-session" aria-label="Active delivery">
              <div className="qr-scanner-session-head">
                <div className="qr-scanner-session-who">
                  <span className="qr-scanner-session-label">Delivering to</span>
                  <strong className="qr-scanner-session-name">{session.customerName || 'Receiver'}</strong>
                  <span className="report-mono qr-scanner-session-tracking">{session.trackingNumber}</span>
                </div>
                <span className="qr-scanner-session-count">
                  {verifiedCount} / {boxes.length} Boxes Scanned
                </span>
              </div>
              <div
                className="qr-scanner-session-bar"
                role="progressbar"
                aria-label="Boxes scanned"
                aria-valuemin={0}
                aria-valuemax={boxes.length}
                aria-valuenow={verifiedCount}
              >
                <span style={{ width: `${(verifiedCount / boxes.length) * 100}%` }} />
              </div>
            </section>
          )}

          <div className="qr-scanner-viewfinder">
            <div className="qr-scanner-viewfinder-inner">
              <video
                ref={videoRef}
                className="qr-scanner-video"
                playsInline
                muted
                autoPlay
                aria-hidden="true"
              />

              {cameraState === 'live' && !busy && (
                <div className="qr-scanner-frame" aria-hidden="true">
                  <span className="qr-scanner-corner qr-scanner-corner-tl" />
                  <span className="qr-scanner-corner qr-scanner-corner-tr" />
                  <span className="qr-scanner-corner qr-scanner-corner-bl" />
                  <span className="qr-scanner-corner qr-scanner-corner-br" />
                  <span className="qr-scanner-line" />
                </div>
              )}

              {(cameraState === 'starting' || busy) && (
                <div className="qr-scanner-state">
                  <Loader size={28} className="animate-spin" aria-hidden="true" />
                  <span className="qr-scanner-state-text">
                    {busy ? (session ? 'Verifying box…' : 'Opening booking…') : 'Starting camera…'}
                  </span>
                </div>
              )}

              {cameraState === 'error' && cameraError && !busy && (
                <div className="qr-scanner-state qr-scanner-state-error">
                  <CameraOff size={30} aria-hidden="true" />
                  <span className="qr-scanner-state-title">{cameraError.title}</span>
                  <span className="qr-scanner-state-text">{cameraError.message}</span>
                  {cameraError.retry && (
                    <button
                      type="button"
                      className="btn btn-sm qr-scanner-retry"
                      onClick={() => setAttempt((n) => n + 1)}
                    >
                      <RotateCcw size={15} aria-hidden="true" />
                      Try again
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          <p className={`qr-scanner-notice qr-scanner-notice-${noticeTone}`} role="status" aria-live="polite">
            {notice}
          </p>

          <div className="qr-scanner-actions">
            <button
              type="button"
              className="btn btn-outline qr-scanner-manual-btn"
              onClick={() => setManualOpen(true)}
              disabled={busy}
            >
              <Keyboard size={16} aria-hidden="true" />
              Can&apos;t Scan QR?
            </button>

            {session && (
              <button
                type="button"
                className="btn btn-primary qr-scanner-pod-btn"
                onClick={openPod}
                disabled={busy || remaining.length > 0}
              >
                <PackageCheck size={17} aria-hidden="true" />
                {remaining.length > 0
                  ? `Scan ${boxCount(remaining.length)} more to continue`
                  : 'Proceed to POD'}
              </button>
            )}
          </div>

          {manualOpen && (
            <ManualBoxMatchOverlay
              orders={session?.order ? [session.order] : (initialOrder ? [initialOrder] : candidateOrders)}
              heldKeys={new Set()}
              busy={busy}
              onConfirm={handleManualMatchConfirm}
              onClose={() => setManualOpen(false)}
              notFoundMessage={initialOrder ? `Not matching ${initialOrder.tracking_number}.` : "No matching booking found. Check the tracking number and try again."}
            />
          )}
        </div>
      </div>
    </FocusTrap>,
    document.body
  );
};

export default QrScannerModal;
