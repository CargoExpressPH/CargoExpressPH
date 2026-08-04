import { useState, useRef, useEffect } from 'react';
import { X, Loader, Smartphone, AlertTriangle, CreditCard, FileText, Trash2, CheckCircle } from 'lucide-react';
import FocusTrap from './FocusTrap';
import useScrollLock from '../../hooks/useScrollLock';
import { uploadPhoto } from '../../lib/storage';
import QRCode from 'react-qr-code';
import { createGCashSource, registerSource } from '../../lib/paymongo';

/**
 * AdditionalPaymentModal — Manually collects additional payments for remaining balances.
 */
const AdditionalPaymentModal = ({ order, remainingBalance, onClose, onSave }) => {
  useScrollLock(true); // mounted only while open

  const [form, setForm] = useState({
    amount: remainingBalance.toString(),
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

  const handleProceedToGCash = async () => {
    try {
      setPaymentStep('generating');
      setError('');
      const amount = parseFloat(form.amount || 0);
      if (amount <= 0) {
        setError('Payment amount must be greater than 0.');
        setPaymentStep('setup');
        return;
      }
      const billing = {
        name: order.sender_name, // Defaulting to sender for additional payments
        phone: order.sender_phone,
      };
      
      const source = await createGCashSource(amount, `CargoExpress - ${order.tracking_number} Additional Payment`, billing, true);
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
    const amount = parseFloat(form.amount || 0);
    if (amount <= 0 || amount > remainingBalance) {
      setError(`Amount must be between ₱1 and ₱${remainingBalance}`);
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

      // Passed arguments matching the onSave signature expected by the parent.
      // Parent might need update to accept extra parameters (date, receipt)
      // For now we pass them as additional arguments.
      // onSave signature in OrderDetailPage: (amount, method, ref, notes, date, receiptUrl)
      // For PayMongo QR, we pass a special reference 'PAYMONGO_PENDING' so the parent knows not to mark it as fully paid yet.
      // Wait, OrderDetailPage's handleSaveAdditionalPayment expects a transaction_reference.
      // We'll pass the sourceId if it's PayMongo, but we need to ensure the parent handles it.
      // Since it's 'waiting', we don't want the frontend to insert into payment_transactions directly!
      // But the frontend `handleSaveAdditionalPayment` blindly calls `addPaymentTransaction`.
      // If we insert into `payment_transactions` with status 'paid', it's wrong!
      // So if it's 'waiting', we MUST return from the modal with a flag or status 'unpaid' / 'pending'.
      // Actually, if we just let the webhook handle it, we can just close the modal without inserting anything!
      if (form.payment_method === 'gcash' && paymentStep === 'waiting' && !form.payment_reference) {
        onClose();
        return; // Don't call onSave, the webhook will insert the transaction and update the order
      }

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
              <input
                id="ap-amount"
                type="number"
                className="form-input"
                value={form.amount}
                onChange={e => setForm(p => ({ ...p, amount: e.target.value }))}
                max={remainingBalance}
                min="1"
              />
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
                      disabled={parseFloat(form.amount || 0) <= 0}
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
            <button className="btn btn-primary" onClick={handleSave} disabled={saving || (form.payment_method === 'gcash' && paymentStep !== 'waiting' && !(form.payment_reference && form.payment_reference.trim()))}>
              {saving ? <><Loader size={16} className="animate-spin" /> {uploadProgress || 'Saving...'}</> : <><CheckCircle size={16} /> {paymentStep === 'waiting' && !form.payment_reference ? 'Done' : 'Record Payment'}</>}
            </button>
          </div>
        </div>
      </div>
    </FocusTrap>
  );
};

export default AdditionalPaymentModal;
