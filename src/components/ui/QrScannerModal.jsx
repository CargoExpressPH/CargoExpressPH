import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { CameraOff, ImagePlus, Loader, RotateCcw, X } from 'lucide-react';
import FocusTrap from './FocusTrap';
import useScrollLock from '../../hooks/useScrollLock';
import { findOrderIdByTrackingNumber } from '../../lib/database';
import { normalizeTrackingNumber, orderRouteForScan, parseScanPayload } from '../../utils/scanPayload';

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
// A rejected code stays in frame while the admin reads why; without this the
// same message would be re-announced on every frame.
const REJECT_COOLDOWN_MS = 3000;
const LIVE_MAX_SIDE = 720;
const PHOTO_MAX_SIDES = [1024, 2048];

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

const QrScannerModal = ({ onClose }) => {
  const navigate = useNavigate();
  const titleId = useId();
  const descriptionId = useId();
  const manualInputId = useId();
  const manualErrorId = useId();

  const videoRef = useRef(null);
  const fileInputRef = useRef(null);
  const decoderRef = useRef(null);
  const resolvingRef = useRef(false);
  const lastRejectRef = useRef({ text: '', at: 0 });
  const mountedRef = useRef(true);

  // Live camera: 'starting' → 'live', or 'error' when it cannot be used.
  // `busy` is separate — a lookup or photo decode can run in any of them.
  const [cameraState, setCameraState] = useState('starting');
  const [busy, setBusy] = useState(false);
  const [cameraError, setCameraError] = useState(null);
  const [notice, setNotice] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [pageHidden, setPageHidden] = useState(() => typeof document !== 'undefined' && document.hidden);
  const [manualValue, setManualValue] = useState('');
  const [manualError, setManualError] = useState('');

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

  const reject = useCallback((text, message) => {
    lastRejectRef.current = { text, at: Date.now() };
    resolvingRef.current = false;
    if (!mountedRef.current) return;
    setNotice(message);
    setBusy(false);
  }, []);

  const openTrackingNumber = useCallback(async (trackingNumber, sourceText) => {
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
      reject(sourceText, `No booking found for ${trackingNumber}.`);
    } catch {
      reject(sourceText, `Could not look up ${trackingNumber}. Check your connection and try again.`);
    }
  }, [goTo, reject]);

  /** Acts on decoded QR text. Returns once the result has been handled. */
  const handleScan = useCallback(async (text) => {
    if (resolvingRef.current) return;
    const last = lastRejectRef.current;
    if (text === last.text && Date.now() - last.at < REJECT_COOLDOWN_MS) return;

    const payload = parseScanPayload(text);
    if (payload.kind === 'order') {
      resolvingRef.current = true;
      goTo(orderRouteForScan(payload));
      return;
    }
    if (payload.kind === 'tracking') {
      await openTrackingNumber(payload.trackingNumber, text);
      return;
    }
    if (payload.kind === 'payment') {
      reject(text, 'That is a GCash payment QR, not a package label.');
      return;
    }
    reject(text, 'This QR code is not a CargoExpress package label.');
  }, [goTo, openTrackingNumber, reject]);

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
    if (pageHidden) return undefined;

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
  }, [attempt, pageHidden, getDecoder]);

  // ── Escape closes ────────────────────────────────────────────────────────
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

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
      setNotice('That photo could not be read. Try another one.');
      return;
    }
    if (!text) {
      setNotice('No QR code found in that photo. Try again with the label filling more of the picture.');
      return;
    }
    // A photo is a deliberate choice, so its result is never cooled down.
    lastRejectRef.current = { text: '', at: 0 };
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
    lastRejectRef.current = { text: '', at: 0 };
    openTrackingNumber(trackingNumber, trackingNumber);
  };

  const handleOverlayClick = (e) => {
    if (e.target === e.currentTarget) onClose();
  };

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
                Point the camera at the QR label on a box.
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
                    {busy ? 'Opening booking…' : 'Starting camera…'}
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

          <p className="qr-scanner-notice" role="status" aria-live="polite">
            {notice}
          </p>

          <div className="qr-scanner-actions">
            <button
              type="button"
              className="btn btn-outline qr-scanner-photo-btn"
              onClick={() => fileInputRef.current && fileInputRef.current.click()}
              disabled={busy}
            >
              <ImagePlus size={17} aria-hidden="true" />
              Scan from a photo
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="qr-scanner-file-input"
              onChange={handlePhoto}
              tabIndex={-1}
              aria-label="Choose a photo of a package QR label"
            />
          </div>

          <form className="qr-scanner-manual" onSubmit={handleManualSubmit} noValidate>
            <label htmlFor={manualInputId} className="qr-scanner-manual-label">
              Or enter a tracking number
            </label>
            <div className="qr-scanner-manual-row">
              <input
                id={manualInputId}
                className="form-input qr-scanner-manual-input"
                type="text"
                inputMode="text"
                autoCapitalize="characters"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder="CE-20260801-3261"
                value={manualValue}
                onChange={(e) => { setManualValue(e.target.value); if (manualError) setManualError(''); }}
                aria-invalid={manualError ? 'true' : undefined}
                aria-describedby={manualError ? manualErrorId : undefined}
                maxLength={40}
              />
              <button type="submit" className="btn btn-primary qr-scanner-manual-submit" disabled={busy}>
                Find
              </button>
            </div>
            {manualError && (
              <p id={manualErrorId} className="qr-scanner-manual-error" role="alert">{manualError}</p>
            )}
          </form>
        </div>
      </div>
    </FocusTrap>,
    document.body
  );
};

export default QrScannerModal;
