import { useState, useRef, useEffect } from 'react';
import { X, Camera, Loader, Package, CreditCard, CheckCircle, Smartphone, AlertTriangle, Trash2, FileText, Upload, Calendar } from 'lucide-react';
import FocusTrap from './FocusTrap';
import useScrollLock from '../../hooks/useScrollLock';
import { uploadMultiplePhotos, uploadPhoto } from '../../lib/storage';
import QRCode from 'react-qr-code';
import { createGCashSource, registerSource } from '../../lib/paymongo';

/**
 * DeliveryModal — Admin delivery processing modal
 * Captures photos and GCash fields if unpaid
 */
const DeliveryModal = ({ order, onClose, onSave }) => {
  useScrollLock(true); // mounted only while open

  const isPaid = order.payment_status === 'paid';
  const balance = parseFloat(order.remaining_balance || 0);
  const needsPayment = !isPaid && balance > 0;

  const [form, setForm] = useState({
    amount_paid: needsPayment ? balance.toString() : '0',
    payment_method: needsPayment ? 'cash' : '',
    payment_reference: '',
    payment_date: new Date().toISOString().split('T')[0],
    promised_payment_date: order?.promised_payment_date || '',
  });

  // How much is actually being collected at the door, and what is left after.
  // The modal used to hardcode the full balance, so "the receiver cannot pay
  // right now" had no representation at all.
  const collectedNow = needsPayment ? (parseFloat(form.amount_paid || 0) || 0) : 0;
  const balanceAfter = Math.max(0, Math.round((balance - collectedNow) * 100) / 100);
  // Business rule: goods may be handed over with money still owing, but only
  // against a recorded Promise Date. The driver is standing there — that is
  // the moment to ask "when can you pay?", not a week later at reconciliation.
  const needsPromiseDate = needsPayment && balanceAfter > 0;

  const [photos, setPhotos] = useState([]);
  const [photoPreviews, setPhotoPreviews] = useState([]);

  const [receiptPhoto, setReceiptPhoto] = useState(null);
  const [receiptPreview, setReceiptPreview] = useState(null);

  // PayMongo GCash flow states
  const [paymentStep, setPaymentStep] = useState('setup');
  const [paymongoSourceId, setPaymongoSourceId] = useState(null);
  const [checkoutUrl, setCheckoutUrl] = useState(null);

  const [saving, setSaving] = useState(false);
  const [uploadProgress, setUploadProgress] = useState('');
  const [error, setError] = useState('');

  const fileInputRef = useRef(null);
  const receiptInputRef = useRef(null);

  const handleProceedToGCash = async () => {
    try {
      setPaymentStep('generating');
      setError('');
      if (balance <= 0) {
        setError('Payment amount must be greater than 0.');
        setPaymentStep('setup');
        return;
      }
      const billing = {
        name: order.receiver_name,
        phone: order.receiver_phone,
      };
      
      const source = await createGCashSource(balance, `CargoExpress - ${order.tracking_number} Delivery`, billing, true);
      await registerSource(source.sourceId, balance, { orderId: order.id, payerType: 'receiver' });
      
      setPaymongoSourceId(source.sourceId);
      setCheckoutUrl(source.checkoutUrl);
      setPaymentStep('waiting');
    } catch (err) {
      setError(err.message);
      setPaymentStep('setup');
    }
  };

  const resetPayMongoFlow = () => {
    setPaymentStep('setup');
    setPaymongoSourceId(null);
    setCheckoutUrl(null);
    setError('');
  };

  useEffect(() => {
    if (form.payment_method !== 'gcash' && (paymentStep !== 'setup' || paymongoSourceId || checkoutUrl)) {
      resetPayMongoFlow();
    }
  }, [form.payment_method]);

  const handlePhotoAdd = (e) => {
    const newFiles = Array.from(e.target.files || []);
    const total = photos.length + newFiles.length;
    if (total > 3) {
      setError('Maximum 3 delivery photos allowed');
      return;
    }
    const validFiles = newFiles.filter(f => ['image/jpeg', 'image/png', 'image/webp'].includes(f.type));
    setPhotos(prev => [...prev, ...validFiles]);
    validFiles.forEach(file => {
      const reader = new FileReader();
      reader.onload = (evt) => setPhotoPreviews(prev => [...prev, evt.target.result]);
      reader.readAsDataURL(file);
    });
    setError('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleReceiptAdd = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setError('Only JPG, PNG, and WebP images allowed for receipts');
      return;
    }
    setReceiptPhoto(file);
    const reader = new FileReader();
    reader.onload = (evt) => setReceiptPreview(evt.target.result);
    reader.readAsDataURL(file);
    setError('');
    if (receiptInputRef.current) receiptInputRef.current.value = '';
  };

  const removePhoto = (index) => {
    setPhotos(prev => prev.filter((_, i) => i !== index));
    setPhotoPreviews(prev => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async () => {
    setError('');
    
    if (photos.length === 0) {
      setError('At least 1 delivery proof photo is required');
      return;
    }

    if (needsPayment && collectedNow > 0 && form.payment_method === 'gcash') {
      const hasGeneratedQR = paymentStep === 'waiting' && checkoutUrl;
      const hasManualReference = form.payment_reference && form.payment_reference.trim().length > 0;
      if (!hasGeneratedQR && !hasManualReference) {
        setError('Please generate a GCash QR or enter a manual reference number.');
        return;
      }
      if (hasManualReference && !form.payment_date) {
        setError('Payment date is required for manual GCash reference');
        return;
      }
    }

    if (collectedNow > balance + 0.01) {
      setError(`Amount collected cannot exceed the ₱${balance.toFixed(2)} balance.`);
      return;
    }

    if (needsPromiseDate && !form.promised_payment_date) {
      setError(`₱${balanceAfter.toFixed(2)} will still be owing. Record a Promise Date before handing over the cargo.`);
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
      if (receiptPhoto) {
        setUploadProgress('Uploading receipt...');
        const rResult = await uploadPhoto(receiptPhoto, 'receipts', order.tracking_number, 1);
        receiptUrl = rResult.path || rResult.url;
      }

      setUploadProgress('Finalizing...');

      // Order metadata only. amount_paid / remaining_balance / payment_status
      // are owned by the payment_transactions ledger — record_delivery_payment
      // inserts the ledger row and lets the trigger derive the totals.
      const payload = {
        delivery_photos: photoUrls,
        payment_method: null,
        payment_reference: null,
        // Carried whenever a balance remains, so the promise survives on the
        // order and drives the unsettled-deliveries follow-up.
        promised_payment_date: needsPromiseDate ? (form.promised_payment_date || null) : null,
        payment: null,
      };

      if (needsPayment) {
        if (form.payment_method === 'gcash' && paymentStep === 'waiting' && !form.payment_reference) {
          // A PayMongo QR is live — the webhook writes the ledger row.
          // Send no payment payload so we don't double-count it.
          payload.payment_method = 'gcash';
        } else if (collectedNow > 0) {
          payload.payment_method = form.payment_method;
          payload.payment = {
            amount: collectedNow,
            payment_date: form.payment_method === 'gcash' ? (form.payment_date || null) : null,
            receipt_url: form.payment_method === 'gcash' ? receiptUrl : null,
          };
          if (form.payment_method === 'gcash') {
            payload.payment_reference = form.payment_reference;
          }
        }
        // collectedNow === 0 → nothing collected at the door. No ledger row;
        // the full balance rides on the order against the Promise Date.
      }

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

        <div className="modal-body modal-body-scroll">
          <div className="pickup-summary-card summary-card-secondary flex justify-between items-center mb-20">
            <div>
              <div className="fw-700 text-accent">{order.tracking_number}</div>
              <div className="text-secondary" style={{ fontSize: '0.8125rem' }}>
                Deliver to: {order.receiver_name}
              </div>
            </div>
            {needsPayment && (
              <div className="text-error fw-700">
                Collect: ₱{balance.toFixed(2)}
              </div>
            )}
          </div>

          {error && (
            <div style={{
              background: 'var(--error-bg)', color: 'var(--error-dark)', padding: '10px 14px',
              borderRadius: 8, fontSize: '0.8125rem', marginBottom: 16, border: '1px solid var(--error)',
            }} role="alert">
              {error}
            </div>
          )}

          {needsPayment && (
            <div className="mb-20" style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 16 }}>
              <div className="flex items-center gap-8 mb-12" style={{ color: 'var(--error-text)' }}>
                <AlertTriangle size={16} />
                <span className="fw-600">Payment Collection Required</span>
              </div>
              
              {/* How much is actually being collected right now. */}
              <div className="form-group mb-12">
                <label className="form-label" htmlFor="dm-amount-collected">Amount Collected (₱) *</label>
                <div className="flex gap-8">
                  <input
                    id="dm-amount-collected"
                    type="number"
                    className="form-input flex-1"
                    value={form.amount_paid}
                    onChange={e => setForm(p => ({ ...p, amount_paid: e.target.value }))}
                    min="0"
                    max={balance}
                    step="0.01"
                    placeholder="0.00"
                  />
                  <button
                    type="button"
                    className="btn btn-outline btn-sm"
                    onClick={() => setForm(p => ({ ...p, amount_paid: balance.toString() }))}
                  >
                    Collect full ₱{balance.toFixed(2)}
                  </button>
                </div>
                <div className="text-xs mt-4" style={{ color: balanceAfter > 0 ? 'var(--warning-dark)' : 'var(--success)' }}>
                  {balanceAfter > 0
                    ? `₱${balanceAfter.toFixed(2)} will still be owing after this.`
                    : 'This settles the order in full.'}
                </div>
              </div>

              {collectedNow > 0 && (
              <div className="form-group mb-12">
                <label className="form-label"><CreditCard size={14} className="inline mr-6" /> Payment Method *</label>
                <div className="pickup-segment-row flex gap-8">
                  {['cash', 'gcash'].map(m => (
                    <button
                      key={m} type="button"
                      className={`btn ${form.payment_method === m ? 'btn-secondary' : 'btn-outline'} btn-sm flex-1 justify-center text-capitalize`}
                      onClick={() => setForm(p => ({ ...p, payment_method: m }))}
                    >
                      {m === 'gcash' ? 'GCash' : 'Cash'}
                    </button>
                  ))}
                </div>
              </div>
              )}

              {/* Promise Date — required whenever cargo is handed over with a balance. */}
              {needsPromiseDate && (
                <div className="mb-12" style={{ background: 'var(--warning-bg)', borderRadius: 8, padding: 14, border: '1px solid var(--warning)' }}>
                  <div className="mb-8" style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--warning-dark)' }}>
                    <AlertTriangle size={14} className="inline mr-6" /> Promise to Pay
                  </div>
                  <div className="form-group mb-0">
                    <label className="form-label" htmlFor="dm-promised-date">
                      <Calendar size={14} className="inline mr-6" /> Promise Date *
                    </label>
                    <input
                      id="dm-promised-date"
                      type="date"
                      className="form-input"
                      value={form.promised_payment_date}
                      onChange={e => setForm(p => ({ ...p, promised_payment_date: e.target.value }))}
                      min={new Date().toISOString().split('T')[0]}
                    />
                  </div>
                  <div className="text-xs mt-8" style={{ color: 'var(--warning-dark)' }}>
                    The cargo may be handed over, but ₱{balanceAfter.toFixed(2)} remains owing.
                    This order will stay unsettled and its trip cannot be completed until it is paid.
                  </div>
                </div>
              )}

              {collectedNow > 0 && form.payment_method === 'gcash' && (
                <div style={{ background: 'var(--bg-secondary)', borderRadius: 8, padding: 14, marginTop: 12 }}>
                  <div className="mb-8" style={{ fontSize: '0.8125rem', fontWeight: 600 }}>GCash Payment</div>
                  
                  {/* === PayMongo Automated Flow === */}
                  {paymentStep === 'setup' && (
                    <div className="mb-12">
                      <button
                        type="button"
                        className="btn btn-primary btn-sm w-full justify-center"
                        onClick={handleProceedToGCash}
                        disabled={balance <= 0}
                      >
                        <CreditCard size={14} className="mr-6" /> Process via PayMongo
                      </button>
                      <div className="text-xs text-tertiary mt-4" style={{ textAlign: 'center' }}>Opens GCash checkout for the customer to pay</div>
                    </div>
                  )}

                  {paymentStep === 'generating' && (
                    <div className="flex items-center gap-8 mb-12" style={{ padding: '10px 0' }}>
                      <Loader size={16} className="animate-spin" style={{ color: 'var(--primary-text)' }} />
                      <span className="text-sm">Generating GCash checkout link…</span>
                    </div>
                  )}

                  {paymentStep === 'waiting' && checkoutUrl && (
                    <div className="mb-12" style={{ background: 'var(--info-bg)', borderRadius: 8, padding: 12, border: '1px solid var(--info)' }}>
                      <div className="flex flex-col items-center gap-8 mb-16">
                        <div style={{ background: 'white', padding: 8, borderRadius: 8 }}>
                          <QRCode value={checkoutUrl} size={150} />
                        </div>
                        <span className="text-sm fw-600" style={{ color: 'var(--info-dark)' }}>Scan to Pay via GCash</span>
                      </div>
                      <div className="text-xs text-tertiary mb-16" style={{ textAlign: 'center' }}>
                        Payment link generated. The order will be automatically marked as paid once the customer completes the transaction. You can now confirm the delivery.
                      </div>
                      <button
                        type="button"
                        className="btn btn-outline btn-sm w-full justify-center"
                        onClick={() => {
                          navigator.clipboard.writeText(checkoutUrl);
                        }}
                      >
                        Copy Payment Link
                      </button>
                    </div>
                  )}

                  {/* === Manual Reference Fallback === */}
                  {paymentStep !== 'waiting' && (
                    <>
                      <div className="text-xs text-tertiary mb-8" style={{ textAlign: 'center', borderTop: '1px solid var(--border)', paddingTop: 10 }}>Or enter payment details manually</div>
                      <div className="form-group mb-12">
                        <label className="form-label" htmlFor="delivery-payment-reference">Reference Number *</label>
                        <input
                          id="delivery-payment-reference"
                          type="text"
                          className="form-input"
                          placeholder="Enter GCash Ref No."
                          value={form.payment_reference}
                          onChange={e => setForm(p => ({ ...p, payment_reference: e.target.value }))}
                        />
                      </div>
                      <div className="form-group mb-12">
                        <label className="form-label" htmlFor="dl-payment-date">Payment Date *</label>
                        <input
                          id="dl-payment-date"
                          type="date"
                          className="form-input"
                          value={form.payment_date}
                          onChange={e => setForm(p => ({ ...p, payment_date: e.target.value }))}
                          max={new Date().toISOString().split('T')[0]}
                        />
                      </div>
                      <div className="form-group mb-0">
                        <label className="form-label">Receipt Screenshot (Optional)</label>
                        <p className="text-xs text-tertiary mb-8">Receipt screenshot is optional and should only be uploaded if requested by the administrator or if additional proof is needed.</p>
                        {receiptPreview ? (
                          <div className="relative overflow-hidden mb-8" style={{ width: 90, height: 90, borderRadius: 8, border: '2px solid var(--border)' }}>
                            <img src={receiptPreview} alt="Receipt" className="w-full h-full" style={{ objectFit: 'cover' }} />
                            <button type="button" onClick={() => { setReceiptPhoto(null); setReceiptPreview(null); }} className="pickup-photo-remove-btn" aria-label="Remove receipt">
                              <Trash2 size={12} />
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button" onClick={() => receiptInputRef.current?.click()}
                            style={{ padding: '8px 16px', borderRadius: 8, border: '1px dashed var(--border)', background: 'transparent', cursor: 'pointer', fontSize: '0.8125rem' }}
                          >
                            <FileText size={14} className="inline mr-6" /> Upload Receipt
                          </button>
                        )}
                        <input ref={receiptInputRef} type="file" accept="image/jpeg,image/png,image/webp" onChange={handleReceiptAdd} style={{ display: 'none' }} />
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="form-group mb-0">
            <label className="form-label">
              <Camera size={14} className="inline mr-6" />
              Delivery Proof Photos * (1-3)
            </label>
            <div className="flex gap-10 flex-wrap mt-8">
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
            <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={handlePhotoAdd} style={{ display: 'none' }} />
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn btn-outline" onClick={onClose} disabled={saving || paymentStep === 'generating'}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSubmit} disabled={saving || (needsPayment && collectedNow > 0 && form.payment_method === 'gcash' && paymentStep !== 'waiting' && !(form.payment_reference && form.payment_reference.trim()))}>
            {saving ? <><Loader size={16} className="animate-spin" /> {uploadProgress || 'Processing...'}</> : <><CheckCircle size={16} /> Complete Delivery</>}
          </button>
        </div>
      </div>
    </div>
    </FocusTrap>
  );
};

export default DeliveryModal;
