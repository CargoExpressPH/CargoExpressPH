import { useState, useRef } from 'react';
import { X, Camera, Loader, Scale, CreditCard, Calendar, Upload, Trash2, Package, AlertTriangle, CheckCircle, FileText } from 'lucide-react';
import FocusTrap from './FocusTrap';
import { uploadMultiplePhotos, uploadPhoto } from '../../lib/storage';
import QRCode from 'react-qr-code';
import { createGCashSource, checkPaymentStatus, createPayment } from '../../lib/paymongo';
import { useEffect } from 'react';

/**
 * PickupModal — Admin pickup processing modal
 * Captures: actual weight, payment method, payment amount, photos, and manual GCash reference
 */
const PickupModal = ({ order, onClose, onSave, pricePerKilo = 70 }) => {
  const [form, setForm] = useState({
    actual_weight: order?.actual_weight || order?.package_weight || '',
    payment_type: (order?.payment_status === 'partial' || order?.payment_status === 'unpaid' || order?.payment_method === 'paylater') ? 'paylater' : 'full',
    payment_method: (order?.payment_method === 'paylater') ? '' : (order?.payment_method || ''),
    amount_paid: order?.amount_paid || '',
    payer_type: order?.payer_type || 'sender',
    promised_payment_date: order?.promised_payment_date || '',
    payment_reference: '',
    payment_date: new Date().toISOString().split('T')[0],
  });
  
  const [photos, setPhotos] = useState([]);
  const [photoPreviews, setPhotoPreviews] = useState([]);
  
  const [receiptPhoto, setReceiptPhoto] = useState(null);
  const [receiptPreview, setReceiptPreview] = useState(null);

  // PayMongo GCash flow states
  const [paymentStep, setPaymentStep] = useState('setup');
  const [paymongoSourceId, setPaymongoSourceId] = useState(null);
  const [checkoutUrl, setCheckoutUrl] = useState(null);
  const [paymentDetails, setPaymentDetails] = useState(null);
  
  const [saving, setSaving] = useState(false);
  const [uploadProgress, setUploadProgress] = useState('');
  const [error, setError] = useState('');
  
  const fileInputRef = useRef(null);
  const receiptInputRef = useRef(null);

  const isPayLater = form.payment_type === 'paylater';
  const estimatedCost = parseFloat(form.actual_weight || 0) * pricePerKilo;
  const amountPaid = parseFloat(form.amount_paid || 0);
  const remainingBalance = Math.max(0, estimatedCost - amountPaid);

  const handleProceedToGCash = async () => {
    try {
      setPaymentStep('generating');
      setError('');
      const amount = isPayLater ? parseFloat(form.amount_paid || 0) : estimatedCost;
      if (amount <= 0) {
        setError('Payment amount must be greater than 0.');
        setPaymentStep('setup');
        return;
      }
      const billing = {
        name: form.payer_type === 'sender' ? order.sender_name : order.receiver_name,
        phone: form.payer_type === 'sender' ? order.sender_phone : order.receiver_phone,
      };
      
      const source = await createGCashSource(amount, `CargoExpress - ${order.tracking_number} Pickup`, billing, true);
      setPaymongoSourceId(source.sourceId);
      setCheckoutUrl(source.checkoutUrl);
      setPaymentStep('waiting');
    } catch (err) {
      setError(err.message);
      setPaymentStep('setup');
    }
  };

  useEffect(() => {
    if (paymentStep !== 'waiting' || !paymongoSourceId) return;

    let interval;
    let isChecking = false;

    const checkStatus = async () => {
      if (isChecking) return;
      isChecking = true;
      try {
        const res = await checkPaymentStatus(paymongoSourceId);
        if (res.status === 'chargeable') {
          clearInterval(interval);
          try {
            const amount = isPayLater ? parseFloat(form.amount_paid || 0) : estimatedCost;
            const paymentRes = await createPayment(paymongoSourceId, amount, `CargoExpress - ${order.tracking_number} Pickup`);
            setPaymentDetails({
              reference: paymentRes.paymentId,
              amount: paymentRes.amount,
              date: new Date().toISOString().split('T')[0],
              time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
              status: paymentRes.status
            });
            setPaymentStep('successful');
          } catch (err) {
            setError(err.message);
            setPaymentStep('failed');
          }
        } else if (res.status === 'failed' || res.status === 'expired' || res.status === 'cancelled') {
          clearInterval(interval);
          setPaymentStep(res.status === 'expired' ? 'expired' : 'failed');
        }
      } catch (err) {
        console.error('Error checking payment status:', err);
      } finally {
        isChecking = false;
      }
    };

    interval = setInterval(checkStatus, 3000);
    return () => clearInterval(interval);
  }, [paymentStep, paymongoSourceId, isPayLater, form.amount_paid, estimatedCost, order.tracking_number]);

  const handlePhotoAdd = (e) => {
    const newFiles = Array.from(e.target.files || []);
    const total = photos.length + newFiles.length;
    if (total > 3) {
      setError('Maximum 3 pickup photos allowed');
      return;
    }

    const validFiles = newFiles.filter(f => {
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(f.type)) {
        setError('Only JPG, PNG, and WebP images allowed');
        return false;
      }
      return true;
    });

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

    if (!form.actual_weight || parseFloat(form.actual_weight) <= 0) {
      setError('Please enter the actual weight');
      return;
    }
    if (!form.payment_method) {
      setError('Please select a payment method');
      return;
    }
    if (form.payment_method === 'gcash') {
      if (paymentStep !== 'successful' || !paymentDetails) {
        setError('Please complete the GCash payment first');
        return;
      }
    }
    if (photos.length === 0) {
      setError('At least 1 pickup proof photo is required');
      return;
    }
    if (isPayLater && !form.promised_payment_date) {
      setError('Please set a promised payment date for Pay Later');
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
      if (receiptPhoto) {
        setUploadProgress('Uploading receipt...');
        const rResult = await uploadPhoto(receiptPhoto, 'receipts', order.tracking_number, 1);
        receiptUrl = rResult.path || rResult.url;
      }

      setUploadProgress('Processing Payment...');

      let paymentStatus = 'paid';
      let finalAmountPaid = parseFloat(form.amount_paid || 0);
      
      if (isPayLater) {
        paymentStatus = finalAmountPaid > 0 ? 'partial' : 'unpaid';
      } else {
        if (!form.amount_paid && form.amount_paid !== "0") {
          finalAmountPaid = estimatedCost;
          paymentStatus = 'paid';
        } else {
          paymentStatus = estimatedCost > finalAmountPaid ? 'partial' : 'paid';
        }
      }

      const finalRemaining = Math.max(0, estimatedCost - finalAmountPaid);

      const updates = {
        actual_weight: parseFloat(form.actual_weight),
        payment_method: form.payment_method,
        payer_type: form.payer_type,
        amount_paid: finalAmountPaid,
        remaining_balance: finalRemaining,
        payment_status: paymentStatus,
        payment_reference: form.payment_method === 'gcash' ? paymentDetails?.reference : null,
        payment_date: form.payment_method === 'gcash' ? paymentDetails?.date : null,
        receipt_url: receiptUrl,
        pickup_photos: photoUrls,
        promised_payment_date: isPayLater ? form.promised_payment_date : null,
        status: 'Picked Up',
      };

      await onSave(updates);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <FocusTrap active>
    <div className="modal-overlay" onClick={onClose} role="dialog" aria-modal="true">
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 560 }}>
        <div className="modal-header">
          <h3><Package size={18} /> Pickup Processing</h3>
          <button type="button" className="btn-icon btn-ghost" onClick={onClose}><X size={20} /></button>
        </div>

        <div className="modal-body" style={{ maxHeight: '70vh', overflowY: 'auto' }}>
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
              Est. {order.package_weight} kg
            </div>
          </div>

          {error && (
            <div style={{
              background: 'var(--error-bg)', color: 'var(--error-dark)', padding: '10px 14px',
              borderRadius: 8, fontSize: '0.8125rem', marginBottom: 16, border: '1px solid var(--error)',
            }} role="alert">
              {error}
            </div>
          )}

          {/* Actual Weight */}
          <div className="form-group">
            <label className="form-label">
              <Scale size={14} className="inline mr-6" />
              Actual Weight (kg) *
            </label>
            <input
              type="number"
              className="form-input"
              placeholder="Enter actual weight after weighing"
              value={form.actual_weight}
              onChange={e => setForm(p => ({ ...p, actual_weight: e.target.value }))}
              step="0.1" min="0.1"
            />
            {form.actual_weight && (
              <div className="text-xs text-success mt-4">
                Estimated cost: ₱{estimatedCost.toFixed(2)}
              </div>
            )}
          </div>

          {/* Payment Type */}
          <div className="form-group">
            <label className="form-label">
              <CreditCard size={14} className="inline mr-6" />
              Payment Type *
            </label>
            <div className="pickup-segment-row flex gap-8">
              {['full', 'paylater'].map(t => (
                <button
                  key={t} type="button"
                  className={`btn ${form.payment_type === t ? 'btn-primary' : 'btn-outline'} btn-sm flex-1 justify-center text-capitalize`}
                  onClick={() => setForm(p => ({ ...p, payment_type: t }))}
                >
                  {t === 'full' ? 'Full Payment' : 'Pay Later'}
                </button>
              ))}
            </div>
          </div>

          {/* Payment Method */}
          <div className="form-group">
            <label className="form-label">Payment Method *</label>
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

          {/* Payer Type */}
          <div className="form-group">
            <label className="form-label">Who Pays?</label>
            <div className="pickup-segment-row flex gap-8">
              {['sender', 'receiver'].map(t => (
                <button
                  key={t} type="button"
                  className={`btn ${form.payer_type === t ? 'btn-secondary' : 'btn-outline'} btn-sm flex-1 justify-center text-capitalize`}
                  onClick={() => setForm(p => ({ ...p, payer_type: t }))}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          {/* Amount Paid */}
          {(!isPayLater || isPayLater) && (
            <div className="form-group">
              <label className="form-label">{isPayLater ? 'Downpayment (₱) (Optional)' : 'Amount Received (₱) *'}</label>
              <input
                type="number"
                className="form-input"
                placeholder={isPayLater ? "0.00" : estimatedCost.toFixed(2)}
                value={form.amount_paid}
                onChange={e => setForm(p => ({ ...p, amount_paid: e.target.value }))}
                min="0"
              />
            </div>
          )}

          {/* GCash Details */}
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
                <label className="form-label">Payment Date *</label>
                <input
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

          {/* Pay Later Promised Date */}
          {isPayLater && (
            <div className="mb-16" style={{ background: 'var(--warning-bg)', borderRadius: 8, padding: 14, border: '1px solid var(--warning)' }}>
              <div className="mb-8" style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--warning-dark)' }}>
                <AlertTriangle size={14} className="inline mr-6" /> Pay Later Details
              </div>
              <div className="form-group mb-0">
                <label className="form-label"><Calendar size={14} className="inline mr-6" /> Promised Payment Date *</label>
                <input
                  type="date"
                  className="form-input"
                  value={form.promised_payment_date}
                  onChange={e => setForm(p => ({ ...p, promised_payment_date: e.target.value }))}
                  min={new Date().toISOString().split('T')[0]}
                />
              </div>
              <div className="text-xs mt-8" style={{ color: 'var(--warning-dark)' }}>
                Balance: ₱{remainingBalance.toFixed(2)}
              </div>
            </div>
          )}

          {/* Pickup Proofs */}
          <div className="form-group mt-16 mb-0">
            <label className="form-label">
              <Camera size={14} className="inline mr-6" />
              Pickup Proof Photos * (1-3)
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
          <button className="btn btn-outline" onClick={onClose} disabled={saving || (form.payment_method === 'gcash' && (paymentStep === 'generating' || paymentStep === 'waiting'))}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSubmit} disabled={saving || (form.payment_method === 'gcash' && paymentStep !== 'successful')}>
            {saving ? <><Loader size={16} className="animate-spin" /> {uploadProgress || 'Processing...'}</> : <><CheckCircle size={16} /> Confirm Pickup</>}
          </button>
        </div>
      </div>
    </div>
    </FocusTrap>
  );
};

export default PickupModal;
