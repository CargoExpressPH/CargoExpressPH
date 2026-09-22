import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import PickupModal from '../../src/components/ui/PickupModal.jsx';
import { createPaymentCollectionState } from '../../src/utils/paymentCollection.js';

function PickupModalMountHarness() {
  const [open, setOpen] = useState(false);
  const order = window.__pickupRenderFixture;

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Process Pickup</button>
      {open && (
        <PickupModal
          order={order}
          onClose={() => setOpen(false)}
          onSave={async () => { window.__pickupRenderCalls.save += 1; }}
          onPreparePayment={async () => { window.__pickupRenderCalls.prepare += 1; }}
          pricePerKilo={70}
        />
      )}
    </>
  );
}

window.__pickupRenderCalls = { save: 0, prepare: 0 };
window.__pickupRenderInitialIdempotencyKey = createPaymentCollectionState().idempotency_key;
window.__pickupRenderRoot = createRoot(document.getElementById('root'));
window.__pickupRenderRoot.render(<PickupModalMountHarness />);
