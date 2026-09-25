/**
 * Single source of FAQ content, shared by the customer Help & Guidelines
 * page and the public About page's FAQ section so the two never drift out
 * of sync. The SEO build also uses this list for their pre-rendered HTML.
 */
export const FAQ_ITEMS = [
  {
    id: 'fallback-tracking',
    title: 'How do I track my shipment?',
    category: 'Tracking',
    answer: 'Enter your tracking number on the Track Shipment page to view the latest shipment status. No account is needed. If you have an account, you can also open Orders and select your shipment.',
  },
  {
    id: 'shipping-price',
    title: 'How much is shipping per kilogram?',
    category: 'Pricing',
    answer: 'The shipping rate can vary by trip. Check the rate for your selected trip when booking, or contact the team for a quote. Describe your items accurately. The final price is based on the weight measured at pickup.',
  },
  {
    id: 'transit-time',
    title: 'How long does shipping between Manila and Bohol take?',
    category: 'Delivery',
    answer: 'Check the Trip Schedules page for the planned departure and contact the team to confirm the expected arrival and delivery timing for your shipment. A departure date is not a guaranteed delivery date.',
  },
  {
    id: 'service-areas',
    title: 'Which areas do you serve?',
    category: 'Coverage',
    answer: 'CargoExpress PH operates trips between Manila and Bohol in both directions. Check Coverage Area on the About page for pickup and delivery locations. Contact the team to confirm your exact address; requests outside standard coverage require review.',
  },
  {
    id: 'fallback-payment',
    title: 'When do I pay?',
    category: 'Payments',
    answer: 'Payment is recorded during pickup, delivery, or approved balance settlement depending on the order.',
  },
  {
    id: 'payment-methods',
    title: 'Can I pay with cash or GCash, or pay later?',
    category: 'Payments',
    answer: 'Cash and GCash are offered when booking. Any pay-later or outstanding-balance arrangement must be confirmed with the team for your order.',
  },
  {
    id: 'restricted-items',
    title: 'What items are restricted?',
    category: 'Shipping',
    answer: 'Do not ship illegal goods, hazardous chemicals, weapons, or undocumented regulated items. Perishable or fragile items may require special approval and packaging. Contact the team before booking if you are unsure whether an item can be accepted.',
  },
  {
    id: 'cancellation',
    title: 'Can I cancel my booking?',
    category: 'Booking',
    answer: 'Before pickup, sign in, open your order, and use the cancellation option if available. Submit a reason for admin review; sending a request does not immediately cancel the booking. If the option is unavailable or your cargo has already been picked up, contact support.',
  },
  {
    id: 'fallback-support',
    title: 'How do I contact support?',
    category: 'Support',
    answer: 'Visit Contact Us on the About page for phone numbers, email, and the contact form. You do not need an account. Customers who are signed in can also use Live Support Chat from their profile or order details.',
  },
  {
    id: 'photo-retention',
    title: 'How long do you keep my delivery records?',
    category: 'Privacy',
    answer: 'Your transaction history remains accessible in your account. However, for your privacy and security, pickup and delivery photos (proof of delivery) are securely removed from our system 6 months after the transaction is completed.',
  },
];

export default FAQ_ITEMS;
