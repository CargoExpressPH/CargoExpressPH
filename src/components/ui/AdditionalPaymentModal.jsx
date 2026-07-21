import { useState, useRef, useEffect } from 'react';
import { X, Loader, Smartphone, AlertTriangle, CreditCard, FileText, Trash2, CheckCircle } from 'lucide-react';
import FocusTrap from './FocusTrap';
import { uploadPhoto } from '../../lib/storage';

/**
 * AdditionalPaymentModal — Manually collects additional payments for remaining balances.
 */
const AdditionalPaymentModal = ({ order, remainingBalance, onClose, onSave }) => {
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

  const receiptInputRef = useRef(null);

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
      if (!form.payment_reference) {
        setError('Reference number is required for GCash');
        return;
      }
      if (!form.payment_date) {
        setError('Payment date is required for GCash');
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
                <div className="form-group mb-12">
                  <label className="form-label">Reference Number *</label>
                  <input
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
              </div>
            )}

            <div className="form-group mb-0">
              <label className="form-label">Admin Notes (Optional)</label>
              <textarea
                className="form-input"
                placeholder="E.g., Collected by Juan"
                value={form.notes}
                onChange={e => setForm(p => ({ ...p, notes: e.target.value }))}
                rows={2}
              />
            </div>
          </div>
          
          <div className="modal-footer">
            <button className="btn btn-outline" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? <><Loader size={16} className="animate-spin" /> {uploadProgress || 'Saving...'}</> : <><CheckCircle size={16} /> Record Payment</>}
            </button>
          </div>
        </div>
      </div>
    </FocusTrap>
  );
};

export default AdditionalPaymentModal;
