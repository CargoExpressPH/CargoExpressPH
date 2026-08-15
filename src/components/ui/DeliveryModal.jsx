import { useState, useRef, useEffect } from 'react';
import { X, Camera, Loader, Package, CheckCircle, Trash2, Upload } from 'lucide-react';
import FocusTrap from './FocusTrap';
import useScrollLock from '../../hooks/useScrollLock';
import useFieldErrors from '../../hooks/useFieldErrors';
import FieldError, { errorId } from './FieldError';
import { sanitizeAmount, formatAmount } from '../../utils/currencyInput';
import { uploadMultiplePhotos, uploadPhoto } from '../../lib/storage';
import PaymentCollectionPanel, {
  createPaymentCollectionState,
  derivePaymentCollection,
  validatePaymentCollection,
  buildPaymentSubmission,
  PAYMENT_FIELDS,
} from './PaymentCollectionPanel';

/**
 * DeliveryModal — Admin delivery processing.
 *
 * Owns the delivery proof photos. The money is collected by
 * PaymentCollectionPanel, the same component the pickup counter uses — the only
 * differences are the figure being collected against (the remaining balance
 * rather than the freight total) and the fact that this one is authoritative,
 * so it caps.
 */
const DeliveryModal = ({ order, onClose, onSave }) => {
  useScrollLock(true); // mounted only while open

  const isPaid = order.payment_status === 'paid';
  const balance = parseFloat(order.remaining_balance || 0);
  const needsPayment = !isPaid && balance > 0;

  const [payment, setPayment] = useState(() => createPaymentCollectionState({
    // Seeded with the whole balance, which is what Full Payment claims.
    amount: needsPayment ? sanitizeAmount(balance) : '0',
    payment_method: needsPayment ? 'cash' : '',
    promised_payment_date: order?.promised_payment_date || '',
  }));

  const [photos, setPhotos] = useState([]);
  const [photoPreviews, setPhotoPreviews] = useState([]);

  const [saving, setSaving] = useState(false);
  const [uploadProgress, setUploadProgress] = useState('');
  const [error, setError] = useState('');

  // Same split as PickupModal: attributable problems go to their control, the
  // banner keeps only what belongs to no field.
  const { errors, validate, clearError, setError: setFieldError, containerRef } = useFieldErrors();

  const fileInputRef = useRef(null);

  const paymentConfig = {
    expectedAmount: balance,
    expectedNoun: 'balance',
    amountLabels: {
      full: 'Amount Collected (₱) *',
      paylater: 'Amount Collected (₱) (Optional)',
    },
    // Unlike the pickup estimate, remaining_balance comes from the database and
    // is authoritative — collecting more than it at the door is an error, not a
    // rounding difference.
    capAtExpected: true,
    purpose: 'Delivery',
    confirmLabel: 'Complete Delivery',
    confirmVerb: 'complete the delivery',
    billing: {
      name: order.receiver_name,
      phone: order.receiver_phone,
    },
    sourceMetadata: { payerType: 'receiver' },
    onError: setError,
  };

  const derived = derivePaymentCollection(payment, paymentConfig);
  // Same lock as pickup: cargo is not handed over while a GCash checkout is
  // still an open question. The panel's "cancel — pay another way" button is
  // what keeps the driver from being stranded.
  const submitLocked = needsPayment
    && (payment.paymentStep === 'generating' || derived.gcashUnresolved);

  const handlePhotoAdd = (e) => {
    const newFiles = Array.from(e.target.files || []);
    const total = photos.length + newFiles.length;
    if (total > 3) {
      setFieldError('delivery_photos', 'Maximum 3 delivery photos allowed.');
      return;
    }
    const validFiles = newFiles.filter(f => ['image/jpeg', 'image/png', 'image/webp'].includes(f.type));
    if (validFiles.length < newFiles.length) {
      setFieldError('delivery_photos', 'Only JPG, PNG, and WebP images are allowed.');
    } else if (validFiles.length) {
      clearError('delivery_photos');
    }
    setPhotos(prev => [...prev, ...validFiles]);
    validFiles.forEach(file => {
      const reader = new FileReader();
      reader.onload = (evt) => setPhotoPreviews(prev => [...prev, evt.target.result]);
      reader.readAsDataURL(file);
    });
    setError('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const removePhoto = (index) => {
    setPhotos(prev => prev.filter((_, i) => i !== index));
    setPhotoPreviews(prev => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async () => {
    setError('');
    setPayment(p => ({ ...p, shortfallBlocked: false }));

    const rules = {
      delivery_photos: photos.length === 0
        ? 'Attach at least 1 photo as proof of delivery.'
        : null,
    };

    let flagShortfall = false;
    if (needsPayment) {
      const result = validatePaymentCollection(payment, paymentConfig);
      if (result.error) {
        rules[result.field || PAYMENT_FIELDS.amount] = result.error;
        flagShortfall = result.flagShortfall;
      }
    }

    if (!validate(rules)) {
      if (flagShortfall) setPayment(p => ({ ...p, shortfallBlocked: true }));
      return;
    }

    setSaving(true);
    try {
      setUploadProgress('Uploading delivery proofs...');
      const photoUrls = await uploadMultiplePhotos(
        photos,
        'delivery-proofs',
        order.tracking_number,
        (current, total) => setUploadProgress(`Uploading photo ${current}/${total}...`)
      );

      let receiptUrl = null;
      if (payment.receiptFile) {
        setUploadProgress('Uploading receipt...');
        const rResult = await uploadPhoto(payment.receiptFile, 'receipts', order.tracking_number, 1);
        receiptUrl = rResult.path || rResult.url;
      }

      setUploadProgress('Finalizing...');

      // Order metadata only. amount_paid / remaining_balance / payment_status
      // are owned by the payment_transactions ledger — record_delivery_payment
      // inserts the ledger row and lets the trigger derive the totals.
      const payload = {
        delivery_photos: photoUrls,
        // Already settled: there is nothing to collect and nothing to promise.
        ...(needsPayment
          ? buildPaymentSubmission(payment, paymentConfig, receiptUrl)
          : { payment_method: null, payment_reference: null, promised_payment_date: null, payment: null }),
      };

      await onSave(payload);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <FocusTrap active>
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal modal-delivery"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="delivery-modal-title"
      >
        <div className="modal-header">
          <h3 id="delivery-modal-title"><Package size={18} aria-hidden="true" /> Confirm Delivery</h3>
          <button type="button" className="btn-icon btn-ghost" onClick={onClose} aria-label="Close delivery modal"><X size={20} aria-hidden="true" /></button>
        </div>

        <div className="modal-body modal-body-scroll" ref={containerRef}>
          <div className="pickup-summary-card summary-card-secondary flex justify-between items-center mb-20">
            <div>
              <div className="fw-700 text-accent">{order.tracking_number}</div>
              <div className="text-secondary" style={{ fontSize: '0.8125rem' }}>
                Deliver to: {order.receiver_name}
              </div>
            </div>
            {needsPayment && (
              <div className="text-error fw-700">
                Collect: ₱{formatAmount(balance.toFixed(2))}
              </div>
            )}
          </div>

          {error && (
            <div style={{
              background: 'var(--error-bg)', color: 'var(--error-text-strong)', padding: '10px 14px',
              borderRadius: 8, fontSize: '0.8125rem', marginBottom: 16, border: '1px solid var(--error)',
            }} role="alert">
              {error}
            </div>
          )}

          {needsPayment && (
            <div className="mb-20" style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 16 }}>
              <PaymentCollectionPanel
                order={order}
                value={payment}
                setValue={setPayment}
                config={paymentConfig}
                disabled={saving}
                errors={errors}
                clearError={clearError}
              />
            </div>
          )}

          <div className="form-group mb-0">
            <label className="form-label" id="delivery-photos-label">
              <Camera size={14} className="inline mr-6" />
              Delivery Proof Photos * (1-3)
            </label>
            <div
              className={`flex gap-10 flex-wrap mt-8 ${errors.delivery_photos ? 'field-group-invalid' : ''}`}
              role="group"
              aria-labelledby="delivery-photos-label"
              aria-invalid={errors.delivery_photos ? 'true' : undefined}
              aria-describedby={errors.delivery_photos ? errorId('delivery_photos') : undefined}
              tabIndex={errors.delivery_photos ? -1 : undefined}
            >
              {photoPreviews.map((preview, i) => (
                <div key={i} className="relative overflow-hidden" style={{ width: 90, height: 90, borderRadius: 8, border: '2px solid var(--border)' }}>
                  <img src={preview} alt={`Photo ${i + 1}`} className="w-full h-full" style={{ objectFit: 'cover' }} />
                  <button type="button" onClick={() => removePhoto(i)} className="pickup-photo-remove-btn" aria-label={`Remove photo ${i + 1}`}>
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
              {photos.length < 3 && (
                <button
                  type="button" onClick={() => fileInputRef.current?.click()}
                  style={{
                    width: 90, height: 90, borderRadius: 8, border: '2px dashed var(--border)',
                    background: 'var(--bg-secondary)', display: 'flex', flexDirection: 'column',
                    alignItems: 'center', justifyContent: 'center', gap: 4, cursor: 'pointer', color: 'var(--text-tertiary)', fontSize: '0.6875rem'
                  }}
                >
                  <Upload size={20} /> Add Photo
                </button>
              )}
            </div>
            <FieldError name="delivery_photos" errors={errors} />
            <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={handlePhotoAdd} style={{ display: 'none' }} />
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn btn-outline" onClick={onClose} disabled={saving || payment.paymentStep === 'generating'}>Cancel</button>
          <button
            className="btn btn-primary"
            onClick={handleSubmit}
            disabled={saving || submitLocked}
            title={submitLocked && payment.paymentStep === 'waiting'
              ? 'Waiting for the GCash payment to be confirmed or cancelled'
              : undefined}
          >
            {saving ? <><Loader size={16} className="animate-spin" /> {uploadProgress || 'Processing...'}</> : <><CheckCircle size={16} /> Complete Delivery</>}
          </button>
        </div>
      </div>
    </div>
    </FocusTrap>
  );
};

export default DeliveryModal;
