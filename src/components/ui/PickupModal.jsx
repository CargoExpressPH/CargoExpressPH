import { useState, useRef, useEffect } from 'react';
import { X, XCircle, Camera, Loader, Scale, CreditCard, Calendar, Upload, Trash2, Package, AlertTriangle, CheckCircle, FileText, ExternalLink, RefreshCw } from 'lucide-react';
import FocusTrap from './FocusTrap';
import { uploadMultiplePhotos, uploadPhoto } from '../../lib/storage';
import QRCode from 'react-qr-code';
import { createGCashSource, registerSource, pollPaymentStatus } from '../../lib/paymongo';
import { supabase } from '../../lib/supabase';

/**
 * PickupModal — Admin pickup processing modal
 * Captures: actual weight, payment method, payment amount, photos, and manual GCash reference
 */
const PickupModal = ({ order, onClose, onSave, pricePerKilo = 70 }) => {
  const [form, setForm] = useState({
    actual_weight: order?.actual_weight || '',
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
  
  // Live confirmation that the customer completed the GCash payment.
  // null while waiting; populated once the ledger records the payment.
  const [paymentConfirmed, setPaymentConfirmed] = useState(null);
  const [checkingPayment, setCheckingPayment] = useState(false);

  const [saving, setSaving] = useState(false);
  const [uploadProgress, setUploadProgress] = useState('');
  const [error, setError] = useState('');
  // Non-error feedback (e.g. "checkout cancelled") — an error-styled banner
  // would misread as a failure when nothing failed.
  const [notice, setNotice] = useState('');

  const fileInputRef = useRef(null);
  const receiptInputRef = useRef(null);
  const paymongoIntervalRef = useRef(null);
  // amount_paid at the moment the QR was generated — anything above this is new money
  const baselinePaidRef = useRef(parseFloat(order?.amount_paid || 0));

  // ── Billing mode ─────────────────────────────────────────────────────────
  // Freight Prepaid  (payer_type = 'sender')   → money is collected HERE, at pickup.
  // Freight Collect  (payer_type = 'receiver') → money is collected at DELIVERY,
  //                                              from someone who is not present now.
  //
  // Collect is the industry-standard COD arrangement: the carrier's security is
  // possession of the cargo, so there is nothing to collect at pickup and the
  // driver must never be asked to. Previously payer_type only picked a billing
  // name for the PayMongo source and payment_method was required regardless, so
  // the only way to process a receiver-pays pickup was to abuse "Pay Later ₱0".
  const isPrepaid = form.payer_type === 'sender';
  const isPayLater = isPrepaid && form.payment_type === 'paylater';
  const estimatedCost = parseFloat(form.actual_weight || 0) * pricePerKilo;
  const amountPaid = parseFloat(form.amount_paid || 0);
  const remainingBalance = Math.max(0, estimatedCost - amountPaid);

  // ── GCash settlement gate ────────────────────────────────────────────────
  // A live PayMongo checkout is an OPEN question: the customer may still be
  // paying, may abandon, or may already have paid without us having heard yet.
  // Confirming the pickup inside that window is the race — the parcel is
  // released while the webhook is still deciding, so the cargo can leave with
  // money that was never collected and never promised.
  //
  // The button therefore stays locked until the question is ANSWERED:
  //   authorised → paymentConfirmed is populated from the reconciled order row
  //   cancelled  → the admin abandons the checkout (below) and falls back to
  //                cash or a manual GCash reference
  const hasManualReference = Boolean(form.payment_reference && form.payment_reference.trim());
  const gcashUnresolved =
    isPrepaid && form.payment_method === 'gcash' && !paymentConfirmed && !hasManualReference;

  const handleProceedToGCash = async () => {
    try {
      setPaymentStep('generating');
      setError('');
      setNotice('');
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
      await registerSource(source.sourceId, amount, { orderId: order.id, actualWeight: parseFloat(form.actual_weight), payerType: form.payer_type });
      
      // Anything paid above this baseline is money from THIS checkout.
      baselinePaidRef.current = parseFloat(order?.amount_paid || 0);
      setPaymentConfirmed(null);
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
    setPaymentDetails(null);
    setPaymentConfirmed(null);
    setError('');
  };

  /**
   * Abandon a pending GCash checkout — the "cancelled" half of the gate above.
   *
   * The PayMongo source is deliberately NOT voided: if the customer pays that
   * link ten minutes from now, the webhook still reconciles it against this
   * order and the ledger stays honest. Cancelling only says "we are not going
   * to stand here waiting for it" and re-opens cash / manual reference.
   */
  const handleCancelGCashPayment = () => {
    resetPayMongoFlow();
    setNotice(
      'GCash checkout cancelled. Collect in cash, or enter the GCash reference number manually. '
      + 'If the customer completes that payment link later, it is still recorded against this order.'
    );
  };

  /**
   * Records a confirmed payment from a fresh `orders` row.
   * Called by both the realtime subscription and the manual status check.
   */
  const applyConfirmedOrder = (row) => {
    const paid = parseFloat(row?.amount_paid || 0);
    if (!(paid > baselinePaidRef.current)) return false;
    setPaymentConfirmed({
      received: paid - baselinePaidRef.current,
      amountPaid: paid,
      remaining: parseFloat(row.remaining_balance || 0),
      status: row.payment_status,
      reference: row.payment_reference || null,
    });
    return true;
  };

  /**
   * (C) Manual "Check payment status".
   * Asks the server to re-query PayMongo and reconcile if the source is paid.
   * Also used as an automatic fallback poll while the QR is on screen, for the
   * case where the realtime event is missed.
   */
  const checkPaymentNow = async (silent = false) => {
    if (!paymongoSourceId || !order?.id) return;
    if (!silent) { setCheckingPayment(true); setError(''); }
    try {
      await pollPaymentStatus(paymongoSourceId, order.id).catch(() => null);
      // Read the authoritative totals back from the order row — the ledger
      // trigger owns them, so this is the truth regardless of what poll returned.
      const { data: fresh } = await supabase
        .from('orders')
        .select('amount_paid, remaining_balance, payment_status, payment_reference')
        .eq('id', order.id)
        .single();
      const found = applyConfirmedOrder(fresh);
      if (!found && !silent) {
        setError('No payment received yet. Ask the customer to complete the GCash payment, then check again.');
      }
    } catch (err) {
      if (!silent) setError(err.message || 'Could not check payment status.');
    } finally {
      if (!silent) setCheckingPayment(false);
    }
  };

  /**
   * (B) Live confirmation.
   * `orders` is already in the supabase_realtime publication, so the admin's
   * screen updates the moment the webhook reconciles the payment — even though
   * the customer paid on a different device. A 15s poll backs it up.
   */
  useEffect(() => {
    if (paymentStep !== 'waiting' || !order?.id || paymentConfirmed) return;

    const channel = supabase
      .channel(`pickup_payment_${order.id}`)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'orders',
        filter: `id=eq.${order.id}`,
      }, (payload) => applyConfirmedOrder(payload.new))
      .subscribe();

    paymongoIntervalRef.current = setInterval(() => checkPaymentNow(true), 15000);

    return () => {
      supabase.removeChannel(channel);
      if (paymongoIntervalRef.current) {
        clearInterval(paymongoIntervalRef.current);
        paymongoIntervalRef.current = null;
      }
    };
  }, [paymentStep, order?.id, paymongoSourceId, paymentConfirmed]);

  useEffect(() => {
    if (form.payment_method !== 'gcash' && (paymentStep !== 'setup' || paymongoSourceId || checkoutUrl)) {
      resetPayMongoFlow();
    }
  }, [form.payment_method]);

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
    // Payment validation applies to Prepaid only. On a Collect shipment there is
    // nobody here to pay, so demanding a payment method would be nonsensical.
    if (isPrepaid) {
      if (!form.payment_method) {
        setError('Please select a payment method');
        return;
      }
      if (form.payment_method === 'gcash') {
        if (paymentStep === 'generating') {
          setError('Wait for the GCash checkout link to finish generating.');
          return;
        }
        // Same gate as the disabled Confirm button, restated here because a
        // disabled button is a hint, not an enforcement point.
        if (gcashUnresolved) {
          setError(paymentStep === 'waiting'
            ? 'This GCash payment has not been confirmed yet. Wait for it to go through, or cancel the checkout and record the payment another way.'
            : 'Please generate a GCash QR or enter a manual reference number.');
          return;
        }
        if (hasManualReference && !form.payment_date) {
          setError('Please set the payment date for manual reference');
          return;
        }
      }
      if (isPayLater && !form.promised_payment_date) {
        setError('Please set a promised payment date for Pay Later');
        return;
      }
    }
    if (photos.length === 0) {
      setError('At least 1 pickup proof photo is required');
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

      // ─────────────────────────────────────────────────────────────────────
      // The GCash payment was settled through PayMongo, so the ledger row
      // already exists:
      //     PayMongo → paymongo-webhook → reconcile RPC
      //       → INSERT payment_transactions → trigger recomputes orders totals
      //
      // In that case we send NO payment payload at all. Sending one would
      // double-count, or (as it once did) overwrite a payment the customer
      // completed while the QR was on screen.
      //
      // Keyed on paymentConfirmed — proof the money landed — not on "a QR is
      // on screen", which was true of unpaid checkouts too.
      // ─────────────────────────────────────────────────────────────────────
      const settledByPayMongo = form.payment_method === 'gcash' && Boolean(paymentConfirmed);

      // Order metadata. amount_paid / remaining_balance / payment_status are
      // deliberately absent — the payment_transactions ledger owns them and
      // record_pickup_payment lets the trigger derive them.
      const payload = {
        actual_weight: parseFloat(form.actual_weight),
        // Collect: no method is chosen yet — it is decided at delivery, by the
        // receiver. Leaving it NULL is honest; picking one here would be a guess.
        payment_method: isPrepaid ? form.payment_method : null,
        payer_type: form.payer_type,
        pickup_photos: photoUrls,
        promised_payment_date: isPayLater ? form.promised_payment_date : null,
        payment_reference: (isPrepaid && form.payment_method === 'gcash') ? (form.payment_reference || null) : null,
        payment: null,
      };

      // Freight Collect — nothing is collected at pickup. The order leaves with
      // its full balance owing; DeliveryModal is the collection point.
      if (isPrepaid && !settledByPayMongo) {
        // How much is actually being collected right now.
        //   pay-later  → whatever the admin typed (may be 0 = nothing down)
        //   full       → the typed amount, or the full estimate if left blank
        let collected = parseFloat(form.amount_paid || 0);
        if (!isPayLater && !form.amount_paid && form.amount_paid !== '0') {
          collected = estimatedCost;
        }

        if (collected > 0) {
          payload.payment = {
            amount: collected,
            payment_date: form.payment_method === 'gcash' ? (form.payment_date || null) : null,
            receipt_url: receiptUrl,
          };
        }
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
    <div className="modal-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="pickup-modal-title">
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 560 }}>
        <div className="modal-header">
          <h3 id="pickup-modal-title"><Package size={18} aria-hidden="true" /> Pickup Processing</h3>
          <button type="button" className="btn-icon btn-ghost" onClick={onClose} aria-label="Close pickup modal"><X size={20} aria-hidden="true" /></button>
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
              {order.package_description || 'No description'}
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

          {notice && !error && (
            <div style={{
              background: 'var(--info-bg)', color: 'var(--info-dark)', padding: '10px 14px',
              borderRadius: 8, fontSize: '0.8125rem', marginBottom: 16, border: '1px solid var(--info)',
            }} role="status">
              {notice}
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
                {estimatedCost > 0 ? <>₱{estimatedCost.toFixed(2)} will be collected from </> : <>The freight charge will be collected from </>}
                <strong>{order?.receiver_name || 'the receiver'}</strong> on delivery.
                Weigh the parcel, take the proof photos, and confirm — there is nothing to collect now.
              </div>
            </div>
          )}

          {/* ── Prepaid: everything below is the collection UI ── */}
          {isPrepaid && (
          <>
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

          {/* Amount Paid */}
          <div className="form-group">
            <label className="form-label" htmlFor="pu-amount-paid">{isPayLater ? 'Downpayment (₱) (Optional)' : 'Amount Received (₱) *'}</label>
            <input
              id="pu-amount-paid"
              type="number"
              className="form-input"
              placeholder={isPayLater ? "0.00" : estimatedCost.toFixed(2)}
              value={form.amount_paid}
              onChange={e => setForm(p => ({ ...p, amount_paid: e.target.value }))}
              min="0"
            />
          </div>

          {/* GCash Payment Flow */}
          {form.payment_method === 'gcash' && (
            <div className="mb-16" style={{ background: 'var(--bg-secondary)', borderRadius: 8, padding: 14, border: '1px solid var(--border)' }}>
              <div className="mb-8" style={{ fontSize: '0.8125rem', fontWeight: 600 }}>GCash Payment</div>

              {/* === PayMongo Automated Flow === */}
              {paymentStep === 'setup' && (
                <div className="mb-12">
                  <button
                    type="button"
                    className="btn btn-primary btn-sm w-full justify-center"
                    onClick={handleProceedToGCash}
                    disabled={(!isPayLater && estimatedCost <= 0) || (isPayLater && parseFloat(form.amount_paid || 0) <= 0)}
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

              {/* ── Payment CONFIRMED — the ledger has recorded the money ── */}
              {paymentStep === 'waiting' && paymentConfirmed && (
                <div className="mb-12" style={{ background: 'var(--success-bg)', borderRadius: 8, padding: 14, border: '1px solid var(--success)' }}>
                  <div className="flex items-center gap-8 mb-12">
                    <CheckCircle size={20} style={{ color: 'var(--success)' }} aria-hidden="true" />
                    <span className="text-sm fw-700" style={{ color: 'var(--success-dark)' }}>
                      Payment received — ₱{paymentConfirmed.received.toFixed(2)}
                    </span>
                  </div>
                  <div className="text-xs" style={{ color: 'var(--success-dark)', lineHeight: 1.8 }}>
                    <div className="flex justify-between">
                      <span>Total paid</span><strong>₱{paymentConfirmed.amountPaid.toFixed(2)}</strong>
                    </div>
                    <div className="flex justify-between">
                      <span>Remaining balance</span><strong>₱{paymentConfirmed.remaining.toFixed(2)}</strong>
                    </div>
                    <div className="flex justify-between">
                      <span>Payment status</span><strong className="text-capitalize">{paymentConfirmed.status}</strong>
                    </div>
                    {paymentConfirmed.reference && (
                      <div className="flex justify-between">
                        <span>Reference</span>
                        <strong style={{ fontSize: '0.6875rem', wordBreak: 'break-all' }}>{paymentConfirmed.reference}</strong>
                      </div>
                    )}
                  </div>
                  <div className="text-xs text-tertiary mt-12" style={{ textAlign: 'center' }}>
                    Recorded automatically. You can now confirm the pickup.
                  </div>
                </div>
              )}

              {/* ── Waiting for the customer to pay ── */}
              {paymentStep === 'waiting' && !paymentConfirmed && checkoutUrl && (
                <div className="mb-12" style={{ background: 'var(--info-bg)', borderRadius: 8, padding: 12, border: '1px solid var(--info)' }}>
                  <div className="flex flex-col items-center gap-8 mb-16">
                    <div style={{ background: 'white', padding: 8, borderRadius: 8 }}>
                      <QRCode value={checkoutUrl} size={150} />
                    </div>
                    <span className="text-sm fw-600" style={{ color: 'var(--info-dark)' }}>Scan to Pay via GCash</span>
                  </div>

                  <div className="flex items-center justify-center gap-8 mb-16" role="status" aria-live="polite">
                    <Loader size={14} className="animate-spin" style={{ color: 'var(--info-dark)' }} aria-hidden="true" />
                    <span className="text-xs" style={{ color: 'var(--info-dark)' }}>
                      Waiting for the customer to complete payment…
                    </span>
                  </div>

                  <div className="text-xs text-tertiary mb-16" style={{ textAlign: 'center' }}>
                    This updates by itself the moment the payment goes through — even if the
                    customer pays on their own phone. Keep this open, or check manually below.
                  </div>

                  <div className="flex gap-8 mb-8">
                    <button
                      type="button"
                      className="btn btn-outline btn-sm flex-1 justify-center"
                      onClick={() => navigator.clipboard.writeText(checkoutUrl)}
                    >
                      Copy Payment Link
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm flex-1 justify-center"
                      onClick={() => checkPaymentNow(false)}
                      disabled={checkingPayment}
                    >
                      {checkingPayment
                        ? <><Loader size={14} className="animate-spin mr-6" aria-hidden="true" /> Checking…</>
                        : <><RefreshCw size={14} className="mr-6" aria-hidden="true" /> Check payment</>}
                    </button>
                  </div>

                  {/* The escape hatch that makes locking Confirm Pickup safe:
                      without it, a customer who walks away would strand the
                      admin in a modal they cannot submit. */}
                  <button
                    type="button"
                    className="btn btn-outline btn-sm w-full justify-center"
                    onClick={handleCancelGCashPayment}
                    disabled={checkingPayment}
                  >
                    <XCircle size={14} className="mr-6" aria-hidden="true" /> Cancel payment — pay another way
                  </button>

                  <div className="text-xs text-tertiary mt-12" style={{ textAlign: 'center' }}>
                    <strong>Confirm Pickup is locked</strong> until this payment is confirmed or cancelled.
                  </div>
                </div>
              )}

              {/* === Manual Reference Fallback === */}
              {paymentStep !== 'waiting' && (
                <>
                  <div className="text-xs text-tertiary mb-8" style={{ textAlign: 'center', borderTop: '1px solid var(--border)', paddingTop: 10 }}>Or enter payment details manually</div>
                  <div className="form-group mb-12">
                    <label className="form-label">Reference Number</label>
                    <input
                      type="text"
                      className="form-input"
                      placeholder="Enter GCash Ref No."
                      value={form.payment_reference}
                      onChange={e => setForm(p => ({ ...p, payment_reference: e.target.value }))}
                    />
                  </div>
                </>
              )}

              <div className="form-group mb-12">
                <label className="form-label" htmlFor="pu-payment-date">Payment Date *</label>
                <input
                  id="pu-payment-date"
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
                <label className="form-label" htmlFor="pu-promised-date"><Calendar size={14} className="inline mr-6" /> Promised Payment Date *</label>
                <input
                  id="pu-promised-date"
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
          </>
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
          <button className="btn btn-outline" onClick={onClose} disabled={saving || paymentStep === 'generating'}>Cancel</button>
          <button
            className="btn btn-primary"
            onClick={handleSubmit}
            disabled={saving || paymentStep === 'generating' || gcashUnresolved}
            title={gcashUnresolved && paymentStep === 'waiting'
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
