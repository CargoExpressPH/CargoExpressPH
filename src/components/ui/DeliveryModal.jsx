import { useState, useRef, useEffect } from 'react';
import { X, Camera, Loader, Package, CreditCard, CheckCircle, Smartphone, AlertTriangle, Trash2, FileText, Upload } from 'lucide-react';
import FocusTrap from './FocusTrap';
import { uploadMultiplePhotos, uploadPhoto } from '../../lib/storage';

/**
 * DeliveryModal — Admin delivery processing modal
 * Captures photos and GCash fields if unpaid
 */
const DeliveryModal = ({ order, onClose, onSave }) => {
  const isPaid = order.payment_status === 'paid';
  const balance = parseFloat(order.remaining_balance || 0);
  const needsPayment = !isPaid && balance > 0;

  const [form, setForm] = useState({
    amount_paid: needsPayment ? balance.toString() : '0',
    payment_method: needsPayment ? 'cash' : '',
    payment_reference: '',
    payment_date: new Date().toISOString().split('T')[0],
  });

  const [photos, setPhotos] = useState([]);
  const [photoPreviews, setPhotoPreviews] = useState([]);

  const [receiptPhoto, setReceiptPhoto] = useState(null);
  const [receiptPreview, setReceiptPreview] = useState(null);

  const [saving, setSaving] = useState(false);
  const [uploadProgress, setUploadProgress] = useState('');
  const [error, setError] = useState('');

  const fileInputRef = useRef(null);
  const receiptInputRef = useRef(null);

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

    if (needsPayment && form.payment_method === 'gcash') {
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

      const updates = {
        status: 'Delivered',
        delivery_photos: photoUrls,
      };

      if (needsPayment) {
        updates.amount_paid = balance; // Ensure amount is passed to onSave
        updates.payment_method = form.payment_method;
        updates.payment_status = 'paid';
        updates.remaining_balance = 0;
        if (form.payment_method === 'gcash') {
          updates.payment_reference = form.payment_reference;
          updates.payment_date = form.payment_date;
          updates.receipt_url = receiptUrl;
        }
      }

      await onSave(updates);
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
    <div className="modal-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="delivery-modal-title">
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 500 }}>
        <div className="modal-header">
          <h3 id="delivery-modal-title"><Package size={18} aria-hidden="true" /> Confirm Delivery</h3>
          <button type="button" className="btn-icon btn-ghost" onClick={onClose} aria-label="Close delivery modal"><X size={20} aria-hidden="true" /></button>
        </div>

        <div className="modal-body" style={{ maxHeight: '70vh', overflowY: 'auto' }}>
          <div className="pickup-summary-card flex justify-between items-center mb-20" style={{
            background: 'var(--bg-secondary)', borderRadius: 8, padding: 14,
          }}>
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
              <div className="flex items-center gap-8 mb-12" style={{ color: 'var(--error)' }}>
                <AlertTriangle size={16} />
                <span className="fw-600">Payment Collection Required</span>
              </div>
              
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

              {form.payment_method === 'gcash' && (
                <div style={{ background: 'var(--bg-secondary)', borderRadius: 8, padding: 14, marginTop: 12 }}>
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
                        <button type="button" onClick={() => { setReceiptPhoto(null); setReceiptPreview(null); }} className="pickup-photo-remove-btn">
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
          <button className="btn btn-outline" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSubmit} disabled={saving}>
            {saving ? <><Loader size={16} className="animate-spin" /> {uploadProgress || 'Processing...'}</> : <><CheckCircle size={16} /> Complete Delivery</>}
          </button>
        </div>
      </div>
    </div>
    </FocusTrap>
  );
};

export default DeliveryModal;
