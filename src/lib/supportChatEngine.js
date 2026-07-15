/**
 * supportChatEngine.js
 *
 * Authenticated, database-aware chatbot engine for CargoExpress PH customer support.
 * Unlike the previous public chatbot, this engine runs in an authenticated session
 * and can safely query the logged-in customer's own orders, payments, and trips.
 *
 * Usage:
 *   import { getBotReply } from './supportChatEngine';
 *   const reply = await getBotReply(userMessage, userId, supabase);
 */

import { supabase } from './supabase';

// ── Escalation keywords (bypass chatbot entirely → go straight to admin) ──────
const ESCALATION_PATTERNS = [
  /compla(int|in)/i,
  /damaged?/i,
  /refund/i,
  /lost\s*(package|shipment|parcel|item)/i,
  /missing\s*(package|shipment|item)/i,
  /(report|reimburse|reimbursement)/i,
  /urgent/i,
  /emergency/i,
  /supervisor/i,
  /manager/i,
  /talk\s*to\s*(admin|human|agent|person|staff|support)/i,
  /speak\s*to\s*(admin|human|agent|person|staff|support)/i,
  /connect\s*me\s*to/i,
  /real\s*(person|human|agent|admin)/i,
  /human\s*(agent|support|help)/i,
  /\bhuman\b/i,
  /\bagent\b/i,
];

// ── Intent matchers ────────────────────────────────────────────────────────────
const INTENTS = [
  // Greeting / hi / hello
  {
    id: 'greeting',
    patterns: [/^(hi|hello|hey|good\s*(morning|afternoon|evening)|mabuhay|kumusta)/i],
    handler: async () => ({
      text: 'Hi there! 👋 How can I help you today?\n\nYou can ask me about your:\n• Shipment status\n• Booking information\n• Payment details\n• Tracking number\n• Delivery process',
      askResolved: false,
    }),
  },

  // Booking / order existence
  {
    id: 'booking_status',
    patterns: [
      /active\s*booking/i,
      /my\s*(order|booking)/i,
      /do\s*i\s*have\s*(a|an)?\s*(order|booking)/i,
      /any\s*(order|booking)/i,
      /booking\s*status/i,
      /order\s*status/i,
    ],
    handler: async (userId) => {
      const orders = await fetchCustomerOrders(userId);
      if (!orders.length) {
        return {
          text: "You currently don't have any active bookings.\n\nWould you like to book a shipment? You can do so from the Book Shipment page.",
          askResolved: true,
        };
      }
      const latest = orders[0];
      return {
        text: `You have ${orders.length} booking${orders.length > 1 ? 's' : ''}.\n\nYour most recent booking:\n📦 Tracking #: ${latest.tracking_number}\n📍 Status: ${latest.status}\n🚢 Route: ${latest.origin} → ${latest.destination}`,
        askResolved: true,
      };
    },
  },

  // Tracking number
  {
    id: 'tracking_number',
    patterns: [
      /tracking\s*(number|#|num)/i,
      /what('?s|\s*is)\s*(my)?\s*tracking/i,
      /find\s*my\s*tracking/i,
    ],
    handler: async (userId) => {
      const orders = await fetchCustomerOrders(userId);
      if (!orders.length) {
        return {
          text: "You don't have any bookings yet, so there's no tracking number to show.",
          askResolved: true,
        };
      }
      const lines = orders.slice(0, 3).map(o => `• ${o.tracking_number} — ${o.status}`).join('\n');
      return {
        text: `Here are your tracking numbers:\n\n${lines}\n\nYou can use any of these on the Track Package page for full details.`,
        askResolved: true,
      };
    },
  },

  // Shipment / package location / where is my package
  {
    id: 'shipment_location',
    patterns: [
      /where\s*(is)?\s*(my|the)?\s*(package|shipment|parcel|cargo)/i,
      /status\s*of\s*my\s*(shipment|order|package)/i,
      /shipment\s*status/i,
      /package\s*status/i,
      /what\s*(is|'s)\s*(the)?\s*status/i,
      /update\s*on\s*my/i,
    ],
    handler: async (userId) => {
      const orders = await fetchCustomerOrders(userId);
      if (!orders.length) {
        return {
          text: "You don't have any active bookings, so there's no shipment to track at the moment.",
          askResolved: true,
        };
      }
      const latest = orders[0];
      const statusDesc = STATUS_DESCRIPTIONS[latest.status] || `Your shipment status is: ${latest.status}.`;
      return {
        text: `📦 Tracking: ${latest.tracking_number}\n📍 Status: **${latest.status}**\n\n${statusDesc}\n\n🚢 Route: ${latest.origin} → ${latest.destination}${latest.trips ? `\n🚚 Trip: ${latest.trips.trip_number}` : ''}`,
        askResolved: true,
      };
    },
  },

  // Picked up?
  {
    id: 'pickup_status',
    patterns: [
      /already\s*picked\s*up/i,
      /has\s*(my|the)?\s*(package|shipment|order|parcel)\s*(been|already)?\s*picked/i,
      /pick\s*up\s*status/i,
      /when\s*(will|is)\s*(my)?\s*(package|shipment|order)?\s*(be|)?\s*picked/i,
    ],
    handler: async (userId) => {
      const orders = await fetchCustomerOrders(userId);
      if (!orders.length) {
        return { text: "You don't have any bookings currently.", askResolved: true };
      }
      const latest = orders[0];
      const pickedStatuses = ['Picked Up', 'In Transit', 'Arrived at Hub', 'Out for Delivery', 'Delivered'];
      const isPicked = pickedStatuses.includes(latest.status);
      return {
        text: isPicked
          ? `✅ Yes! Your shipment (${latest.tracking_number}) has already been picked up.\n\nCurrent status: **${latest.status}**`
          : `Your shipment (${latest.tracking_number}) has not been picked up yet.\n\nCurrent status: **${latest.status}**\n\nOur team will schedule the pickup soon.`,
        askResolved: true,
      };
    },
  },

  // Out for delivery / delivered?
  {
    id: 'delivery_status',
    patterns: [
      /out\s*for\s*delivery/i,
      /already\s*delivered/i,
      /(is|has)\s*(my)?\s*(package|shipment|parcel|order)\s*(been|already)?\s*deliver/i,
      /when\s*(will|is)\s*(my)?\s*(package|shipment)?\s*(be)?\s*deliver/i,
      /deliver(y|ed|ing)/i,
    ],
    handler: async (userId) => {
      const orders = await fetchCustomerOrders(userId);
      if (!orders.length) {
        return { text: "You don't have any bookings currently.", askResolved: true };
      }
      const latest = orders[0];
      if (latest.status === 'Delivered') {
        return {
          text: `✅ Your shipment (${latest.tracking_number}) has been successfully delivered!`,
          askResolved: true,
        };
      }
      if (latest.status === 'Out for Delivery') {
        return {
          text: `🚚 Your shipment (${latest.tracking_number}) is currently **out for delivery**!\n\nOur delivery personnel is on their way to deliver your package.`,
          askResolved: true,
        };
      }
      return {
        text: `Your shipment (${latest.tracking_number}) has not been delivered yet.\n\nCurrent status: **${latest.status}**\n\n${STATUS_DESCRIPTIONS[latest.status] || ''}`,
        askResolved: true,
      };
    },
  },

  // Hub arrival
  {
    id: 'hub_arrival',
    patterns: [
      /arrived?\s*(at)?\s*(the)?\s*hub/i,
      /hub\s*arrival/i,
      /(is|has)\s*(my)?\s*(package|shipment)?\s*(arrived?|reach)/i,
    ],
    handler: async (userId) => {
      const orders = await fetchCustomerOrders(userId);
      if (!orders.length) {
        return { text: "You don't have any bookings currently.", askResolved: true };
      }
      const latest = orders[0];
      const arrivedStatuses = ['Arrived at Hub', 'Out for Delivery', 'Delivered'];
      const hasArrived = arrivedStatuses.includes(latest.status);
      return {
        text: hasArrived
          ? `✅ Yes! Your shipment (${latest.tracking_number}) has arrived at the destination hub.\n\nCurrent status: **${latest.status}**`
          : `Your shipment (${latest.tracking_number}) has not yet arrived at the hub.\n\nCurrent status: **${latest.status}**`,
        askResolved: true,
      };
    },
  },

  // Payment / fee / cost / balance
  {
    id: 'payment_info',
    patterns: [
      /how\s*much\s*(is|are|do)?\s*(my|the|i)?\s*(shipping|pay|fee|cost|balance|owe|owed)/i,
      /shipping\s*(fee|cost|rate|price)/i,
      /(payment|pay)\s*(status|info|information|detail)/i,
      /remaining\s*balance/i,
      /amount\s*(paid|due|owe)/i,
      /do\s*i\s*(still)?\s*(have|owe)\s*(a)?\s*(balance|remaining|unpaid)/i,
      /is\s*my\s*payment\s*(done|complete|full)/i,
      /paid\s*(already|in\s*full)?/i,
      /unpaid/i,
      /partial\s*payment/i,
    ],
    handler: async (userId) => {
      const orders = await fetchCustomerOrders(userId);
      if (!orders.length) {
        return { text: "You don't have any bookings, so there's no payment information to show.", askResolved: true };
      }
      const latest = orders[0];
      const cost = parseFloat(latest.shipping_cost || 0);
      const paid = parseFloat(latest.amount_paid || 0);
      const balance = parseFloat(latest.remaining_balance || 0);
      const payStatus = latest.payment_status;

      let paymentLine = '';
      if (payStatus === 'paid') {
        paymentLine = `✅ Payment is **complete**. Thank you!`;
      } else if (payStatus === 'partial') {
        paymentLine = `⚠️ Partially paid. You still have a remaining balance.`;
      } else {
        paymentLine = `❌ Payment is **unpaid**.`;
      }

      return {
        text: `💰 Payment details for ${latest.tracking_number}:\n\n💵 Shipping Fee: ₱${cost.toFixed(2)}\n✅ Amount Paid: ₱${paid.toFixed(2)}\n🔴 Remaining Balance: ₱${balance.toFixed(2)}\n\n${paymentLine}`,
        askResolved: true,
      };
    },
  },

  // Trip assignment
  {
    id: 'trip_info',
    patterns: [
      /which\s*trip/i,
      /assigned\s*to\s*(a|which|what)?\s*trip/i,
      /trip\s*(number|#|num|detail|info|assign)/i,
      /what\s*trip/i,
      /has\s*(my)?\s*(trip|shipment)\s*(started|depart)/i,
      /trip\s*start/i,
    ],
    handler: async (userId) => {
      const orders = await fetchCustomerOrders(userId);
      if (!orders.length) {
        return { text: "You don't have any bookings currently.", askResolved: true };
      }
      const latest = orders[0];
      if (!latest.trips) {
        return {
          text: `Your shipment (${latest.tracking_number}) has not been assigned to a trip yet.\n\nCurrent status: **${latest.status}**\n\nOur admin will assign it to an upcoming trip soon.`,
          askResolved: true,
        };
      }
      const trip = latest.trips;
      const tripStatusLine = trip.status === 'in_progress'
        ? '🚢 Trip is currently **underway**.'
        : trip.status === 'completed'
        ? '✅ Trip has **arrived** at the destination.'
        : `📅 Trip is **${trip.status}**.`;
      return {
        text: `🚢 Your shipment (${latest.tracking_number}) is on:\n\n📋 Trip: ${trip.trip_number}\n🗺️ Route: ${trip.origin} → ${trip.destination}\n${tripStatusLine}`,
        askResolved: true,
      };
    },
  },

  // How to book / booking process
  {
    id: 'how_to_book',
    patterns: [
      /how\s*(to|do\s*i|can\s*i)\s*(book|place|create|make)\s*(a|an)?\s*(shipment|order|booking|cargo)/i,
      /how\s*does?\s*(booking|shipment)\s*work/i,
      /process\s*(of|for)\s*(booking|shipping)/i,
    ],
    handler: async () => ({
      text: `📦 To book a shipment with CargoExpress PH:\n\n1️⃣ Go to the **Book Shipment** page from your dashboard\n2️⃣ Fill in sender & receiver details\n3️⃣ Enter package weight and description\n4️⃣ Choose a route (Bohol → Manila or Manila → Bohol)\n5️⃣ Select a trip (optional) or let admin assign one\n6️⃣ Submit your booking\n\nPayment is collected upon pickup.`,
      askResolved: true,
    }),
  },

  // Delivery timeline / how long / ETA
  {
    id: 'delivery_timeline',
    patterns: [
      /how\s*long\s*(does?|will)\s*(it\s*take|the\s*(delivery|shipping))/i,
      /when\s*will\s*(it|my\s*(package|shipment))\s*(arrive|be\s*delivered)/i,
      /eta/i,
      /delivery\s*time/i,
      /how\s*many\s*days/i,
    ],
    handler: async () => ({
      text: `⏱️ Delivery Timeline:\n\n• **Bohol → Manila**: Approximately 3–5 business days\n• **Manila → Bohol**: Approximately 3–5 business days\n\nActual delivery time may vary depending on trip schedules and weather conditions at sea.`,
      askResolved: true,
    }),
  },

  // Price / rate
  {
    id: 'pricing',
    patterns: [
      /(how\s*much|what'?s?\s*the\s*(price|rate|cost))\s*(per\s*kilo|per\s*kg)?/i,
      /rate\s*(per\s*kilo|per\s*kg)/i,
      /price\s*(list|per\s*kilo|per\s*kg)/i,
      /how\s*much\s*(would|does?)\s*(it|shipping)\s*cost/i,
    ],
    handler: async () => {
      let pricePerKg = 70;
      try {
        const { data } = await supabase.from('company_information').select('default_price_per_kg').single();
        if (data?.default_price_per_kg) pricePerKg = parseFloat(data.default_price_per_kg);
      } catch { /* use default */ }
      return {
        text: `💰 Our current shipping rate is ₱${pricePerKg.toFixed(2)} per kilogram.\n\nFor example:\n• 5 kg = ₱${(5 * pricePerKg).toFixed(2)}\n• 10 kg = ₱${(10 * pricePerKg).toFixed(2)}\n• 20 kg = ₱${(20 * pricePerKg).toFixed(2)}\n\nPayment is made upon pickup.`,
        askResolved: true,
      };
    },
  },

  // Contact / phone / Facebook
  {
    id: 'contact_info',
    patterns: [
      /contact\s*(number|info|information|us|admin|support)/i,
      /phone\s*number/i,
      /facebook|fb\s*(page)?/i,
      /how\s*(can\s*i|to)\s*contact/i,
      /email\s*(address|contact)?/i,
    ],
    handler: async () => {
      let info = null;
      try {
        const { data } = await supabase.from('company_information').select('smart_phone, globe_phone, facebook, email').single();
        info = data;
      } catch { /* skip */ }
      const lines = [];
      if (info?.smart_phone) lines.push(`📱 Smart: ${info.smart_phone}`);
      if (info?.globe_phone) lines.push(`📱 Globe: ${info.globe_phone}`);
      if (info?.facebook) lines.push(`📘 Facebook: ${info.facebook}`);
      if (info?.email) lines.push(`📧 Email: ${info.email}`);
      return {
        text: lines.length
          ? `Here are our contact details:\n\n${lines.join('\n')}\n\nYou can also message us through the About Us page.`
          : 'Please visit our About Us page for contact information.',
        askResolved: true,
      };
    },
  },

  // Thank you / goodbye
  {
    id: 'thanks',
    patterns: [
      /^(thank(s|\s*you)|ty|salamat|ok\s*thanks?|great\s*thanks?|okay\s*thanks?)/i,
      /^(bye|goodbye|take\s*care)/i,
    ],
    handler: async () => ({
      text: "You're welcome! 😊 Have a great day! If you need anything else, feel free to message us anytime.",
      askResolved: false,
    }),
  },
];

// ── Status descriptions ────────────────────────────────────────────────────────
const STATUS_DESCRIPTIONS = {
  'Pending': 'Your booking has been received and is awaiting review by our administrator.',
  'Assigned': 'Your shipment has been assigned to a scheduled trip and is waiting for pickup.',
  'Picked Up': 'Your shipment has been collected and is being prepared for transport.',
  'In Transit': 'Your shipment is currently traveling toward the destination.',
  'Arrived at Hub': 'Your shipment has arrived at the destination hub and is being organized for delivery.',
  'Out for Delivery': 'Our delivery personnel is currently delivering your shipment.',
  'Delivered': 'Your shipment has been successfully delivered.',
  'Cancelled': 'This shipment has been cancelled.',
};

// ── Data fetcher ───────────────────────────────────────────────────────────────
const fetchCustomerOrders = async (userId) => {
  const { data, error } = await supabase
    .from('orders')
    .select(`
      id, tracking_number, status, origin, destination,
      shipping_cost, amount_paid, remaining_balance, payment_status,
      package_weight, actual_weight, sender_name, receiver_name,
      created_at,
      trips:trip_id (trip_number, origin, destination, status)
    `)
    .eq('user_id', userId)
    .neq('status', 'Cancelled')
    .order('created_at', { ascending: false })
    .limit(5);
  if (error) throw error;
  return data || [];
};

// ── Main export ────────────────────────────────────────────────────────────────

/**
 * getBotReply
 *
 * @param {string}  text    - Raw message from the customer
 * @param {string}  userId  - Authenticated customer's UUID
 * @returns {Promise<{text: string, escalate: boolean, askResolved: boolean}>}
 */
export const getBotReply = async (text, userId) => {
  const trimmed = text.trim();

  // 1. Check for escalation keywords — skip bot entirely
  if (ESCALATION_PATTERNS.some(rx => rx.test(trimmed))) {
    return {
      text: null,
      escalate: true,
      askResolved: false,
    };
  }

  // 2. Match intent
  for (const intent of INTENTS) {
    if (intent.patterns.some(rx => rx.test(trimmed))) {
      try {
        const result = await intent.handler(userId);
        return { escalate: false, ...result };
      } catch (err) {
        // If DB query fails, fall through to fallback
        console.warn('[Bot] Intent handler error:', err.message);
      }
    }
  }

  // 3. Fallback — no match
  return {
    text: "I'm sorry, I didn't quite understand that. 🤔\n\nI can help you with:\n• Shipment status & location\n• Tracking number\n• Payment details\n• Booking information\n• Delivery timeline\n• Pricing & rates\n\nYou can also select **❌ No** to connect with one of our support agents.",
    escalate: false,
    askResolved: true,
  };
};

/**
 * BOT_GREETING — Sent automatically when customer opens chat for the first time
 */
export const BOT_GREETING = `Hello! 👋 Welcome to CargoExpress PH Support.

I'm your virtual assistant. I can help you with:

• Shipment status & location
• Booking information
• Payment details & balance
• Tracking numbers
• Delivery process & timeline
• Frequently asked questions

How can I help you today?`;
