import { useState, useRef, useEffect } from 'react';
import { X, Camera, Loader, Scale, CreditCard, Upload, Trash2, Package, CheckCircle } from 'lucide-react';
import FocusTrap from './FocusTrap';
import useScrollLock from '../../hooks/useScrollLock';
import useFieldErrors from '../../hooks/useFieldErrors';
import FieldError, { errorId, fieldAttrs, invalidClass } from './FieldError';
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
 * PickupModal — Admin pickup processing.
 *
 * Owns what is specific to a pickup: the scale weight, who pays, and the proof
 * photos. The money itself is collected by PaymentCollectionPanel, which is the
 * same component the delivery counter uses.
 */
const PickupModal = ({ order, onClose, onSave, pricePerKilo = 70 }) => {
  useScrollLock(true); // mounted only while open

  const [form, setForm] = useState({
    actual_weight: order?.actual_weight || '',
    payer_type: order?.payer_type || 'sender',
  });

  const [payment, setPayment] = useState(() => createPaymentCollectionState({
    payment_type: (order?.payment_status === 'partial' || order?.payment_status === 'unpaid' || order?.payment_method === 'paylater')
      ? 'paylater'
      : 'full',
    payment_method: (order?.payment_method === 'paylater') ? '' : (order?.payment_method || ''),
    amount: sanitizeAmount(order?.amount_paid ?? ''),
    promised_payment_date: order?.promised_payment_date || '',
  }));

  const [photos, setPhotos] = useState([]);
  const [photoPreviews, setPhotoPreviews] = useState([]);

  const [saving, setSaving] = useState(false);
  const [uploadProgress, setUploadProgress] = useState('');
  const [error, setError] = useState('');

  // Field-level validation. The banner above still carries errors that belong
  // to no single field (an upload that failed, a PayMongo refusal); anything
  // attributable to a control is reported at that control instead.
  const { errors, validate, clearError, setError: setFieldError, containerRef } = useFieldErrors();

  const fileInputRef = useRef(null);

  // ── Billing mode ─────────────────────────────────────────────────────────
  // Freight Prepaid  (payer_type = 'sender')   → money is collected HERE, at pickup.
  // Freight Collect  (payer_type = 'receiver') → money is collected at DELIVERY,
  //                                              from someone who is not present now.
  //
  // Collect is the industry-standard COD arrangement: the carrier's security is
  // possession of the cargo, so there is nothing to collect at pickup and the
  // driver must never be asked to. That is why the whole payment panel is
  // conditional on this — not merely disabled, absent.
  const isPrepaid = form.payer_type === 'sender';
  const estimatedCost = parseFloat(form.actual_weight || 0) * pricePerKilo;

  // Everything the shared panel needs to know about a PICKUP specifically.
  const paymentConfig = {
    expectedAmount: estimatedCost,
    expectedNoun: 'total cost',
    amountLabels: {
      full: 'Amount Received (₱) *',
      paylater: 'Downpayment (₱) (Optional)',
    },
    // The pickup figure is the CLIENT-side estimate — guard_order_update
    // recomputes shipping_cost from the trip's own rate on save. Capping the
    // entry against a number that is not authoritative would reject a
    // legitimate collection, so pickup does not cap. Delivery does: its
    // remaining_balance comes from the database.
    capAtExpected: false,
    purpose: 'Pickup',
    confirmLabel: 'Confirm Pickup',
    confirmVerb: 'confirm the pickup',
    billing: {
      name: form.payer_type === 'sender' ? order.sender_name : order.receiver_name,
      phone: form.payer_type === 'sender' ? order.sender_phone : order.receiver_phone,
    },
    sourceMetadata: {
      actualWeight: parseFloat(form.actual_weight) || 0,
      payerType: form.payer_type,
    },
    onError: setError,
  };

  const derived = derivePaymentCollection(payment, paymentConfig);
  // A live, unconfirmed checkout must not release the cargo — the parcel would
  // leave while the webhook is still deciding. The panel supplies the escape
  // hatch (cancel and pay another way) that makes locking this safe.
  const submitLocked = isPrepaid && (payment.paymentStep === 'generating' || derived.gcashUnresolved);

  const handlePhotoAdd = (e) => {
    const newFiles = Array.from(e.target.files || []);
    const total = photos.length + newFiles.length;
    if (total > 3) {
      // Belongs to the picker, not to the modal — report it there.
      setFieldError('pickup_photos', 'Maximum 3 pickup photos allowed.');
      return;
    }

    const validFiles = newFiles.filter(f => {
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(f.type)) {
        setFieldError('pickup_photos', 'Only JPG, PNG, and WebP images are allowed.');
        return false;
      }
      return true;
    });

    if (validFiles.length) clearError('pickup_photos');
    setPhotos(prev => [...prev, ...validFiles]);

    validFiles.forEach(file => {
      const reader = new FileReader();
      reader.onload = (evt) => {
        setPhotoPreviews(prev => [...prev, evt.target.result]);
      };
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

    // Every rule is evaluated before anything is reported, so a submit that is
    // wrong in three places says so once. The old sequence returned on the
    // first failure, which walked the admin through the same modal three times.
    const rules = {
      actual_weight: (!form.actual_weight || parseFloat(form.actual_weight) <= 0)
        ? 'Enter the weight from the scale. The price is computed from it, so the parcel cannot be priced without it.'
        : null,
      pickup_photos: photos.length === 0
        ? 'Attach at least 1 photo of the parcel as pickup proof.'
        : null,
    };

    // Payment validation applies to Prepaid only. On a Collect shipment there is
    // nobody here to pay, so demanding a payment method would be nonsensical.
    let flagShortfall = false;
    if (isPrepaid) {
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
      setUploadProgress('Uploading pickup proofs...');
      const photoUrls = await uploadMultiplePhotos(
        photos,
        'pickup-proofs',
        order.tracking_number,
        (current, total) => setUploadProgress(`Uploading pickup proof ${current}/${total}...`)
      );

      let receiptUrl = null;
      if (payment.receiptFile) {
        setUploadProgress('Uploading receipt...');
        const rResult = await uploadPhoto(payment.receiptFile, 'receipts', order.tracking_number, 1);
        receiptUrl = rResult.path || rResult.url;
      }

      setUploadProgress('Processing Payment...');

      // Order metadata only. amount_paid / remaining_balance / payment_status
      // are absent on purpose — the payment_transactions ledger owns them and
      // record_pickup_payment lets the trigger derive them.
      const payload = {
        actual_weight: parseFloat(form.actual_weight),
        payer_type: form.payer_type,
        pickup_photos: photoUrls,
        // Freight Collect — nothing is collected at pickup. The order leaves
        // with its full balance owing; DeliveryModal is the collection point,
        // and no method is chosen yet because the receiver decides it there.
        ...(isPrepaid
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
    <div className="modal-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="pickup-modal-title">
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 560 }}>
        <div className="modal-header">
          <h3 id="pickup-modal-title"><Package size={18} aria-hidden="true" /> Pickup Processing</h3>
          <button type="button" className="btn-icon btn-ghost" onClick={onClose} aria-label="Close pickup modal"><X size={20} aria-hidden="true" /></button>
        </div>

        <div className="modal-body" ref={containerRef} style={{ maxHeight: '70vh', overflowY: 'auto' }}>
          {/* Order summary */}
          <div className="pickup-summary-card flex justify-between items-center mb-20" style={{
            background: 'var(--bg-secondary)', borderRadius: 8, padding: 14,
          }}>
            <div>
              <div className="fw-700 text-accent">{order.tracking_number}</div>
              <div className="text-secondary" style={{ fontSize: '0.8125rem' }}>
                {order.sender_name} → {order.receiver_name}
              </div>
            </div>
            <div className="text-xs text-tertiary">
              {order.package_description || 'No description'}
            </div>
          </div>

          {error && (
            <div style={{
              background: 'var(--error-bg)', color: 'var(--error-text-strong)', padding: '10px 14px',
              borderRadius: 8, fontSize: '0.8125rem', marginBottom: 16, border: '1px solid var(--error)',
            }} role="alert">
              {error}
            </div>
          )}

          {/* Actual Weight */}
          <div className="form-group">
            <label className="form-label" htmlFor="pickup-actual-weight">
              <Scale size={14} className="inline mr-6" />
              Actual Weight (kg) *
            </label>
            <input
              id="pickup-actual-weight"
              type="number"
              className={`form-input ${invalidClass('actual_weight', errors)}`}
              placeholder="Enter actual weight after weighing"
              value={form.actual_weight}
              onChange={e => {
                setPayment(p => ({ ...p, shortfallBlocked: false }));
                setForm(p => ({ ...p, actual_weight: e.target.value }));
                clearError('actual_weight');
              }}
              step="0.1" min="0.1"
              {...fieldAttrs('actual_weight', errors)}
            />
            <FieldError name="actual_weight" errors={errors} />
            {form.actual_weight && (
              <div className="text-xs text-success mt-4">
                Estimated cost: ₱{formatAmount(estimatedCost.toFixed(2))}
              </div>
            )}
          </div>

          {/* ── Billing mode — decides whether we collect anything at all ── */}
          <div className="form-group">
            <label className="form-label">
              <CreditCard size={14} className="inline mr-6" />
              Who Pays? *
            </label>
            <div className="pickup-segment-row flex gap-8">
              {['sender', 'receiver'].map(t => (
                <button
                  key={t} type="button"
                  className={`btn ${form.payer_type === t ? 'btn-secondary' : 'btn-outline'} btn-sm flex-1 justify-center`}
                  onClick={() => setForm(p => ({ ...p, payer_type: t }))}
                >
                  {t === 'sender' ? 'Sender (pay now)' : 'Receiver (pay on delivery)'}
                </button>
              ))}
            </div>
            {/* What the customer declared at booking. Previously collected and
                never shown to anyone. */}
            {(order?.payer_type || order?.payment_preference) && (
              <div className="text-xs text-secondary mt-4">
                Booking says: <strong className="text-capitalize">{order.payer_type || 'sender'}</strong> pays
                {order.payment_preference && order.payment_preference !== 'unspecified' && (
                  <> · prefers <strong className="text-capitalize">{order.payment_preference}</strong></>
                )}
              </div>
            )}
          </div>

          {/* ── Freight Collect: nothing to collect here ── */}
          {!isPrepaid && (
            <div className="mb-16" style={{ background: 'var(--info-bg, var(--bg-secondary))', borderRadius: 8, padding: 14, border: '1px solid var(--info, var(--border))' }}>
              <div className="mb-4" style={{ fontSize: '0.8125rem', fontWeight: 600 }}>
                <Package size={14} className="inline mr-6" />
                Freight Collect — no payment at pickup
              </div>
              <div className="text-xs text-secondary">
                {estimatedCost > 0 ? <>₱{formatAmount(estimatedCost.toFixed(2))} will be collected from </> : <>The freight charge will be collected from </>}
                <strong>{order?.receiver_name || 'the receiver'}</strong> on delivery.
                Weigh the parcel, take the proof photos, and confirm — there is nothing to collect now.
              </div>
            </div>
          )}

          {/* ── Prepaid: the shared collection panel ── */}
          {isPrepaid && (
            <PaymentCollectionPanel
              order={order}
              value={payment}
              setValue={setPayment}
              config={paymentConfig}
              disabled={saving}
              errors={errors}
              clearError={clearError}
            />
          )}

          {/* Pickup Proofs */}
          <div className="form-group mt-16 mb-0">
            <label className="form-label" id="pickup-photos-label">
              <Camera size={14} className="inline mr-6" />
              Pickup Proof Photos * (1-3)
            </label>
            <div
              className={`flex gap-10 flex-wrap mt-8 ${errors.pickup_photos ? 'field-group-invalid' : ''}`}
              role="group"
              aria-labelledby="pickup-photos-label"
              aria-invalid={errors.pickup_photos ? 'true' : undefined}
              aria-describedby={errors.pickup_photos ? errorId('pickup_photos') : undefined}
              tabIndex={errors.pickup_photos ? -1 : undefined}
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
            <FieldError name="pickup_photos" errors={errors} />
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
            {saving ? <><Loader size={16} className="animate-spin" /> {uploadProgress || 'Processing...'}</> : <><CheckCircle size={16} /> Confirm Pickup</>}
          </button>
        </div>
      </div>
    </div>
    </FocusTrap>
  );
};

export default PickupModal;
