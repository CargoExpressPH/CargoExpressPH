import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Phone, Camera, Loader, AlertTriangle, Eraser, ArrowLeft, ShieldCheck } from 'lucide-react';
import FocusTrap from './FocusTrap';
import { orderPartyName } from '../../lib/orderParties';
import { maskPersonName, maskPhone } from '../../utils/maskName';
import { uploadPhoto } from '../../lib/storage';
import { serializePhotoReference } from '../../lib/photoReference';

const EVIDENCE_FOLDER = 'delivery-proofs';
const SIGNATURE_WIDTH = 480;
const SIGNATURE_HEIGHT = 180;

/** Boxes of the trip that are still outstanding: not scanned, not held, not already delivered. */
export const remainingBoxCandidates = (orders, heldKeys) => orders
  .filter((o) => !['Cancelled', 'Pending Cancellation', 'Pending', 'Assigned', 'Delivered'].includes(o.status))
  .map((o) => {
    const qty = o.package_quantity || 1;
    const verified = o.verified_boxes || [];
    const open = Array.from({ length: qty }, (_, i) => i + 1)
      .filter((b) => !verified.includes(b) && !heldKeys.has(`${o.id}:${b}`));
    return { order: o, openBoxes: open };
  })
  .filter((candidate) => candidate.openBoxes.length > 0);

const SignaturePad = ({ onChange }) => {
  const canvasRef = useRef(null);
  const drawingRef = useRef(false);
  const inkedRef = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff'; // JPEG has no alpha; a transparent pad would save as black
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#111827';
  }, []);

  const pointFor = (event) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    };
  };

  const start = (event) => {
    event.preventDefault();
    canvasRef.current.setPointerCapture?.(event.pointerId);
    drawingRef.current = true;
    const ctx = canvasRef.current.getContext('2d');
    const { x, y } = pointFor(event);
    ctx.beginPath();
    ctx.moveTo(x, y);
  };

  const move = (event) => {
    if (!drawingRef.current) return;
    event.preventDefault();
    const ctx = canvasRef.current.getContext('2d');
    const { x, y } = pointFor(event);
    ctx.lineTo(x, y);
    ctx.stroke();
    if (!inkedRef.current) { inkedRef.current = true; onChange(canvasRef.current); }
  };

  const end = () => { drawingRef.current = false; };

  const clear = () => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    inkedRef.current = false;
    onChange(null);
  };

  return (
    <div className="trip-scanner-signature">
      <canvas
        ref={canvasRef}
        className="trip-scanner-signature-canvas"
        width={SIGNATURE_WIDTH}
        height={SIGNATURE_HEIGHT}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onPointerLeave={end}
        aria-label="Signature pad"
      />
      <button type="button" className="btn btn-ghost btn-sm" onClick={clear}>
        <Eraser size={13} className="inline mr-4" /> Clear
      </button>
    </div>
  );
};

const canvasToFile = (canvas) => new Promise((resolve, reject) => {
  canvas.toBlob((blob) => {
    if (!blob) { reject(new Error('Could not capture the signature.')); return; }
    resolve(new File([blob], 'signature.jpg', { type: 'image/jpeg' }));
  }, 'image/jpeg', 0.92);
});

/**
 * Case B of the field fallbacks: the QR and the printed text are both gone.
 * The driver narrows the manifest down to what is still outstanding, phones
 * the candidate customers to confirm the parcel, and — before the box can be
 * counted — must attach a photo of the damaged box and a signature (strict
 * proof). The match is never silent: onMatch receives the saved evidence so it
 * lands in the activity log.
 */
const UnidentifiedBoxModal = ({ orders, heldKeys, isDeliveryMode, onMatch, onClose }) => {
  const titleId = useId();
  const candidates = useMemo(() => remainingBoxCandidates(orders, heldKeys), [orders, heldKeys]);

  const [pick, setPick] = useState(null); // { order, box }
  const [photo, setPhoto] = useState(null);
  const [photoPreview, setPhotoPreview] = useState('');
  const [signatureCanvas, setSignatureCanvas] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const photoInputRef = useRef(null);

  useEffect(() => () => { if (photoPreview) URL.revokeObjectURL(photoPreview); }, [photoPreview]);

  const handlePhoto = (event) => {
    const file = (event.target.files || [])[0];
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setError('Only JPG, PNG, and WebP photos are allowed.');
      return;
    }
    setError('');
    setPhoto(file);
    setPhotoPreview((previous) => {
      if (previous) URL.revokeObjectURL(previous);
      return URL.createObjectURL(file);
    });
    if (photoInputRef.current) photoInputRef.current.value = '';
  };

  const canSubmit = Boolean(pick && photo && signatureCanvas) && !saving;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setError('');
    try {
      const signatureFile = await canvasToFile(signatureCanvas);
      const { order, box } = pick;
      const photoRef = serializePhotoReference(
        await uploadPhoto(photo, EVIDENCE_FOLDER, order.tracking_number, 1, order.id),
      );
      const signatureRef = serializePhotoReference(
        await uploadPhoto(signatureFile, EVIDENCE_FOLDER, order.tracking_number, 2, order.id),
      );
      await onMatch(order, box, { photoRef, signatureRef });
    } catch (err) {
      setError(err?.message || 'Could not save the proof. Check your connection and try again.');
      setSaving(false);
    }
  };

  return createPortal(
    <FocusTrap active>
      <div
        className="modal-overlay trip-scanner-sheet-overlay"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => { if (e.target === e.currentTarget && !saving) onClose(); }}
      >
        <div className="trip-scanner-sheet" onClick={(e) => e.stopPropagation()}>
          <div className="trip-scanner-sheet-head">
            <h3 id={titleId} className="trip-scanner-sheet-title">
              {pick ? 'Strict proof required' : 'Damaged / unidentified label'}
            </h3>
            <button type="button" className="btn-icon btn-ghost" onClick={onClose} disabled={saving} aria-label="Close">
              <X size={18} />
            </button>
          </div>

          {!pick && (
            <>
              <p className="trip-scanner-sheet-hint">
                Only boxes not yet scanned on this trip are listed. Call the receiver to confirm
                what the parcel is (contents, size, sender) before choosing a match.
              </p>
              {candidates.length === 0 ? (
                <div className="trip-scanner-notice trip-scanner-notice-info" role="status">
                  <span>Every box on this trip is already accounted for, so this parcel does not belong to it.</span>
                </div>
              ) : (
                <div className="trip-scanner-candidates">
                  {candidates.map(({ order, openBoxes }) => {
                    const phone = String(order.receiver_phone || '').replace(/\s+/g, '');
                    return (
                      <div key={order.id} className="trip-scanner-candidate-card">
                        <div className="trip-scanner-candidate-main">
                          <strong>{order.tracking_number}</strong>
                          <span>{maskPersonName(orderPartyName(order, 'receiver')) || 'Receiver'}</span>
                          <span className="text-secondary text-xs">
                            {[order.receiver_city, order.receiver_province].filter(Boolean).join(', ') || 'No destination'}
                            {order.actual_weight ? ` · ${order.actual_weight} kg` : ''}
                            {order.package_quantity > 1 ? ` · ${order.package_quantity} boxes` : ''}
                          </span>
                          {phone && <span className="text-secondary text-xs">{maskPhone(phone)}</span>}
                        </div>
                        <div className="trip-scanner-candidate-actions">
                          {phone && (
                            <a className="btn btn-outline btn-sm" href={`tel:${phone}`}>
                              <Phone size={13} className="inline mr-4" /> Call
                            </a>
                          )}
                          <div className="trip-scanner-box-chips">
                            {openBoxes.map((b) => (
                              <button
                                key={b}
                                type="button"
                                className="trip-scanner-box-chip"
                                onClick={() => setPick({ order, box: b })}
                              >
                                Box {b}{order.package_quantity > 1 ? `/${order.package_quantity}` : ''}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}

          {pick && (
            <>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPick(null)} disabled={saving}>
                <ArrowLeft size={13} className="inline mr-4" /> Choose a different box
              </button>
              <div className="trip-scanner-verify-card">
                <div className="trip-scanner-verify-row">
                  <span className="trip-scanner-verify-label">Matching</span>
                  <span className="trip-scanner-verify-value">
                    {pick.order.tracking_number} · Box {pick.box} of {pick.order.package_quantity || 1}
                  </span>
                </div>
                <div className="trip-scanner-verify-row">
                  <span className="trip-scanner-verify-label">Receiver</span>
                  <span className="trip-scanner-verify-value">
                    {maskPersonName(orderPartyName(pick.order, 'receiver')) || 'Receiver'}
                  </span>
                </div>
              </div>

              <div className="trip-scanner-proof-step">
                <span className="trip-scanner-verify-label">1. Photo of the damaged box *</span>
                <input
                  ref={photoInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  capture="environment"
                  onChange={handlePhoto}
                  hidden
                />
                {photoPreview ? (
                  <img className="trip-scanner-proof-photo" src={photoPreview} alt="Damaged box" />
                ) : null}
                <button type="button" className="btn btn-outline btn-sm" onClick={() => photoInputRef.current?.click()} disabled={saving}>
                  <Camera size={14} className="inline mr-4" /> {photo ? 'Retake photo' : 'Take photo'}
                </button>
              </div>

              <div className="trip-scanner-proof-step">
                <span className="trip-scanner-verify-label">
                  2. Signature of {isDeliveryMode ? 'the receiver' : 'the receiving hub staff'} *
                </span>
                <SignaturePad onChange={setSignatureCanvas} />
              </div>

              {error && (
                <div className="trip-scanner-notice trip-scanner-notice-danger" role="alert">
                  <AlertTriangle size={15} className="trip-scanner-notice-icon" aria-hidden="true" />
                  <span>{error}</span>
                </div>
              )}

              <button
                type="button"
                className="btn btn-primary trip-scanner-sheet-confirm"
                disabled={!canSubmit}
                onClick={handleSubmit}
              >
                {saving
                  ? <><Loader size={15} className="animate-spin inline mr-4" /> Saving proof…</>
                  : <><ShieldCheck size={15} className="inline mr-4" /> Confirm Match with Proof</>}
              </button>
            </>
          )}
        </div>
      </div>
    </FocusTrap>,
    document.body,
  );
};

export default UnidentifiedBoxModal;
