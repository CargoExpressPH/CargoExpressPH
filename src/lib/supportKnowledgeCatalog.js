/**
 * CargoMate's maintained intent/knowledge catalog.
 *
 * This is deliberately a small, human-edited catalog rather than a second
 * answer engine. It documents what the rule-based router can answer, the
 * phrases QA should exercise, and the authoritative source used by the
 * handler. If a source changes, update the handler and this entry together.
 */
export const SUPPORT_KNOWLEDGE_CATALOG = [
  { id: 'how_to_book', type: 'faq', examples: ['how do I book', 'paano magpadala', 'unsaon pag book'], source: 'customer Book Shipment flow' },
  { id: 'booking_status', type: 'account', examples: ['check my bookings', 'may booking ba ako', 'CE-20260920-1988'], source: 'authorized orders query + order status fields' },
  { id: 'tracking_number', type: 'account', examples: ['what is my tracking number', 'asa akong tracking'], source: 'authorized orders query' },
  { id: 'payment_info', type: 'account', examples: ['what is my balance', 'payment details CE-…'], source: 'authorized orders + settlement helpers + payment/refund history RPCs' },
  { id: 'mode_of_payment', type: 'faq', examples: ['can I pay by GCash', 'modawat ba mo ug cash'], source: 'payment method rules in the application' },
  { id: 'refund_policy', type: 'faq', examples: ['what is the refund policy', 'automatic ba ang refund'], source: 'customer cancellation/refund UI and Terms page' },
  { id: 'booking_changes', type: 'faq', examples: ['can I edit my booking', 'how do I cancel'], source: 'customer order actions and cancellation RPC contract' },
  { id: 'additional_cargo', type: 'faq', examples: ['can I add another box', 'book additional cargo'], source: 'booking flow; a second booking is required' },
  { id: 'shipment_location', type: 'account', examples: ['where is my package', 'asa na ang padala ko'], source: 'authorized order status and assigned trip' },
  { id: 'delivery_status', type: 'account', examples: ['is my package delivered', 'nahatod na ba'], source: 'authorized order status' },
  { id: 'hub_arrival', type: 'account', examples: ['has it reached the hub', 'naa na sa bodega'], source: 'authorized order status' },
  { id: 'pickup_status', type: 'account', examples: ['has it been picked up', 'nakuha na ba'], source: 'authorized order status' },
  { id: 'trip_info', type: 'account', examples: ['which trip is my booking on', 'unsa akong trip'], source: 'authorized order/trip relation' },
  { id: 'delivery_timeline', type: 'faq/account', examples: ['how long is delivery', 'ETA for CE-…'], source: 'trip/order status when available; no invented ETA' },
  { id: 'service_areas', type: 'faq', examples: ['where do you deliver', 'pwede ba sa Cebu'], source: 'live company_information.coverage' },
  { id: 'pricing', type: 'faq', examples: ['how much per kilo', 'magkano kada kilo'], source: 'live company_information.default_price_per_kg' },
  { id: 'prohibited_items', type: 'faq', examples: ['what items are prohibited', 'ano ang bawal'], source: 'Help & Guidelines and Terms page' },
  { id: 'packaging_guidelines', type: 'faq', examples: ['how should I pack this', 'unsaon pag putos'], source: 'Help & Guidelines' },
  { id: 'weight_limits', type: 'faq', examples: ['is there a weight limit', 'pila ang maximum weight'], source: 'pickup/handling guidance; exact oversized acceptance requires admin review' },
  { id: 'cargo_eligibility', type: 'faq/handoff', examples: ['can I ship an appliance', 'pwede ba ang ref'], source: 'Help & Guidelines; admin review for bulky or fragile items' },
  { id: 'office_location', type: 'faq', examples: ['where is the office', 'asa ang drop-off'], source: 'live company_information addresses/contact details' },
  { id: 'contact_info', type: 'faq', examples: ['how can I contact support', 'unsa inyong number'], source: 'live company_information contact fields' },
  { id: 'account_help', type: 'faq', examples: ['I forgot my password', 'how do I change my email'], source: 'actual auth/profile routes' },
  { id: 'human_handoff', type: 'handoff', examples: ['talk to an admin', 'my GCash payment is not reflected'], source: 'conversation escalation flow' },
];

export default SUPPORT_KNOWLEDGE_CATALOG;
