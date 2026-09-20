import { AlertTriangle, CheckCircle, Clock } from 'lucide-react';
import { formatMoney } from '../../utils/currencyInput';
import { formatPhDate } from '../../utils/datetime';

const STATUS_LABELS = {
  for_review: 'For Review',
  refund_due: 'Refund Due',
  refund_pending: 'Refund Pending',
  refund_settled: 'Refund Settled',
  needs_reconciliation: 'Needs Reconciliation',
  no_settlement_required: 'No Payment Collected',
};

const statusTone = status => {
  if (status === 'refund_settled') return 'badge-success';
  if (status === 'needs_reconciliation') return 'badge-error';
  if (status === 'no_settlement_required') return 'badge-default';
  return 'badge-warning';
};

const MoneyFact = ({ label, value, tone = '' }) => (
  <div>
    <div className="text-tertiary">{label}</div>
    <div className={`fw-700 ${tone}`}>{formatMoney(Number(value || 0))}</div>
  </div>
);

const CancellationSettlementSummary = ({ summary, historicalPromiseDate = null, admin = false, actions = null }) => {
  if (!summary) {
    return (
      <div className="alert-banner alert-banner-warning">
        <AlertTriangle size={16} /> Cancellation settlement details could not be loaded. Payment and refund history remains available below.
      </div>
    );
  }

  const grossCollected = Number(summary.gross_collected || 0);
  const confirmed = Boolean(summary.has_confirmed_decision);
  const status = grossCollected === 0 ? 'no_settlement_required' : (summary.settlement_status || 'for_review');
  const inProgress = Number(summary.refund_in_progress || 0);
  const notInitiated = Number(summary.refund_not_initiated || 0);

  return (
    <div className="admin-refund-summary br-8" style={{ background: 'var(--bg-secondary)', padding: '12px 14px', overflowWrap: 'anywhere' }}>
      <div className="flex items-center justify-between gap-8 flex-wrap mb-8">
        <div className="text-xs fw-700 text-uppercase text-tertiary">Payment &amp; Refund Summary</div>
        <span className={`badge ${statusTone(status)}`}>{STATUS_LABELS[status] || status}</span>
      </div>

      <div className="grid grid-2 gap-8" style={{ fontSize: '0.8125rem' }}>
        <div><div className="text-tertiary">Booking status</div><div className="fw-700">Cancelled</div></div>
        <MoneyFact label="Historical final charge" value={summary.historical_final_charge} />
        <MoneyFact label="Gross collected" value={summary.gross_collected} />
        <MoneyFact label="Successfully refunded" value={summary.successful_refunds} tone={Number(summary.successful_refunds) > 0 ? 'text-warning' : ''} />
        <MoneyFact label="Net retained" value={summary.net_retained} />
        {confirmed && <MoneyFact label="Agreed cancellation fee" value={summary.agreed_cancellation_fee} />}
        {confirmed && <MoneyFact label="Refund still due" value={summary.refund_still_due} tone={Number(summary.refund_still_due) > 0 ? 'text-warning' : 'text-success'} />}
        {inProgress > 0 && <MoneyFact label="Refund in progress" value={inProgress} tone="text-warning" />}
        {confirmed && inProgress > 0 && notInitiated > 0 && <MoneyFact label="Refund not yet initiated" value={notInitiated} tone="text-warning" />}
      </div>

      {status === 'for_review' && (
        <div className="alert-banner alert-banner-info mt-12 py-8 px-12" style={{ fontSize: '0.8125rem' }}>
          <Clock size={14} /> No financial settlement decision is recorded. The net retained amount is not automatically a fee.
        </div>
      )}
      {status === 'refund_settled' && (
        <div className="alert-banner alert-banner-success mt-12 py-8 px-12" style={{ fontSize: '0.8125rem' }}>
          <CheckCircle size={14} /> The confirmed refund obligation is fully allocated between successful refunds and the agreed fee.
        </div>
      )}
      {status === 'needs_reconciliation' && (
        <div className="alert-banner alert-banner-error mt-12 py-8 px-12" style={{ fontSize: '0.8125rem' }}>
          <AlertTriangle size={14} /> Payment, refund, and fee records are inconsistent. Do not issue another refund or amend the decision until reconciled.
        </div>
      )}

      {summary.customer_agreement_confirmed && (
        <p className="text-xs text-secondary mt-8 mb-0">An admin recorded confirmation that the customer agreed to the displayed fee.</p>
      )}
      {admin && summary.internal_notes && (
        <div className="text-xs text-secondary mt-8"><strong>Internal note:</strong> {summary.internal_notes}</div>
      )}
      {historicalPromiseDate && (
        <div className="text-xs text-tertiary mt-8">
          Historical payment promise: {formatPhDate(historicalPromiseDate)} — retained for history and no longer actionable after cancellation.
        </div>
      )}
      {actions && grossCollected > 0 && status !== 'refund_settled' && <div className="mt-12">{actions}</div>}
    </div>
  );
};

export default CancellationSettlementSummary;
