/**
 * Single source of FAQ content, shared by the customer Help & Guidelines
 * page and the public About page's FAQ section so the two never drift out
 * of sync. There is no `faqs` table yet — this static list is the entire
 * content source for both surfaces.
 */
export const FAQ_ITEMS = [
  {
    id: 'fallback-tracking',
    title: 'How do I track my shipment?',
    category: 'Tracking',
    answer: 'Open Orders, select your tracking number, and review the latest status timeline.',
  },
  {
    id: 'fallback-payment',
    title: 'When do I pay?',
    category: 'Payments',
    answer: 'Payment is recorded during pickup, delivery, or approved balance settlement depending on the order.',
  },
  {
    id: 'fallback-support',
    title: 'How do I contact support?',
    category: 'Support',
    answer: 'Use Live Support Chat from your profile or order details page for shipment-specific questions.',
  },
  {
    id: 'photo-retention',
    title: 'How long do you keep my delivery records?',
    category: 'Privacy',
    answer: 'Your transaction history remains accessible in your account. However, for your privacy and security, pickup and delivery photos (proof of delivery) are securely removed from our system 6 months after the transaction is completed.',
  },
];

export default FAQ_ITEMS;
