import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, Loader, Smartphone, AlertTriangle, CreditCard, FileText, Trash2, CheckCircle, ExternalLink } from 'lucide-react';
import FocusTrap from './FocusTrap';
import AmountInput from './AmountInput';
import useScrollLock from '../../hooks/useScrollLock';
import { sanitizeAmount, parseAmount, formatAmount, formatMoney } from '../../utils/currencyInput';
import { uploadPhoto } from '../../lib/storage';
import { serializePhotoReference } from '../../lib/photoReference';
import QRCode from 'react-qr-code';
import { createGCashSource, registerSource, pollPaymentStatus } from '../../lib/paymongo';
import { getPaymentAttemptBySource, getOrderPaymentSnapshot } from '../../lib/database';
import { supabase } from '../../lib/supabase';
import { useToast } from '../../hooks/useToast';

/**
 * AdditionalPaymentModal — Manually collects additional balance-settlement
 * payments. This is always a POST-pickup collection (remaining_balance is
 * only ever non-zero after pickup sets shipping_cost), so — per the business
 * rule that the admin will not return to the pickup location to collect cash
 * — GCash is the only method offered here. There are two GCash channels: the
 * PayMongo automated checkout (server-verified, recorded by the webhook) and
 * a direct GCash transfer outside PayMongo that the admin records manually
 * after personally verifying receipt.
 */
const AdditionalPaymentModal = ({ order, remainingBalance, onClose, onSave, onPaymentConfirmed }) => {
  useScrollLock(true); // mounted only while open

  const [form, setForm] = useState({
    // Stored unformatted; AmountInput adds the thousands separators for display.
    amount: sanitizeAmount(remainingBalance),
    payment_method: 'gcash',
    notes: '',
    payment_reference: '',
    payment_date: new Date().toISOString().split('T')[0],
    verified_receipt: false,
  });

  // Generated once when this modal instance mounts and resent unchanged on
  // every retry of THIS collection (double-click, a dropped response after
  // the database already committed) — never regenerated on re-render, only
  // on a genuinely new modal open (e.g. closing and reopening for another
  // payment).
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  const [receiptPhoto, setReceiptPhoto] = useState(null);
  const [receiptPreview, setReceiptPreview] = useState(null);

  const [saving, setSaving] = useState(false);
  const [uploadProgress, setUploadProgress] = useState('');
  const [error, setError] = useState(null);

  // PayMongo GCash flow states
  const [paymentStep, setPaymentStep] = useState('setup');
  const [paymongoSourceId, setPaymongoSourceId] = useState(null);
  const [checkoutUrl, setCheckoutUrl] = useState(null);
  const [paymentConfirmed, setPaymentConfirmed] = useState(null);
  const [checkingPayment, setCheckingPayment] = useState(false);

  const toast = useToast();
  const receiptInputRef = useRef(null);
  const paymentChannelRef = useRef(null);
  const baselinePaidRef = useRef(Number(order?.amount_paid || 0));
  const paymentConfirmedRef = useRef(false);

  const isLocked = saving || paymentStep === 'generating';

  const handleSafeClose = () => {
    if (!isLocked) {
      onClose();
    }
  };

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
      amountError = 'Enter a valid amount';
    } else if (amountValue <= 0) {
      amountError = 'Amount must be greater than ₱0';
    } else if (amountValue > remainingBalance) {
      amountError = `Amount cannot exceed balance (${formatMoney(remainingBalance)})`;
    }
  }
  const amountValid = amountEntered && !amountError && amountValue > 0 && amountValue <= remainingBalance;

  // GCash QR generated and no manual reference typed: the footer button only
  // dismisses the modal — the webhook records the payment, not this form.
  const isDoneStep = form.payment_method === 'gcash' && paymentStep === 'waiting' && paymentConfirmed;

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
      
      const source = await createGCashSource(amount, `CargoExpress PH - ${order.tracking_number} Additional Payment`, billing, true, order.id);
      await registerSource(source.sourceId, amount, { orderId: order.id });
      
      setPaymongoSourceId(source.sourceId);
      setCheckoutUrl(source.checkoutUrl);
      baselinePaidRef.current = Number(order?.amount_paid || 0);
      paymentConfirmedRef.current = false;
      setPaymentConfirmed(null);
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
  };

  useEffect(() => {
    if (form.payment_method !== 'gcash' && (paymentStep !== 'setup' || paymongoSourceId || checkoutUrl)) {
      resetPayMongoFlow();
    }
  }, [form.payment_method]);

  const applyConfirmedPayment = (row) => {
    if (paymentConfirmedRef.current) return true;
    const paid = Number(row?.amount_paid || 0);
    if (!(paid > baselinePaidRef.current)) return false;
    paymentConfirmedRef.current = true;
    const confirmation = {
      received: paid - baselinePaidRef.current,
      amountPaid: paid,
      remaining: Number(row?.remaining_balance || 0),
      status: row?.payment_status || 'paid',
    };
    setPaymentConfirmed(confirmation);
    void onPaymentConfirmed?.(confirmation);
    return true;
  };

  const checkPaymentNow = async () => {
    if (!paymongoSourceId || checkingPayment) return;
    setCheckingPayment(true);
    setError('');
    try {
      const pollResult = await pollPaymentStatus(paymongoSourceId, order.id).catch(() => null);
      const attempt = await getPaymentAttemptBySource(paymongoSourceId);
      const data = await getOrderPaymentSnapshot(order.id);
      // `orderReconciled` / the attempt's own 'reconciled' status are the
      // only trustworthy signals — a bare status:'paid' can mean "GCash
      // confirmed it, but a concurrent request is still finalizing the
      // ledger," not proof this order has been credited yet.
      const sourceReconciled = pollResult?.orderReconciled
        || attempt?.status === 'reconciled';
      if (!sourceReconciled || !applyConfirmedPayment(data)) {
        setError(pollResult?.settling
          ? 'GCash confirmed this payment; finalizing the ledger entry. Check again in a few seconds.'
          : 'No payment received yet. Ask the customer to complete GCash payment, then check again.');
      }
    } catch (err) {
      setError(err.message || 'Could not check payment status.');
    } finally {
      setCheckingPayment(false);
    }
  };

  useEffect(() => {
    if (paymentStep !== 'waiting' || !paymongoSourceId || paymentConfirmed) return undefined;

    const channel = supabase
      .channel(`additional_payment_${order.id}`)
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'orders', filter: `id=eq.${order.id}`,
      }, () => { void checkPaymentNow(); })
      .subscribe();
    paymentChannelRef.current = channel;
    const fallbackPoll = setInterval(() => { void checkPaymentNow(); }, 15000);

    return () => {
      void supabase.removeChannel(channel);
      if (paymentChannelRef.current === channel) paymentChannelRef.current = null;
      clearInterval(fallbackPoll);
    };
  }, [paymentStep, paymongoSourceId, paymentConfirmed, order.id]);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        handleSafeClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isLocked, onClose]);

  const handleReceiptAdd = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setError('Only JPG, PNG, and WebP images allowed for receipts');
      return;
    }
    if (receiptPreview && typeof receiptPreview === 'string' && receiptPreview.startsWith('blob:')) {
      URL.revokeObjectURL(receiptPreview);
    }
    setReceiptPhoto(file);
    setReceiptPreview(URL.createObjectURL(file));
    setError('');
    if (receiptInputRef.current) receiptInputRef.current.value = '';
  };

  const receiptPreviewRef = useRef(null);
  receiptPreviewRef.current = receiptPreview;

  useEffect(() => {
    return () => {
      if (receiptPreviewRef.current && typeof receiptPreviewRef.current === 'string' && receiptPreviewRef.current.startsWith('blob:')) {
        URL.revokeObjectURL(receiptPreviewRef.current);
      }
    };
  }, []);

  const handleSave = async () => {
    setError(null);

    // QR hand-off: PayMongo's webhook writes the transaction. Inserting one
    // here too would double-count the payment. Nothing to validate, nothing
    // to save — just close.
    if (isDoneStep) {
      onClose();
      return;
    }

    if (form.payment_method === 'gcash' && paymentStep === 'waiting') {
      setError('Wait for payment confirmation or use Check payment before closing this collection.');
      return;
    }

    const amount = (parseAmount(form.amount) || 0);
    if (amountError || !amountValid) {
      setError(amountError || `Amount must be between ₱1 and ${formatMoney(remainingBalance)}`);
      return;
    }

    const hasGeneratedQR = paymentStep === 'waiting' && checkoutUrl;
    const hasManualReference = form.payment_reference && form.payment_reference.trim().length > 0;
    if (!hasGeneratedQR && !hasManualReference) {
      setError('Please generate a GCash QR or enter a manual reference number.');
      return;
    }
    if (hasManualReference) {
      if (!form.payment_date) {
        setError('Payment date is required for a direct GCash transfer.');
        return;
      }
      if (!form.verified_receipt) {
        setError('Confirm that you have verified receipt of this GCash transfer before recording it.');
        return;
      }
    }

    setSaving(true);

    try {
      let receiptUrl = null;
      if (receiptPhoto) {
        setUploadProgress('Uploading receipt...');
        const rResult = await uploadPhoto(receiptPhoto, 'receipts', order.tracking_number, 1, order.id);
        receiptUrl = serializePhotoReference(rResult);
      }
      setUploadProgress('Saving...');

      // onSave signature in OrderDetailPage / UnsettledDeliveriesPage:
      //   (amount, method, reference, notes, date, receiptUrl, idempotencyKey, verifiedReceipt)
      await onSave(
        amount,
        form.payment_method,
        form.payment_reference || null,
        form.notes,
        form.payment_date,
        receiptUrl,
        idempotencyKey,
        hasManualReference ? form.verified_receipt : false,
      );
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  return createPortal(
    <FocusTrap active>
      <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="add-payment-modal-title">
        <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 450 }}>
          <div className="modal-header">
            <h3 id="add-payment-modal-title">Record Payment</h3>
            <button className="btn-icon btn-ghost" onClick={handleSafeClose} disabled={isLocked} aria-label="Close record payment modal"><X size={20} aria-hidden="true" /></button>
          </div>
          
          <div className="modal-body modal-body-scroll">
            {error && (
              <div className="mb-16 p-12 text-sm" style={{ background: 'var(--error-bg)', color: 'var(--error-text-strong)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--error)' }}>
                {error}
              </div>
            )}
            
            <div className="flex justify-between items-center mb-20" style={{ background: 'var(--bg-secondary)', padding: '12px 16px', borderRadius: 'var(--radius-sm)' }}>
              <div>
                <div className="text-sm text-secondary">Remaining Balance</div>
                <div className="text-xl fw-700 text-error">{formatMoney(remainingBalance)}</div>
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
              <label className="form-label"><CreditCard size={14} className="inline mr-6" /> Payment Method</label>
              <div className="text-xs text-tertiary">
                GCash only — a remaining balance after pickup can no longer be settled in cash.
              </div>
            </div>

            {form.payment_method === 'gcash' && (
              <div className="mb-16 br-8" style={{ background: 'var(--bg-secondary)', padding: 14, border: '1px solid var(--border)'}}>
                <div className="mb-8 font-semibold" style={{ fontSize: '0.8125rem' }}>GCash Payment Details</div>

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
                    <div className="text-xs text-tertiary mt-4 text-center">Opens GCash checkout for the customer to pay</div>
                  </div>
                )}

                {paymentStep === 'generating' && (
                  <div className="flex items-center gap-8 mb-12" style={{ padding: '10px 0' }}>
                    <Loader size={16} className="animate-spin" style={{ color: 'var(--primary)' }} />
                    <span className="text-sm">Generating GCash checkout link…</span>
                  </div>
                )}

                {paymentStep === 'waiting' && checkoutUrl && (
                  <div className="mb-12 paymongo-waiting-card">
                    <div className="flex items-center justify-between flex-wrap gap-8 mb-16">
                      <span
                        className="text-white"
                        style={{
                          background: '#007DFE', borderRadius: 'var(--radius-xs)',
                          padding: '3px 10px', fontWeight: 700, fontSize: '0.8125rem',
                          letterSpacing: 0.5,
                        }}
                      >
                        GCash
                      </span>
                      <span className="text-sm fw-700" style={{ color: 'var(--info-dark)' }}>
                        ₱{formatAmount((parseAmount(form.amount) || 0).toFixed(2))} via GCash
                      </span>
                    </div>

                    <div className="flex flex-col items-center gap-8 mb-16">
                      <div className="paymongo-qr-wrap">
                        <QRCode value={checkoutUrl} size={256} style={{ height: 'auto', maxWidth: '100%', width: '100%' }} viewBox="0 0 256 256" />
                      </div>
                    </div>

                    {paymentConfirmed ? (
                      <div className="alert-banner alert-banner-success mb-12" role="status">
                        <CheckCircle size={15} aria-hidden="true" />
                        <span>Payment received — ₱{formatAmount(paymentConfirmed.received.toFixed(2))} recorded automatically.</span>
                      </div>
                    ) : (
                      <>
                        <ol className="m-0 text-secondary" style={{ paddingLeft: 18, fontSize: '0.8125rem', lineHeight: 1.9 }}>
                          <li>Scan the QR, or tap <strong>Open GCash</strong> for the checkout page</li>
                          <li>Approve the payment in the GCash app</li>
                          <li>This window updates automatically when the payment lands</li>
                        </ol>
                        <button type="button" className="btn btn-secondary btn-sm w-full justify-center mt-12 paymongo-check-btn" onClick={checkPaymentNow} disabled={checkingPayment}>
                          {checkingPayment ? <><Loader size={14} className="animate-spin mr-6" /> Checking…</> : 'Check payment'}
                        </button>
                      </>
                    )}

                    <div className="paymongo-actions">
                      <button
                        type="button"
                        className="btn btn-primary btn-sm justify-center"
                        onClick={() => { window.location.href = checkoutUrl; }}
                      >
                        <ExternalLink size={14} className="mr-6" aria-hidden="true" /> Open GCash
                      </button>
                      <button
                        type="button"
                        className="btn btn-outline btn-sm justify-center"
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(checkoutUrl);
                            toast.success('Payment link copied to clipboard');
                          } catch {
                            setError('Failed to copy link. Please copy manually.');
                          }
                        }}
                      >
                        Copy Payment Link
                      </button>
                    </div>
                  </div>
                )}

                {/* === Direct GCash transfer (outside PayMongo) — manually verified === */}
                {paymentStep !== 'waiting' && (
                  <>
                    <div className="text-xs text-tertiary mb-8 text-center border-t" style={{ paddingTop: 10 }}>
                      Or record a direct GCash transfer received outside PayMongo
                    </div>
                    <div className="form-group mb-12">
                      <label className="form-label" htmlFor="addl-payment-reference">GCash Transfer Reference *</label>
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
                {form.payment_reference && form.payment_reference.trim() && (
                  <label
                    className="flex items-start gap-8 mb-12 text-sm"
                    style={{ background: 'var(--warning-bg)', border: '1px solid var(--warning)', borderRadius: 'var(--radius-sm)', padding: '10px 12px', cursor: 'pointer' }}
                  >
                    <input
                      type="checkbox"
                      checked={form.verified_receipt}
                      onChange={e => setForm(p => ({ ...p, verified_receipt: e.target.checked }))}
                      style={{ marginTop: 2 }}
                    />
                    <span>
                      I have personally verified that this GCash transfer was received in the business account.
                      A reference number alone is not proof of payment.
                    </span>
                  </label>
                )}
                <div className="form-group mb-0">
                  <label className="form-label">Receipt Screenshot (Optional)</label>
                  <p className="text-xs text-tertiary mb-8">Receipt screenshot is optional and should only be uploaded if requested by the administrator or if additional proof is needed.</p>
                  {receiptPreview ? (
                    <div className="relative overflow-hidden mb-8 br-8" style={{ width: 90, height: 90, border: '2px solid var(--border)'}}>
                      <img src={receiptPreview} alt="Receipt" className="w-full h-full object-cover" />
                      <button type="button" onClick={() => { setReceiptPhoto(null); setReceiptPreview(null); }} className="pickup-photo-remove-btn" aria-label="Remove receipt">
                        <Trash2 size={12} />
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => receiptInputRef.current?.click()}
                      className="br-8 cursor-pointer"
                      style={{
                        padding: '8px 16px', border: '1px dashed var(--border)',
                        background: 'transparent', fontSize: '0.8125rem'
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
            <button className="btn btn-outline" onClick={handleSafeClose} disabled={isLocked}>Cancel</button>
            {/* `isDoneStep` is the QR hand-off: nothing is being recorded, the
                webhook will. Amount validity is irrelevant to closing it. */}
            <button
              className="btn btn-primary"
              onClick={handleSave}
              disabled={
                saving ||
                (paymentStep === 'waiting' && !paymentConfirmed) ||
                (!isDoneStep && !amountValid) ||
                (paymentStep !== 'waiting' && !(form.payment_reference && form.payment_reference.trim())) ||
                (paymentStep !== 'waiting' && Boolean(form.payment_reference && form.payment_reference.trim()) && !form.verified_receipt)
              }
            >
              {saving ? <><Loader size={16} className="animate-spin" /> {uploadProgress || 'Saving...'}</> : <><CheckCircle size={16} /> {isDoneStep ? 'Done' : paymentStep === 'waiting' ? 'Waiting for payment' : 'Record Payment'}</>}
            </button>
          </div>
        </div>
      </div>
    </FocusTrap>,
    document.body
  );
};

export default AdditionalPaymentModal;
