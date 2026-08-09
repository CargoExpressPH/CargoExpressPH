import { useState, useRef, useEffect } from 'react';
import { X, Loader, Smartphone, AlertTriangle, CreditCard, FileText, Trash2, CheckCircle } from 'lucide-react';
import FocusTrap from './FocusTrap';
import AmountInput from './AmountInput';
import useScrollLock from '../../hooks/useScrollLock';
import { sanitizeAmount, parseAmount } from '../../utils/currencyInput';
import { uploadPhoto } from '../../lib/storage';
import QRCode from 'react-qr-code';
import { createGCashSource, registerSource } from '../../lib/paymongo';

/**
 * AdditionalPaymentModal — Manually collects additional payments for remaining balances.
 */
const AdditionalPaymentModal = ({ order, remainingBalance, onClose, onSave }) => {
  useScrollLock(true); // mounted only while open

  const [form, setForm] = useState({
    // Stored unformatted; AmountInput adds the thousands separators for display.
    amount: sanitizeAmount(remainingBalance),
    payment_method: 'cash',
    notes: '',
    payment_reference: '',
    payment_date: new Date().toISOString().split('T')[0],
  });
  
  const [receiptPhoto, setReceiptPhoto] = useState(null);
  const [receiptPreview, setReceiptPreview] = useState(null);

  const [saving, setSaving] = useState(false);
  const [uploadProgress, setUploadProgress] = useState('');
  const [error, setError] = useState(null);

  // PayMongo GCash flow states
  const [paymentStep, setPaymentStep] = useState('setup');
  const [paymongoSourceId, setPaymongoSourceId] = useState(null);
  const [checkoutUrl, setCheckoutUrl] = useState(null);

  const receiptInputRef = useRef(null);

  /**
   * Amount validation, evaluated on every render rather than only on submit.
   * The balance is the ceiling the database enforces, so the field must say so
   * while the admin is still typing — a green border on ₱1000 against a ₱600
   * balance tells them the entry is good right up until it is rejected.
   */
  const amountValue = parseAmount(form.amount);
  const amountEntered = form.amount !== '' && form.amount !== null;
  let amountError = null;
  if (amountEntered) {
    if (Number.isNaN(amountValue)) {
      amountError = 'Enter a valid amount.';
    } else if (amountValue <= 0) {
      amountError = 'Amount must be greater than ₱0.';
    } else if (amountValue > remainingBalance) {
      amountError = `Amount cannot exceed the ₱${remainingBalance.toFixed(2)} remaining balance.`;
    }
  }
  const amountValid = amountEntered && !amountError;

  // GCash QR generated and no manual reference typed: the footer button only
  // dismisses the modal — the webhook records the payment, not this form.
  const isDoneStep =
    form.payment_method === 'gcash' &&
    paymentStep === 'waiting' &&
    !form.payment_reference;

  const handleProceedToGCash = async () => {
    try {
      setPaymentStep('generating');
      setError('');
      const amount = (parseAmount(form.amount) || 0);
      if (amount <= 0) {
        setError('Payment amount must be greater than 0.');
        setPaymentStep('setup');
        return;
      }
      const billing = {
        name: order.sender_name, // Defaulting to sender for additional payments
        phone: order.sender_phone,
      };
      
      const source = await createGCashSource(amount, `Cargo Express PH - ${order.tracking_number} Additional Payment`, billing, true);
      await registerSource(source.sourceId, amount, { orderId: order.id });
      
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

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

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

  const handleSave = async () => {
    setError(null);

    // QR hand-off: PayMongo's webhook writes the transaction. Inserting one
    // here too would double-count the payment. Nothing to validate, nothing
    // to save — just close.
    if (isDoneStep) {
      onClose();
      return;
    }

    const amount = (parseAmount(form.amount) || 0);
    if (amountError || !amountValid) {
      setError(amountError || `Amount must be between ₱1 and ₱${remainingBalance.toFixed(2)}`);
      return;
    }

    if (form.payment_method === 'gcash') {
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

    setSaving(true);

    try {
      let receiptUrl = null;
      if (receiptPhoto) {
        setUploadProgress('Uploading receipt...');
        const rResult = await uploadPhoto(receiptPhoto, 'receipts', order.tracking_number, 1);
        receiptUrl = rResult.path || rResult.url;
      }
      setUploadProgress('Saving...');

      // onSave signature in OrderDetailPage:
      //   (amount, method, reference, notes, date, receiptUrl)
      await onSave(
        amount, 
        form.payment_method, 
        form.payment_method === 'gcash' ? form.payment_reference : null, 
        form.notes,
        form.payment_method === 'gcash' ? form.payment_date : null,
        receiptUrl
      );
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <FocusTrap active>
      <div className="modal-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="add-payment-modal-title">
        <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 450 }}>
          <div className="modal-header">
            <h3 id="add-payment-modal-title">Record Payment</h3>
            <button className="btn-icon btn-ghost" onClick={onClose} aria-label="Close record payment modal"><X size={20} aria-hidden="true" /></button>
          </div>
          
          <div className="modal-body" style={{ maxHeight: '70vh', overflowY: 'auto' }}>
            {error && (
              <div className="mb-16 p-12 text-sm" style={{ background: 'var(--error-bg)', color: 'var(--error-dark)', borderRadius: 8, border: '1px solid var(--error)' }}>
                {error}
              </div>
            )}
            
            <div className="flex justify-between items-center mb-20" style={{ background: 'var(--bg-secondary)', padding: '12px 16px', borderRadius: 8 }}>
              <div>
                <div className="text-sm text-secondary">Remaining Balance</div>
                <div className="text-xl fw-700 text-error">₱{remainingBalance.toFixed(2)}</div>
              </div>
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="ap-amount">Amount to Pay (₱) *</label>
              <AmountInput
                id="ap-amount"
                className={`form-input ${amountError ? 'field-invalid' : amountValid ? 'field-valid' : ''}`}
                value={form.amount}
                onValueChange={v => setForm(p => ({ ...p, amount: v }))}
                aria-invalid={amountError ? 'true' : 'false'}
                aria-describedby={amountError ? 'ap-amount-error' : undefined}
              />
              {amountError && (
                <div className="field-error-inline" id="ap-amount-error" role="alert">
                  <AlertTriangle size={13} aria-hidden="true" /> {amountError}
                </div>
              )}
            </div>

            <div className="form-group">
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

            {form.payment_method === 'gcash' && (
              <div className="mb-16" style={{ background: 'var(--bg-secondary)', borderRadius: 8, padding: 14, border: '1px solid var(--border)' }}>
                <div className="mb-8" style={{ fontSize: '0.8125rem', fontWeight: 600 }}>GCash Payment Details</div>
                
                {/* === PayMongo Automated Flow === */}
                {paymentStep === 'setup' && (
                  <div className="mb-12">
                    <button
                      type="button"
                      className="btn btn-primary btn-sm w-full justify-center"
                      onClick={handleProceedToGCash}
                      disabled={!amountValid}
                    >
                      <CreditCard size={14} className="mr-6" /> Process via PayMongo
                    </button>
                    <div className="text-xs text-tertiary mt-4" style={{ textAlign: 'center' }}>Opens GCash checkout for the customer to pay</div>
                  </div>
                )}

                {paymentStep === 'generating' && (
                  <div className="flex items-center gap-8 mb-12" style={{ padding: '10px 0' }}>
                    <Loader size={16} className="animate-spin" style={{ color: 'var(--primary)' }} />
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
                      Payment link generated. The payment will be automatically recorded once the customer completes the transaction. You can now close this window.
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
                      <label className="form-label" htmlFor="addl-payment-reference">Reference Number *</label>
                      <input
                        id="addl-payment-reference"
                        type="text"
                        className="form-input"
                        placeholder="Enter GCash Ref No."
                        value={form.payment_reference}
                        onChange={e => setForm(p => ({ ...p, payment_reference: e.target.value }))}
                      />
                    </div>
                <div className="form-group mb-12">
                  <label className="form-label" htmlFor="ap-payment-date">Payment Date *</label>
                  <input
                    id="ap-payment-date"
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
                      type="button"
                      onClick={() => receiptInputRef.current?.click()}
                      style={{
                        padding: '8px 16px', borderRadius: 8, border: '1px dashed var(--border)',
                        background: 'transparent', cursor: 'pointer', fontSize: '0.8125rem'
                      }}
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

            <div className="form-group mb-0">
              <label className="form-label" htmlFor="addl-payment-notes">Admin Notes (Optional)</label>
              <textarea
                id="addl-payment-notes"
                className="form-input"
                placeholder="E.g., Collected by Juan"
                value={form.notes}
                onChange={e => setForm(p => ({ ...p, notes: e.target.value }))}
                rows={2}
              />
            </div>
          </div>
          
          <div className="modal-footer">
            <button className="btn btn-outline" onClick={onClose} disabled={saving || paymentStep === 'generating'}>Cancel</button>
            {/* `isDoneStep` is the QR hand-off: nothing is being recorded, the
                webhook will. Amount validity is irrelevant to closing it. */}
            <button
              className="btn btn-primary"
              onClick={handleSave}
              disabled={
                saving ||
                (!isDoneStep && !amountValid) ||
                (form.payment_method === 'gcash' && paymentStep !== 'waiting' && !(form.payment_reference && form.payment_reference.trim()))
              }
            >
              {saving ? <><Loader size={16} className="animate-spin" /> {uploadProgress || 'Saving...'}</> : <><CheckCircle size={16} /> {isDoneStep ? 'Done' : 'Record Payment'}</>}
            </button>
          </div>
        </div>
      </div>
    </FocusTrap>
  );
};

export default AdditionalPaymentModal;
