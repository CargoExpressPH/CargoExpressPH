/**
 * supportChatEngine.js
 *
 * Authenticated, database-aware chatbot engine for CargoExpress PH customer support.
 * Unlike the previous public chatbot, this engine runs in an authenticated session
 * and can safely query the logged-in customer's own orders, payments, and trips.
 *
 * Usage:
 *   import { getBotReply } from './supportChatEngine';
 *   const reply = await getBotReply(userMessage, userId, conversationContext);
 */

import { finalShippingFee, getSettlementState, outstandingBalance, SETTLEMENT_STATE } from '../constants/status.js';
import { formatMoney } from '../utils/currencyInput.js';
import { SUPPORT_KNOWLEDGE_CATALOG } from './supportKnowledgeCatalog.js';

export const createSupportChatEngine = (supabase) => {
const MAX_MESSAGE_LENGTH = 1000;
const BOT_WELCOME_BACK = `Welcome back! 👋

I'm CargoMate PH, your support assistant.

Choose a topic below, or talk to an admin. You do not need to type a question.`;
const CONTEXT_VERSION = 1;

/**
 * The bot keeps only routing state in memory. It intentionally does not put
 * order rows, payment history, names, addresses, or other customer records in
 * browser storage. The page owns one context per authenticated user and chat
 * conversation; callers can discard it on logout, account switch, handoff, or
 * a new conversation.
 */
const createConversationContext = (userId, conversationId = null) => ({
  version: CONTEXT_VERSION,
  userId: userId || null,
  conversationId: conversationId || null,
  currentTopic: null,
  pendingClarification: null,
  selectedBookingId: null,
  selectedTrackingNumber: null,
  selectedChoices: {},
  lastActionId: null,
  backActionId: null,
  consecutiveUnrecognizedReplies: 0,
  preferredLanguage: 'en',
});

const resetConversationContext = (context, userId = null, conversationId = null) => {
  const next = createConversationContext(userId, conversationId);
  if (context && typeof context === 'object') Object.assign(context, next);
  return context || next;
};

const getSupportKnowledgeCatalog = () => SUPPORT_KNOWLEDGE_CATALOG.map(entry => ({ ...entry, examples: [...entry.examples] }));

// Menu actions are deliberately separate from the visible labels. The page
// sends these stable IDs back to the engine, so a translated label or an old
// button in chat history can never be mistaken for a free-text command.
const SUPPORT_ACTIONS = Object.freeze({
  MAIN_MENU: 'main_menu',
  MY_BOOKINGS: 'my_bookings',
  SHOW_MORE_BOOKINGS: 'show_more_bookings',
  SELECT_BOOKING: 'select_booking',
  CHOOSE_ANOTHER_BOOKING: 'choose_another_booking',
  BOOKING_STATUS: 'booking_status',
  PAYMENT_DETAILS: 'payment_details',
  TRIP_DETAILS: 'trip_details',
  OPEN_BOOKING: 'open_booking',
  PAYMENT_REFUND: 'payment_refund',
  PAYMENT_METHODS: 'payment_methods',
  PAYMENT_BOOKING: 'payment_booking',
  REFUND_GUIDANCE: 'refund_guidance',
  HOW_TO_BOOK: 'how_to_book',
  BOOK_NEW: 'book_new',
  SHIPPING_INFO: 'shipping_info',
  SHIPPING_RATES: 'shipping_rates',
  SERVICE_AREAS: 'service_areas',
  PACKAGING: 'packaging',
  RESTRICTED_ITEMS: 'restricted_items',
  PICKUP_DELIVERY: 'pickup_delivery',
  CONTACT: 'contact',
  TALK_TO_ADMIN: 'talk_to_admin',
  RETRY: 'retry',
  BACK: 'back',
});

const menuAction = (id, label, extra = {}) => ({ id, label, ...extra });

const getMainMenuActions = () => [
  menuAction(SUPPORT_ACTIONS.MY_BOOKINGS, 'My bookings'),
  menuAction(SUPPORT_ACTIONS.PAYMENT_REFUND, 'Payment and refunds'),
  menuAction(SUPPORT_ACTIONS.HOW_TO_BOOK, 'How to book'),
  menuAction(SUPPORT_ACTIONS.SHIPPING_INFO, 'Shipping information'),
  menuAction(SUPPORT_ACTIONS.TALK_TO_ADMIN, 'Talk to an admin'),
];

const menuActions = {
  main: getMainMenuActions,
  payment: () => [
    menuAction(SUPPORT_ACTIONS.PAYMENT_METHODS, 'Ways to pay'),
    menuAction(SUPPORT_ACTIONS.PAYMENT_BOOKING, 'Payment details for a booking'),
    menuAction(SUPPORT_ACTIONS.REFUND_GUIDANCE, 'Cancellation and refund guidance'),
    menuAction(SUPPORT_ACTIONS.BACK, 'Back'),
    menuAction(SUPPORT_ACTIONS.MAIN_MENU, 'Main menu'),
    menuAction(SUPPORT_ACTIONS.TALK_TO_ADMIN, 'Talk to an admin'),
  ],
  shipping: () => [
    menuAction(SUPPORT_ACTIONS.SHIPPING_RATES, 'Shipping rates'),
    menuAction(SUPPORT_ACTIONS.SERVICE_AREAS, 'Service areas'),
    menuAction(SUPPORT_ACTIONS.PACKAGING, 'Packaging'),
    menuAction(SUPPORT_ACTIONS.RESTRICTED_ITEMS, 'Restricted items'),
    menuAction(SUPPORT_ACTIONS.PICKUP_DELIVERY, 'Pickup and delivery process'),
    menuAction(SUPPORT_ACTIONS.CONTACT, 'Contact information'),
    menuAction(SUPPORT_ACTIONS.BACK, 'Back'),
    menuAction(SUPPORT_ACTIONS.MAIN_MENU, 'Main menu'),
    menuAction(SUPPORT_ACTIONS.TALK_TO_ADMIN, 'Talk to an admin'),
  ],
  booking: () => [
    menuAction(SUPPORT_ACTIONS.BOOKING_STATUS, 'Booking status'),
    menuAction(SUPPORT_ACTIONS.PAYMENT_DETAILS, 'Payment and refund details'),
    menuAction(SUPPORT_ACTIONS.TRIP_DETAILS, 'Trip details'),
    menuAction(SUPPORT_ACTIONS.OPEN_BOOKING, 'Open booking'),
    menuAction(SUPPORT_ACTIONS.CHOOSE_ANOTHER_BOOKING, 'Choose another booking'),
    menuAction(SUPPORT_ACTIONS.BACK, 'Back'),
    menuAction(SUPPORT_ACTIONS.MAIN_MENU, 'Main menu'),
    menuAction(SUPPORT_ACTIONS.TALK_TO_ADMIN, 'Talk to an admin'),
  ],
};

const withMenuActions = (reply, actions) => ({
  ...reply,
  actions: typeof actions === 'function' ? actions() : actions,
});

// ── Escalation keywords (bypass chatbot entirely → go straight to admin) ──────
//
// Grouped by meaning, with English (EN), Tagalog (TL) and Bisaya/Cebuano (CEB)
// spellings side by side — customers type Taglish and Bislish freely in one
// sentence, so splitting these into per-language tables would not help.
//
// Local words are anchored with \b on purpose. Bare "sira" without boundaries
// matches "de-sira-ble"; bare "guba" matches "gubat".
//
// Note the deliberate omission: bare "wala pa" / "asa na" / "hain na" are
// ordinary status questions and are handled by the INTENTS below, NOT here.
// Only the complaint-flavoured forms ("wala pa gihapon", "wala pa rin hanggang
// ngayon", "wala pa niabot") escalate.
const ESCALATION_PATTERNS = [
  // ── Complaints ──────────────────────────────────────────────────────────────
  /compla(int|in)/i,                                                  // EN
  /\b(mag|nag|mang|mo|mu|na)?reklamo\b/i,                             // TL/CEB
  /\bmureklamo\b/i,                                                   // CEB
  /\b(di|hindi|dili)\s*(ako|ko|ka)?\s*(satisfied|kontento|nalipay)\b/i,
  /\b(pangit|bulok|walang?\s*kwenta|walay?\s*pulos)\b/i,              // TL/CEB
  /\bsobrang\s*(bagal|tagal|delay)\b/i,                               // TL
  /\bkadugay\b/i,                                                     // CEB "so slow"

  // ── Damaged / broken cargo ──────────────────────────────────────────────────
  // Require a shipment/customer subject so packaging advice such as "is this
  // fragile item allowed?" does not accidentally become a complaint handoff.
  /\b(my|our|the)\s+(package|shipment|parcel|cargo|item)\b.*\b(damaged?|broken|crushed)\b/i,
  /\b(damaged?|broken|crushed)\b.*\b(package|shipment|parcel|cargo|item)\b/i,
  /\b(arrived|received|nareceive|nadawat)\b.*\b(damaged?|broken|crushed|sira|guba|basag|nabasa)\b/i,
  /\b(nasira|guba|basag|nabasa|nabuak|nahulog|natapon|nayabo)\b.*\b(ang|akong|yung|ung|my|package|padala|parcel|cargo|item)\b/i,

  // ── Lost / missing / stolen ─────────────────────────────────────────────────
  /\b(my|our|the)\s+(package|shipment|parcel|item)\b.*\b(lost|missing|stolen)\b/i, // EN
  /\b(lost|missing|stolen)\b.*\b(package|shipment|parcel|item)\b/i,        // EN
  /\bnawa(la|wala|le)\b.*\b(ang|akong|ung|yung|package|padala)\b/i,       // TL/CEB
  /\bnangawala\b.*\b(ang|akong|yung|padala)\b/i,                         // TL/CEB
  /\bwala\s*na\s*(ang|akong|ung|yung|ako)\b/i,                        // TL/CEB
  /\b(nanakaw|ninakaw|nakawan|gikawat|kawaton|kinawat)\b/i,           // TL/CEB
  /\bkulang\s*(ang|akong|ung|yung|ko)\b/i,                            // TL/CEB (short)
  /\bwa\s*(na)?\s*(koy|nako)\s*nadawat\b/i,                           // CEB
  /\bhindi\s*(ko)?\s*natanggap\b/i,                                   // TL

  // ── Undelivered for too long (complaint form, not a plain status check) ─────
  /\bwala\s*pa\s*(rin|din|gihapon|gyud|gyod|jud)\b/i,                 // TL/CEB
  /\bwala\s*pa\s*(hanggang|hangtod|hangtud)\s*(ngayon|karon)\b/i,     // TL/CEB
  /\bwala\s*pa\s*((ni|na|no|mo|nag|niy)\s*)?(abot|abut|dating|dumating|hatod|nadawat)/i, // TL/CEB
  /\b(hindi|di)\s*pa\s*(rin|din)?\s*(dumating|naghatid|nakarating)\b/i, // TL
  /\bansabi?\s*(nang|ng)?\s*ilang\s*araw/i,                           // TL

  // ── Case-specific refund / reimbursement ────────────────────────────────────
  // Policy questions are handled by the refund_policy FAQ below. These forms
  // ask for a case decision, missing money, or a refund action and need a
  // human instead of an invented promise.
  /\b(refund|reimburse(?:ment)?)\b.*\b(me|my|this|it|request|case|pending|missing|not\s*(received|reflected|showing)|status)\b/i,
  /\b(my|our|the)\s+(refund|money\s*back|reimbursement)\b/i,
  /\b(refund|reimburse(?:ment)?)\b\s*(me|this|it|please|now)\b/i,
  /\bibalik\s*(ang|akong|ung|yung)?\s*(bayad|pera|kwarta|kuwarta)\b/i, // TL
  /\b(iuli|isauli|sauli|iulî)\b.*\b(bayad|pera|kwarta|refund)\b/i,       // CEB
  /\bbawi(in)?\s*(ang|ko|akong)?\s*(bayad|pera|kwarta)\b/i,              // TL
  /\bbayaran\s*(ninyo|niyo|mo)\b/i,                                      // TL

  // ── Urgency ─────────────────────────────────────────────────────────────────
  /urgent/i,  /emergency/i,  /\basap\b/i,                             // EN
  /\b(dalian|madalian|apurado|apura|nagdali|dinali)\b/i,              // TL
  /\b(dalio?n|paspasa|kinahanglan\s*dayon)\b/i,                       // CEB
  /\bimportante\s*(ni|ito|to|kaayo)\b/i,                              // TL/CEB

  // ── Asking for a human ──────────────────────────────────────────────────────
  /supervisor/i,  /manager/i,                                         // EN
  /talk\s*to\s*(admin|human|agent|person|staff|support)/i,             // EN
  /speak\s*to\s*(admin|human|agent|person|staff|support)/i,            // EN
  /connect\s*me\s*to/i,                                               // EN
  /real\s*(person|human|agent|admin)/i,                                // EN
  /human\s*(agent|support|help)/i,                                     // EN
  /\bhuman\b/i,  /\bagent\b/i,                                        // EN
  /\b(maka|ma|mag|makig|nakig|mo|mu|pa)?(kausap|kausapin|kausap)\b/i,  // TL
  /\bmakausap\b/i,  /\bkausapin\s*(ko|ninyo|niyo)\b/i,                // TL
  /\b(mag|maka|makig|nakig|mo|mu)?(i|e)?storya\b/i,                   // CEB (estorya/istorya)
  /\b(makig|nakig|magki|makipag)-?(storya|usap|sulti)\b/i,            // TL/CEB
  /\b(maka)?sulti\s*(ko|ta|ako|nako)?\b/i,                            // CEB
  /\b(totoo|tunay|tinuod)\s*(ng|na|nga)?\s*(tao|tawo)\b/i,            // TL/CEB
  /\b(tao|tawo)\s*(ang|na|nga)?\s*(kausap|kastorya|katabang)\b/i,     // TL/CEB
  /\b(kausap|storya|sulti|usap|kontak|tawag)\w*\s*(ko|ako|nako)?\s*(sa|ug|og|ng|nang)?\s*(tao|tawo|admin|staff|opisina)\b/i,
  /\b(pa)?tawag\w*\s*(ninyo|niyo|nyo|ko)\b/i,                         // TL/CEB
  /\blive\s*(chat|person|support)\b/i,                                // EN
];

const PAYMENT_CASE_PATTERNS = [
  /\b(gcash|paymongo|payment|bayad|hulog)\b.*\b(not\s*(reflected|showing|received|posted)|pending|missing|hindi\s*(pumasok|nagreflect|nag\s*reflect)|di\s*pa\s*(pumasok|nagreflect)|wala\s*pa)\b/i,
  /\b(not\s*(reflected|showing|received|posted)|pending|missing)\b.*\b(gcash|paymongo|payment|bayad|hulog)\b/i,
];

const NEGATION_PATTERN = /\b(not|no|never|hindi|di|dili|wala|walay)\b/i;

const isRefundPolicyQuestion = message =>
  /\b(refund|reimburse(?:ment)?|money\s*back)\b/i.test(message) &&
  /\b(policy|process|rules?|automatic|eligible|eligibility|how\s*does?)\b/i.test(message) &&
  !/\b(pending|missing|not\s*(received|reflected|showing)|request|status|i\s*want|gusto\s*ko|ibalik|iuli|isauli)\b/i.test(message);

const isPackagingQuestion = message =>
  /\b(packag(?:e|ing)|packing|pack|balot|balutan|impake|putos|bubble\s*wrap|fragile|kahon|karton|box)\b/i.test(message) &&
  (!/\b(arrived|received|damaged?|broken|crushed|nasira|guba|basag|nabasa|nabuak)\b/i.test(message) ||
    /\b(not|no|hindi|di|dili|wala)\s+(?:my\s+)?(?:package\s+)?(damaged?|broken|crushed|nasira|guba|basag)\b/i.test(message));

const shouldEscalate = message => {
  const trimmed = String(message || '').trim();
  if (!trimmed) return false;
  if (/\b(are\s*you|r\s*u)\s*(a\s*)?(bot|robot|human|real\s*person|ai)\b|\b(sino|kinsa)\s*ka\b/i.test(trimmed)) return false;
  if (/\b(talk|speak|connect|live\s*chat|human|agent|admin|supervisor|manager|tao|tawo)\b/i.test(trimmed)) return true;
  if (isRefundPolicyQuestion(trimmed) || isPackagingQuestion(trimmed)) return false;
  if (TRACKING_NUMBER_RX.test(trimmed) && /\b(refund|reimburse(?:ment)?)\b/i.test(trimmed)) return true;
  if (NEGATION_PATTERN.test(trimmed) && /\b(human|agent|admin|complaint|reklamo|refund|damaged?|broken|lost|missing)\b/i.test(trimmed)) {
    // "I don't need a human" and "not damaged" are not handoff requests.
    if (!/\b(not|hindi|di|dili)\s*(resolved|solved|fixed|okay|satisfied)\b/i.test(trimmed)) return false;
  }
  return ESCALATION_PATTERNS.some(rx => rx.test(trimmed)) || PAYMENT_CASE_PATTERNS.some(rx => rx.test(trimmed));
};

// ── Tracking numbers ───────────────────────────────────────────────────────────

// CE-YYYYMMDD-NNNN, the format generated by generate_order_tracking_number().
// Separators are loose (dash, space, none) because customers retype these by
// hand from a screenshot; the extracted value is normalised before querying.
const TRACKING_NUMBER_RX = /\bCE[-\s]?(\d{8})[-\s]?(\d{4})\b/i;
const TRACKING_PAYMENT_RX = new RegExp(
  `(?:\\b(payment|pay|bayad|balance|utang|refund)\\b.*${TRACKING_NUMBER_RX.source}|${TRACKING_NUMBER_RX.source}.*\\b(payment|pay|bayad|balance|utang|refund)\\b)`,
  'i',
);

const extractTrackingNumber = (message) => {
  const m = TRACKING_NUMBER_RX.exec(message || '');
  return m ? `CE-${m[1]}-${m[2]}` : null;
};

// ── Pattern helpers ────────────────────────────────────────────────────────────

// Filipino locative question words. "nasaan na ang padala ko" and "padala ko"
// share every noun, so possessive patterns in the earlier `booking_status`
// intent must decline the ones that are really location questions.
const LOCATIVE_WORDS = 'nasaan|nasa\'?n|saan|san|asa|hain|diin|wala\\s*pa|hindi\\s*pa|dili\\s*pa';

// Warehouse nouns — an arrival question naming one of these belongs to
// `hub_arrival`, which is matched after `delivery_status`.
const HUB_WORDS = 'hub|bodega|warehouse|terminal|pier|port';

// Payment terms that merely CONTAIN the word "delivery": "cash on delivery",
// "COD", "freight collect". Without this guard the bare `deliver(y|ed|ing)`
// pattern in `delivery_status` claims them and answers "your parcel is In
// Transit" to somebody asking whether they can pay at the door.
const PAYMENT_TERM_WORDS = 'cash|g-?cash|c\\.?o\\.?d|collect|paymongo';

// Duration cues — "ilang araw ang delivery" asks for the timeline, not for the
// state of this customer's parcel.
const DURATION_WORDS = 'ilang|ilan\\s*ka|pila\\s*ka|pila|gaano|ga\'?no|katagal|kadugay|how\\s*long|how\\s*many';

/**
 * unless — the given pattern source, refused when the message anywhere contains
 * one of `words`. Anchored at ^ so the negative lookahead is evaluated once
 * against the whole message; an inline `(?!…)` placed mid-pattern is simply
 * backtracked around and silently does nothing.
 */
const unless = (words, source) => new RegExp(`^(?!.*\\b(${words})\\b).*${source}`, 'i');

const NO_LOCATIVE = (source) => unless(LOCATIVE_WORDS, source);

// Places customers actually name when asking whether we go there. Used by
// `service_areas`: a bare "pwede ba sa …" is too loose to be an intent on its
// own — "pwede ba sa Lunes?" is not a coverage question — so both of its
// open-ended patterns require one of these to appear.
const PLACE_WORDS = 'cebu|davao|iloilo|bacolod|leyte|samar|negros|siquijor|dumaguete|cagayan|zamboanga|butuan|surigao|mindanao|luzon|visayas|manila|maynila|makati|quezon|caloocan|pasig|paranaque|bohol|tagbilaran|panglao|ubay|talibon|tubigon|jagna|cavite|laguna|batangas|bulacan|rizal|pampanga|bicol|palawan|baguio|province|probinsya|probinsiya';

const TOPIC_OPTIONS = [
  { id: 'booking', label: 'Booking', aliases: ['booking', 'bookings', 'book', 'order', 'padala'] },
  { id: 'payment', label: 'Payment', aliases: ['payment', 'payments', 'bayad', 'balance', 'gcash'] },
  { id: 'delivery', label: 'Delivery and tracking', aliases: ['delivery', 'tracking', 'location', 'status', 'shipment'] },
  { id: 'pickup', label: 'Pickup and packaging', aliases: ['pickup', 'pick up', 'packaging', 'packing', 'drop off', 'drop-off'] },
  { id: 'refund', label: 'Cancellation and refunds', aliases: ['refund', 'cancel', 'cancellation'] },
];

const INTENT_TOPIC = {
  booking_status: 'booking', tracking_number: 'booking', how_to_book: 'booking', additional_cargo: 'booking', booking_changes: 'booking',
  payment_info: 'payment', mode_of_payment: 'payment', payment_history: 'payment',
  shipment_location: 'delivery', delivery_status: 'delivery', hub_arrival: 'delivery', trip_info: 'delivery', delivery_timeline: 'delivery',
  pickup_status: 'pickup', packaging_guidelines: 'pickup', weight_limits: 'pickup', office_location: 'pickup',
  refund_policy: 'refund', cancellation_policy: 'refund',
  service_areas: 'delivery', prohibited_items: 'pickup', cargo_eligibility: 'pickup', pricing: 'payment', contact_info: 'pickup', account_help: 'account',
};

const TOPIC_MENU_TEXT = `I can help with:

1. Booking
2. Payment and balance
3. Delivery and tracking
4. Pickup and packaging
5. Cancellation and refunds

Reply with a number or type your question. You can also send a tracking number like CE-20260920-1988.`;

const TOPIC_FOLLOWUPS = {
  booking: {
    text: 'For Booking, which do you need?\n\n1. How to book\n2. Check my bookings\n3. Change or cancel a booking\n\nReply with a number or type your question.',
    options: ['How to book', 'Check my bookings', 'Change or cancel a booking'],
  },
  payment: {
    text: 'For Payment, which do you need?\n\n1. Ways to pay\n2. My balance or payment status\n3. Payment history or refunds\n\nReply with a number or type your question.',
    options: ['Ways to pay', 'My balance or payment status', 'Payment history or refunds'],
  },
  delivery: {
    text: 'For Delivery and tracking, which do you need?\n\n1. Shipment status\n2. Shipment location\n3. Trip or delivery details\n\nReply with a number or type your question.',
    options: ['Shipment status', 'Shipment location', 'Trip or delivery details'],
  },
  pickup: {
    text: 'For Pickup and packaging, which do you need?\n\n1. Pickup status\n2. Packing or item rules\n3. Office or drop-off details\n\nReply with a number or type your question.',
    options: ['Pickup status', 'Packing or item rules', 'Office or drop-off details'],
  },
  refund: {
    text: 'For Cancellation and refunds, which do you need?\n\n1. Refund policy\n2. Request or check a specific refund\n3. Cancel a booking\n\nReply with a number or type your question.',
    options: ['Refund policy', 'Specific refund help', 'Cancel a booking'],
  },
};

const normalizeMessage = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE_LENGTH);

const detectPreferredLanguage = message => {
  if (/\b(unsa|asa|hain|pila|kanus|kinahanglan|modawat|maayong|gusto|nako|namo|ug|og)\b/i.test(message)) return 'ceb';
  if (/\b(paano|pano|magkano|bayad|saan|nasaan|kailangan|pwede|hindi|wala|salamat|ano|may)\b/i.test(message)) return 'tl';
  return 'en';
};

const detectTopic = message => {
  const lower = message.toLowerCase();
  const match = TOPIC_OPTIONS.find(option => option.aliases.some(alias => lower.includes(alias)));
  return match?.id || null;
};

const parseChoice = (message, options = []) => {
  const normalized = message.toLowerCase().replace(/[.?!,]/g, '').trim();
  if (/^(back|go back|b|balik|ulî|uli)$/i.test(normalized)) return { type: 'back' };
  const numeric = normalized.match(/^(\d+|one|two|three|four|five|first|second|third|fourth|fifth)$/i);
  if (numeric) {
    const words = { one: 1, first: 1, two: 2, second: 2, three: 3, third: 3, four: 4, fourth: 4, five: 5, fifth: 5 };
    const index = Number(numeric[1]) || words[numeric[1]];
    if (index >= 1 && index <= options.length) return { type: 'option', index: index - 1 };
  }
  const index = options.findIndex(option => {
    const label = typeof option === 'string' ? option : option.label;
    return label && normalized === label.toLowerCase();
  });
  return index >= 0 ? { type: 'option', index } : null;
};

const isBareYes = message => /^(yes|yeah|yep|y|oo|opo|sige|okay|ok|tama|correct)$/i.test(message.trim());
const isBareNo = message => /^(no|nope|n|hindi|di|dili|not really)$/i.test(message.trim());
const isBareHow = message => /^(how|how\s*to|paano|pano|panu|unsaon|what\s*do\s*i\s*do)$/i.test(message.trim());

// ── Intent matchers ────────────────────────────────────────────────────────────
//
// Every intent carries English (EN), Tagalog (TL) and Bisaya/Cebuano (CEB)
// phrasings. First match in this array wins, so the local patterns are scoped
// to the same specificity as their English neighbours: shared words that could
// belong to two intents ("magkano", "numero", "naabot") always require a
// disambiguating noun rather than matching bare.
const INTENTS = [
  // Who am I. First in the array on purpose: "kumusta, sino ka?" and "hi,
  // what's your name?" both open with a greeting, and `greeting` matches on a
  // ^-anchored hello. Placed after it, the question would be answered with a
  // menu that never says the name that was asked for.
  {
    id: 'bot_identity',
    patterns: [
      // The negative lookahead keeps "who are you sending it to" — a question
      // about the RECIPIENT — out of the bot's own-name answer.
      /who\s*are\s*you\b(?!\s*(sending|shipping|delivering|talking|calling|texting|referring))|what'?s?\s*(is\s*)?your\s*name/i, // EN
      /\b(are\s*you|r\s*u)\s*(a\s*)?(bot|robot|human|real\s*person|ai)\b/i,  // EN
      /ano(ng)?\s*pangalan\s*mo|sino\s*ka/i,                                  // TL
      /ano\s*(po\s*)?(ang|ung|yung)\s*pangalan\s*(mo|ninyo|niyo)/i,           // TL
      /unsa('?y)?\s*(name|ngalan)\s*nim[uo]|kinsa\s*ka/i,                      // CEB
      /unsa\s*(man\s*)?(imong|imo\s*nga)\s*(name|ngalan)/i,                   // CEB
    ],
    handler: async () => ({
      text: "I am CargoMate PH, your virtual assistant! 🤖\n\nAko si CargoMate PH — pwede kang magtanong sa English, Tagalog, o Bisaya.\n\nI can help you track your shipments, check our pricing (kada kilo / tagpila kada kilo), and get your booking details. How can I help you today?",
      askResolved: false,
    }),
  },

  {
    id: 'language_support',
    patterns: [
      /\b(can|do)\s*you\s*(speak|understand|know)\s*(tagalog|bisaya|cebuano|english|filipino)\b/i,
      /\b(marunong|nakakaintindi|nagsasalita)\s*(ka|po|ba)?\s*(ng|nang)?\s*(tagalog|bisaya|cebuano|english)\b/i,
      /\b(kamao|kasabot|maka-istorya)\s*(ba)?\s*(ka|mo)?\s*(og|ug)?\s*(tagalog|bisaya|cebuano|english)\b/i,
    ],
    handler: async () => ({
      text: "Yes! Pwede mo akong kausapin sa English, Tagalog, o Bisaya. Kung unsa'y sayon nimo, we can use it! How can I help you today?",
      askResolved: false,
    }),
  },

  // Greeting / hi / hello
  {
    id: 'greeting',
    patterns: [
      /^(hi+|hello+|hey|yo|good\s*(morning|afternoon|evening|day))\s*[!,.?]*$/i, // EN
      /^(mabuhay|kumusta|kamusta|k?musta|kmsta|hoy|uy|oy)\s*[!,.?]*$/i,           // TL
      /^(maayong|ma?ayong)\s*(buntag|hapon|udto|gabii|gabi|adlaw)\s*[!,.?]*$/i,   // CEB
      /^(magandang)\s*(umaga|hapon|gabi|araw)\s*[!,.?]*$/i,                       // TL
      /^(unsa\s*man|kumusta\s*ka|kamusta\s*po)\s*[!,.?]*$/i,                    // CEB/TL
      /^(pwede|puydi|puede)\s*(po|ko|ba)?\s*(mag)?tanong\s*[!,.?]*$/i,            // TL/CEB
      /^(tabang|help)\s*(po|ko|ba)?\s*[!,.?]*$/i,                                // CEB/EN
    ],
    handler: async () => ({
      text: 'Hi there! 👋 Kumusta! Maayong adlaw!\n\nHow can I help you today? You can write in English, Tagalog, or Bisaya — kahit anong lengguwahe, sabihin lang po.\n\nYou can ask me about your:\n• Shipment status — asa na ang padala ko?\n• Booking information — may booking ba ako?\n• Payment details — magkano ang bayad ko?\n• Tracking number\n• Delivery process',
      askResolved: false,
    }),
  },

  // ── Business FAQ block ─────────────────────────────────────────────────────
  // Positioned here, ABOVE booking_status and the locative intents, because
  // these six ask about the SERVICE while everything below asks about the
  // customer's own parcel, and several phrasings are shared between the two.
  // "Hanggang saan ang padala niyo?" is a coverage question, but
  // shipment_location's `saan … padala` pattern would read it as "where is my
  // parcel"; whichever intent comes first wins, so the general question has to
  // be claimed before the personal one. Each pattern below is scoped tightly
  // enough that a message about one specific parcel still falls through.

  // Where we deliver / coverage
  {
    id: 'service_areas',
    patterns: [
      /where\s*(do|can)\s*(you|u|i)\s*(deliver|ship|send)/i,                   // EN
      /\bcoverage\b/i,                                                          // EN
      /\bservice\s*areas?\b/i,                                                  // EN
      /\bdo\s*(you|u)\s*(deliver|ship|serve|send)\s*(to|in)\b/i,                // EN
      /\bwhat\s*(areas?|places?|provinces?|routes?)\s*(do\s*)?(you|u)\s*(serve|cover|deliver)/i, // EN
      /\b(available|possible)\s*(ba)?\s*(ang)?\s*(delivery|shipping)\s*(to|sa)\b/i, // EN/TL
      // TL — "hanggang saan ang delivery", "may delivery ba sa Laguna"
      /\bhanggang\s*(saan|san)\b/i,
      /\b(saan|san|nasaan)\s*(po|ba)?\s*(kayo|kau|sila)\s*(naghahatid|nagdedeliver|nagpapadala|nagseserbisyo)\b/i,
      /\bmay\s*(delivery|hatid|padala|biyahe)\s*(po|ba)?\s*(kayo)?\s*(sa|hanggang)\b/i,
      /\b(sakop|saklaw)\b/i,                                                    // TL/CEB "covered area"
      // CEB — "asa mo maghatod", "unsa inyong sakop", "makahatod ba mo sa"
      /\b(asa|hain)\s*(man)?\s*(mo|kamo|inyo|inyong)\s*(mag)?-?\s*(hatod|deliver|padala|serbisyo)\b/i,
      /\b(asa|unsa)\s*(man)?\s*(ang)?\s*(inyong|inyo\s*nga)\s*(coverage|serbisyo|ruta)\b/i,
      /\bmakahatod\s*(ba)?\s*(mo|kamo)\b/i,
      // "pwede ba sa Cebu?" / "do you ship to Cavite?" — a bare "pwede ba sa"
      // is far too loose on its own ("pwede ba sa Lunes?"), so both of these
      // require an actual place name.
      new RegExp(`\\b(pwede|puydi|puede|possible|available|may|naa)\\b.*\\b(sa|to|in)\\s*(${PLACE_WORDS})\\b`, 'i'),
      new RegExp(`\\b(deliver|ship|hatod|padala)\\w*\\s*(ba|man|po)?\\s*(kayo|mo|you)?\\s*(sa|to|in)\\s*(${PLACE_WORDS})\\b`, 'i'),
    ],
    handler: async () => {
      // Read live for the same reason `pricing` reads the rate live: coverage
      // is admin-editable (company_information.coverage, the JSONB the About
      // page and the admin Coverage tab both render). A region list typed into
      // this string would start lying the first time an admin adds one.
      const { data, error } = await supabase
        .from('company_information')
        .select('coverage')
        .single();
      if (error) throw error;
      const regions = (data?.coverage || [])
        .slice()
        .sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0))
        .map(r => r.name)
        .filter(Boolean);
      if (!regions.length) {
        return {
          text: 'I cannot confirm the current service areas right now because no coverage list is available. Please ask an administrator before booking a route.',
          askResolved: false,
        };
      }

      const areaLine = `Current coverage includes: ${regions.join(', ')}.`;

      return {
        text: `We specialize in sea freight connecting Bohol and Metro Manila! 🚢\n\n${areaLine}\n\nWe do not support other inter-island routes yet. Kung wala sa listahan ang lugar mo, tap “Talk to an Agent” and our admin will check it for you.`,
        askResolved: true,
      };
    },
  },

  // What we cannot carry
  {
    id: 'prohibited_items',
    patterns: [
      /\bprohibit(ed|ion|s)?\b/i,                                              // EN
      /\brestricted\s*items?\b/i,                                               // EN
      /\b(banned|contraband|not\s*allowed)\b/i,                                 // EN
      /\billegal\b/i,                                                           // EN
      /what\s*(items?|things?|kind)?\s*(can'?t|cannot|can\s*not|are\s*not)\s*(be\s*)?(ship|shipped|send|sent|carried)/i, // EN
      // TL — "bawal ipadala", "ano ang bawal", "pwede ba magpadala NG bigas"
      // ("ng" marks the item; "sa" marks a destination and belongs to
      // service_areas above, which is why the two are split on that word.)
      /\bbawal\b/i,
      /\b(anong|ano\s*ang|ano'?ng)\s*(mga)?\s*(bawal|hindi\s*pwede|di\s*pwede)\b/i,
      /\b(pwede|puede)\s*(po|ba)?\s*(mag)?-?\s*(padala|ipadala)\s*(ng|nang)\b/i,
      // CEB — "unsay bawal", "gidili", "pwede ba magpadala UG"
      /\bunsa('?y|\s*ang|\s*man)?\s*(ang)?\s*(bawal|gidili|dili\s*pwede)\b/i,
      /\bgidili\b/i,
      /\b(pwede|puydi)\s*(ba|man)?\s*(ko|mo)?\s*(mag)?-?\s*(padala|ipadala)\s*(ug|og)\b/i,
    ],
    handler: async () => ({
      text: "For safety, do not send illegal goods, hazardous chemicals, weapons, or undocumented regulated items. 🚫\n\nPerishable and fragile items may need special approval and packaging, and CargoExpress PH may refuse cargo that cannot be transported safely.\n\nIf you are unsure about an item, ask an administrator before booking.",
      askResolved: true,
    }),
  },

  // How to pack
  {
    id: 'packaging_guidelines',
    patterns: [
      /\bpackag(ing|e\s*requirement)/i,                                        // EN
      /\bpacking\b/i,                                                           // EN
      /how\s*(do\s*i|to|should\s*i)\s*pack\b/i,                                 // EN
      /\bdo\s*i\s*need\s*(a|an)?\s*(box|carton|sack|crate)\b/i,                 // EN
      /\b(box|carton|sack|crate)\s*(required|needed|necessary)\b/i,             // EN
      /\bbubble\s*wrap\b/i,                                                     // EN
      /\bfragile\b/i,                                                           // EN
      // TL — "kailangan ba ng karton", "paano magbalot"
      /\b(kailangan|kelangan)\s*(po|ba)?\s*(ng|nang|ba\s*ng)?\s*(karton|kahon|box|sako|kaha|balot)\b/i,
      /\b(paano|pano|panu)\s*(po|ba)?\s*(ang)?\s*(mag)?-?\s*(balot|balutan|impake|empake|pack)\b/i,
      // CEB — "unsaon pag putos", "kinahanglan ba ug kahon"
      /\bunsa-?on\s*(man)?\s*(pag)?-?\s*(putos|pagputos|empake|pack)\b/i,
      /\b(kinahanglan|gikinahanglan)\s*(ba)?\s*(ug|og|ang)?\s*(kahon|karton|box|sako)\b/i,
    ],
    handler: async () => ({
      // "measured during pickup" is the actual system rule, not a
      // simplification: package_weight was removed, so weight enters once from
      // the scale at pickup and the fee is computed from it.
      text: "Please ensure your items are packed securely in a sturdy box or sack! 📦\n\nFragile items must be well bubble-wrapped — siguraduhing maayos ang balot para hindi masira sa biyahe.\n\nThe exact shipping weight will be measured during pickup to calculate your final fee.",
      askResolved: true,
    }),
  },

  // Weight limits
  {
    id: 'weight_limits',
    patterns: [
      /\b(minimum|maximum|max|min)\s*(weight|kilo|kilos|kg|bigat|timbang)\b/i,  // EN/TL
      /\bweight\s*(limit|restriction|cap|requirement)\b/i,                      // EN
      /\b(limit|limitasyon)\b.*\b(weight|kilo|kg|bigat|timbang|gramo)\b/i,      // EN/TL
      /\bhow\s*(heavy|many\s*kilos?)\b/i,                                       // EN
      /\b(oversized|overweight)\b/i,                                            // EN
      // TL — "may limit ba", "pinakamabigat na pwede"
      /\bmay\s*(limit|limitasyon)\s*(po|ba)\b/i,
      /\b(pinaka)?(mabigat|magaan)\s*(na|ng)?\s*(pwede|kaya)\b/i,
      /\b(ilang|ilan)\s*(po|ba)?\s*(ang)?\s*(kilo|kilos)\b/i,
      // CEB — "pila ang minimum", "naa bay limit"
      /\bpila\s*(man|ba)?\s*(ang|ka)?\s*(minimum|maximum|max|limit)\b/i,
      /\bnaa\s*ba'?y?\s*(limit|limitasyon)\b/i,
      /\b(kinabug-?atan|pinakabug-?at)\b/i,
    ],
    handler: async () => ({
      text: "We can handle anything from small parcels to bulky cargo! ⚖️\n\nYour shipping fee is computed based on the actual weight recorded at pickup — walang estimate, timbang sa pickup ang basehan.\n\nIf your cargo is extremely heavy or oversized, please let our admin know in advance so they can plan the space for it.",
      askResolved: true,
    }),
  },

  // Office / terminal location
  //
  // Ahead of contact_info, which also answers "asa ang opisina" — but with
  // phone numbers. A drop-off question wants a place, so it is answered with
  // the terminals and a hand-off for the exact pin.
  {
    id: 'office_location',
    patterns: [
      /\b(where|saan|san|nasaan|asa|hain)\b.*\b(office|opisina|branch|sangay|hub|terminal|warehouse|bodega)\b/i, // EN/TL/CEB
      /\b(office|hub|terminal|branch|warehouse)\s*(location|address)\b/i,       // EN
      /\b(address|lokasyon|location)\s*(ninyo|niyo|nimo|ninyu|inyo|inyong|mo)\b/i, // TL/CEB
      /\b(pinned?\s*location|google\s*maps?|waze)\b/i,                          // EN
      /\bdrop\s*-?\s*off\s*(point|location|area|site)\b/i,                       // EN
      /\b(saan|san)\s*(po|ba)?\s*(ako|kami)?\s*(pwedeng?|puwedeng?)?\s*(mag)?-?\s*(drop|dala|hulog|deposit)\b/i, // TL
      /\b(asa|hain)\s*(man)?\s*(ko|mi)?\s*(mo|mu)?-?\s*(hatod|deposit|drop)\b/i, // CEB
    ],
    handler: async () => {
      const { data, error } = await supabase.from('company_information').select('manila_address, bohol_address').single();
      if (error) throw error;
      const locations = [
        data?.bohol_address && `Bohol: ${data.bohol_address}`,
        data?.manila_address && `Manila: ${data.manila_address}`,
      ].filter(Boolean);
      return {
        text: locations.length
          ? `Current office or terminal details:\n\n${locations.join('\n')}\n\nAsk an administrator for a pinned drop-off location if the address is not enough.`
          : 'I cannot confirm the current office or drop-off addresses right now. Please ask an administrator before going to a terminal.',
        askResolved: Boolean(locations.length),
      };
    },
  },

  // Refund policy is an FAQ. A request for a particular refund is kept in the
  // escalation patterns above so the bot never promises a financial outcome.
  {
    id: 'refund_policy',
    patterns: [
      /\b(refund|reimburse(?:ment)?|money\s*back)\b.*\b(policy|process|work|rules?|automatic|eligible|eligibility)\b/i,
      /\b(policy|process|rules?)\b.*\b(refund|reimburse(?:ment)?|money\s*back)\b/i,
      /\bautomatic(?:ally)?\s*(ba|is)?\s*(ang)?\s*(refund|reimbursement)\b/i,
      /\brefund\s*(ba|po)?\s*(ba)?\s*(ang)?\s*(booking|cancellation|cancel)\b/i,
      /\b(ibabalik|mababalik)\s*(ba)?\s*(ang)?\s*(bayad|pera)\b/i,
    ],
    handler: async () => ({
      text: 'Cancellation does not automatically mean that money is returned. Refund eligibility and the amount depend on the booking status, the payment recorded, and the applicable booking terms.\n\nTo check one booking, send its tracking number and ask about payment details. For a refund request or a missing/pending refund, I will connect you with an administrator so they can review the case.',
      askResolved: true,
    }),
  },

  // Editing/cancellation stays informational. The bot never changes a booking.
  {
    id: 'booking_changes',
    patterns: [
      /\b(can|may)\s*i\s*(edit|change|update|cancel)\s*(my)?\s*(booking|order|shipment)\b/i,
      /\bhow\s*(do|can)\s*i\s*(edit|change|update|cancel)\b/i,
      /\b(edit|change|update|cancel)\s*(my)?\s*(booking|order|shipment)\b/i,
      /\b(paano|pano)\s*(mag)?\s*(cancel|baguhin|palitan)\b/i,
      /\bunsaon\s*(pag)?\s*(cancel|usab|ilis|bag-o)\b/i,
    ],
    handler: async () => ({
      text: 'You can review available booking actions from the booking details page. Some changes are restricted after pickup or once a trip has progressed.\n\nA cancellation is a request for administrator review; it does not cancel the booking immediately or guarantee a refund. I can explain the policy, but I cannot change a booking here.',
      askResolved: true,
    }),
  },

  // There is no "Book Additional Cargo" action in the application. The safe
  // answer is a new booking, with no promise that it shares the same trip.
  {
    id: 'additional_cargo',
    patterns: [
      /\b(add|book|send)\s*(another|additional|more)\s*(cargo|box|item|package|shipment)\b/i,
      /\b(additional|extra|another)\s*(cargo|box|package)\b/i,
      /\b(book|padala)\b.*\b(another|additional|isa\s*pa|dagdag)\b/i,
      /\b(pwede|puwede)\b.*\b(dagdag|isa\s*pa|another)\b.*\b(padala|kargo|box)\b/i,
    ],
    handler: async () => ({
      text: 'For another box or parcel, create a separate booking from the Book Shipment page. The system does not have a separate “add cargo” action, and a new booking is not guaranteed to travel on the same trip. Please ask an administrator if the trip connection matters.',
      askResolved: true,
    }),
  },

  {
    id: 'cargo_eligibility',
    patterns: [
      /\b(can|may|pwede|puwede)\s*i\s*(ship|send|padala|ipadala)\b.*\b(appliance|ref|refrigerator|cabinet|furniture|electronics?|tv|washing)\b/i,
      /\b(appliance|ref|refrigerator|cabinet|furniture|electronics?|tv|washing)\b.*\b(allowed|accepted|pwede|bawal|ship|padala)\b/i,
      /\b(allowed|accepted|eligible)\b.*\b(appliance|bulky|fragile)\b/i,
    ],
    handler: async () => ({
      text: 'Large, fragile, or electrical items may need special review and packaging. I cannot confirm acceptance from a keyword alone. Please tell an administrator the item, size, and condition before booking; they will confirm whether it can be safely transported.',
      askResolved: true,
    }),
  },

  {
    id: 'account_help',
    patterns: [
      /\b(forgot|forget|reset|change)\s*(my)?\s*(password|email|account)\b/i,
      /\bpassword\s*(reset|forgot|change)\b/i,
      /\b(paano|pano)\s*(mag)?\s*(reset|palit|bag-o)\s*(password|email)\b/i,
      /\bunsaon\s*(pag)?\s*(reset|usab|bag-o)\s*(password|email)\b/i,
    ],
    handler: async () => ({
      text: 'For a forgotten password, use “Forgot password?” on the login page. You can review profile details from your Profile page after signing in. I cannot change account credentials from chat.',
      askResolved: true,
    }),
  },

  // Booking / order existence — also the tracking-number lookup, since a
  // message naming one is asking about that specific parcel.
  {
    id: 'booking_status',
    patterns: [
      TRACKING_NUMBER_RX,                                                      // any language
      /active\s*booking/i,                                                     // EN
      /my\s*(order|booking)/i,                                                 // EN
      /\b(check|show|list)\s*(my|mine|all)?\s*(bookings?|orders?|shipments?)\b/i, // EN
      /do\s*i\s*have\s*(a|an)?\s*(order|booking)/i,                            // EN
      /any\s*(order|booking)/i,                                                // EN
      /booking\s*status/i,                                                     // EN
      /order\s*status/i,                                                       // EN
      // TL — "may booking/order/padala ba ako", "ilan ang booking ko"
      /\b(may|meron|mayroon|merong)\s*(\w+\s*)?(booking|order|padala|kargo|karga)\b/i,
      /\bilan\s*(ang|ung|yung)?\s*(booking|order|padala)\b/i,
      /\b(status|estado)\s*(ng|nang)\s*(booking|order|padala)\b/i,
      // CEB — "naa ba koy order", "pila akong padala", "unsa akong booking"
      /\bna(a|ay)\s*(ba)?\s*(ko|koy|ako|akoy|kay)\s*(\w+\s*)?(booking|order|padala|kargo)\b/i,
      /\bpila\s*(ka)?\s*(ang|akong|ko)?\s*(booking|order|padala)\b/i,
      /\bunsa\s*(ang|akong)\s*(booking|order|padala)\b/i,
      // Possessive-only forms ("padala ko", "akong booking") are guarded: the
      // same words appear in "nasaan na ang padala ko", which is a location
      // question owned by `shipment_location` further down. The guard is a
      // start-anchored lookahead so it cannot be defeated by backtracking.
      NO_LOCATIVE('\\b(booking|order|padala|kargamento)\\s*(ko|ko\\s*po|namin|natin|nako|nakoa|namo)\\b'),
      NO_LOCATIVE('\\bakong\\s*(booking|order|padala|kargamento)\\b'),
    ],
    handler: async (userId, message, context) => {
      // A message naming a tracking number is asking about THAT parcel, not
      // about the newest one. Answering with the latest order instead is how
      // "status of CE-20260714-0007" got a reply about a different shipment.
      const tracking = extractTrackingNumber(message);
      if (tracking) {
        const order = await fetchOrderByTrackingNumber(userId, tracking);
        // No guessing which order they meant — a wrong parcel's status is worse
        // than saying we could not find this one.
        if (!order) return trackingNotFoundReply(message);
        rememberOrder(context, order);
        return { text: describeOrder(order), askResolved: true };
      }

      const orders = await fetchCustomerOrders(userId, { includeCancelled: true });
      if (!orders.length) {
        return {
          text: "You currently don't have any bookings.\n\nWould you like to book a shipment? You can do so from the Book Shipment page.",
          askResolved: true,
        };
      }
      const total = await fetchCustomerOrderCount(userId);
      const shown = orders.slice(0, 5);
      setBookingSelection(context, shown);
      if (shown.length === 1) rememberOrder(context, shown[0]);
      const lines = shown.map((order, index) =>
        `${index + 1}. ${order.tracking_number} — ${order.status} (${order.origin} → ${order.destination})`
      ).join('\n');
      const more = total > shown.length ? `\n\nShowing the ${shown.length} most recent of ${total} bookings.` : '';
      return {
        text: `I found ${total} booking${total === 1 ? '' : 's'} under your account. Here are the most recent ones:\n\n${lines}${more}\n\nReply with a number or tracking number if you want details for one booking. Cancelled bookings are shown as cancelled, not as active shipments.`,
        askResolved: false,
        quickReplies: shown.map(order => order.tracking_number),
      };
    },
  },

  // Tracking number
  {
    id: 'tracking_number',
    patterns: [
      /tracking\s*(number|#|num)/i,                                            // EN
      /what('?s|\s*is)\s*(my)?\s*tracking/i,                                   // EN
      /find\s*my\s*tracking/i,                                                 // EN
      // TL — "ano ang tracking number ko", "numero ng tracking", "hanapin ang tracking"
      /\b(ano|anong|nasaan|saan)\s*(ang|ung|yung)?\s*(\w+\s*)?tracking\b/i,
      /\bnumero\s*(ng|nang|sa)\s*(tracking|padala|booking)\b/i,
      /\b(hanap|hanapin|pakita|patingin)\w*\s*(ang|ung|yung|ko)?\s*(\w+\s*)?tracking\b/i,
      /\btracking\s*(ko|namin|natin|nako|namo)\b/i,
      // CEB — "asa akong tracking", "unsa akong tracking number", "numero sa akong padala"
      /\b(asa|unsa|hain|diin)\s*(na)?\s*(ang|akong|ako|ko)?\s*(\w+\s*)?tracking\b/i,
      /\bnumero\s*(sa|ug|og)\s*(akong)?\s*(tracking|padala|booking)\b/i,
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
        text: `Here are your tracking numbers:\n\n${lines}\n\nSelect the booking in your Orders page or send one tracking number here for authorized details.`,
        askResolved: true,
      };
    },
  },

  // Shipment / package location / where is my package
  {
    id: 'shipment_location',
    patterns: [
      /where\s*(is)?\s*(my|the)?\s*(package|shipment|parcel|cargo)/i,          // EN
      /status\s*of\s*my\s*(shipment|order|package)/i,                          // EN
      /shipment\s*status/i,                                                    // EN
      /package\s*status/i,                                                     // EN
      /what\s*(is|'s)\s*(the)?\s*status/i,                                     // EN
      /update\s*on\s*my/i,                                                     // EN
      // TL — "nasaan na ang padala ko", "saan na ang package", "nasa'n na"
      /\b(nasaan|nasa'?n|saan|san)\s*(na|ba|po|nap[oa])?\s*(ang|ung|yung|si)?\s*(package|shipment|parcel|cargo|padala|kargamento|karga|item|gamit|box|kahon|order|booking)\b/i,
      /\b(nasaan|nasa'?n|saan|san)\s*na\s*(ba|po|kaya)?\s*\??$/i,
      /\b(anong|ano\s*ang|ano'?ng)\s*(status|estado|kalagayan)\b/i,
      /\b(status|estado)\s*(ng|nang|sa)\s*(akin|aking|padala|shipment|package)\b/i,
      /\bupdate\s*(naman|nga|po|ba)\b/i,
      /\bnasa\s*(saan|labas|daan|barko)\b/i,
      // CEB — "asa na ang padala nako", "hain na akong kargamento", "asa na ni"
      /\b(asa|hain|diin)\s*(na|man|ba|na\s*ba|nay)?\s*(ang|akong|ako|ni|kini|to|si)?\s*(package|shipment|parcel|cargo|padala|kargamento|karga|item|gamit|kahon|order|booking)\b/i,
      /\b(asa|hain|diin)\s*na\s*(man|ba|kaha|gud)?\s*\??$/i,
      /\bunsa\s*na\s*(ang|akong|ni)?\s*(status|estado|kahimtang|padala|kargamento)\b/i,
      TRACKING_NUMBER_RX,
      /\basa\s*na\s*(ni|to|ang)\s*(akong|ako)\b/i,
      /\bwala\s*pa\s*(ba)?\s*(ni|to|ang|akong|yung|ung)\b/i,
      /\bhindi\s*pa\s*ba\b/i,
    ],
    handler: async (userId, message, context) => {
      const order = await resolveOrder(userId, message, context);
      if (order === NOT_FOUND) return trackingNotFoundReply(message);
      if (order === NEEDS_SELECTION) return bookingSelectionReply(context);
      if (!order) {
        return {
          text: "You don't have any active bookings, so there's no shipment to track at the moment.",
          askResolved: true,
        };
      }
      return { text: describeOrder(order), askResolved: true };
    },
  },

  // Picked up?
  {
    id: 'pickup_status',
    patterns: [
      /already\s*picked\s*up/i,                                                // EN
      /has\s*(my|the)?\s*(package|shipment|order|parcel)\s*(been|already)?\s*picked/i, // EN
      /pick\s*up\s*status/i,                                                   // EN
      /when\s*(will|is)\s*(my)?\s*(package|shipment|order)?\s*(be|)?\s*picked/i, // EN
      // TL — "nakuha na ba", "kinuha na ba ang padala", "kailan susunduin"
      /\b(nakuha|kinuha|kuha|nasundo|sinundo)\s*na\s*(ba|po|kaya)?\b/i,
      /\bna(pick|pik)\s*-?\s*up\s*na\b/i,
      /\bpick\s*-?\s*up\s*na\s*(ba|po)\b/i,
      /\b(kailan|kelan|kailan\s*po)\s*(ang|ung|yung)?\s*(pick\s*-?up|susunduin|kukunin|pagkuha|pagsundo)\b/i,
      /\b(susunduin|kukunin|sinusundo)\b/i,
      // CEB — "gikuha na ba", "nakuha na ang padala", "kanus-a kuhaon/hakuton"
      /\b(gikuha|nakuha|gihakot|nahakot|gisundo|nasundo)\s*na\s*(ba|man|kaha)?\b/i,
      /\bkanus-?a\s*(man|ba)?\s*(ang|ni|akong)?\s*(kuhaon|hakuton|pagkuha|pick\s*-?up|sundoon)\b/i,
      /\b(kuhaon|hakuton|sundoon)\s*(na)?\s*(ba)?\b/i,
    ],
    handler: async (userId, message, context) => {
      const order = await resolveOrder(userId, message, context);
      if (order === NOT_FOUND) return trackingNotFoundReply(message);
      if (order === NEEDS_SELECTION) return bookingSelectionReply(context);
      if (!order) {
        return { text: "You don't have any bookings currently.", askResolved: true };
      }
      const pickedStatuses = ['Picked Up', 'In Transit', 'Arrived at Hub', 'Out for Delivery', 'Delivered'];
      const isPicked = pickedStatuses.includes(order.status);
      return {
        text: isPicked
          ? `✅ Yes! Your shipment (${order.tracking_number}) has already been picked up.\n\nCurrent status: ${order.status}`
          : `Your shipment (${order.tracking_number}) has not been picked up yet.\n\nCurrent status: ${order.status}\n\nOur team will schedule the pickup soon.`,
        askResolved: true,
      };
    },
  },

  // Out for delivery / delivered?
  {
    id: 'delivery_status',
    patterns: [
      /out\s*for\s*delivery/i,                                                 // EN
      /already\s*delivered/i,                                                  // EN
      /(is|has)\s*(my)?\s*(package|shipment|parcel|order)\s*(been|already)?\s*deliver/i, // EN
      /when\s*(will|is)\s*(my)?\s*(package|shipment)?\s*(be)?\s*deliver/i,     // EN
      // Bare "delivery" must not swallow "ilang araw ang delivery" (timeline) or
      // "nadeliver na sa bodega" (hub arrival) — both are matched further down.
      unless(`${DURATION_WORDS}|${HUB_WORDS}|${PAYMENT_TERM_WORDS}`, 'deliver(y|ed|ing)'), // EN
      // TL — "nadeliver na ba", "dumating na ba", "kailan darating/ihahatid"
      /\bna\s*-?\s*deliver\s*(na)?\s*(ba|po)?\b/i,
      unless(HUB_WORDS, '\\b(dumating|nakarating|narating|naihatid|naidala|nahatid)\\s*na\\b'),
      /\b(kailan|kelan)\s*(po)?\s*(ba)?\s*(darating|dadating|makakarating|ihahatid|maihahatid|idedeliver)\b/i,
      /\b(ihahatid|ihatid|hatid|paghahatid)\b/i,
      /\bnasa\s*labas\s*na\s*(ba)?\s*(para)?\s*(sa)?\s*(delivery|hatid)\b/i,
      // CEB — "nahatod na ba", "naabot na ba", "kanus-a ihatod/moabot"
      unless(HUB_WORDS, '\\b(nahatod|gihatod|nadala|gidala|naabot|niabot|nakaabot)\\s*na\\b'),
      /\bkanus-?a\s*(man|ba)?\s*(ni|ang|akong)?\s*(ihatod|haturon|moabot|muabot|mudating|abuton)\b/i,
      /\b(ihatod|haturon|ihatud)\b/i,
    ],
    handler: async (userId, message, context) => {
      const order = await resolveOrder(userId, message, context);
      if (order === NOT_FOUND) return trackingNotFoundReply(message);
      if (order === NEEDS_SELECTION) return bookingSelectionReply(context);
      if (!order) {
        return { text: "You don't have any bookings currently.", askResolved: true };
      }
      if (order.status === 'Delivered') {
        return {
          text: `✅ Your shipment (${order.tracking_number}) has been successfully delivered!`,
          askResolved: true,
        };
      }
      if (order.status === 'Out for Delivery') {
        return {
          text: `🚚 Your shipment (${order.tracking_number}) is currently out for delivery!\n\nOur delivery personnel is on their way to deliver your package.`,
          askResolved: true,
        };
      }
      return {
        text: `Your shipment (${order.tracking_number}) has not been delivered yet.\n\nCurrent status: ${order.status}\n\n${STATUS_DESCRIPTIONS[order.status] || ''}`,
        askResolved: true,
      };
    },
  },

  // Hub arrival
  {
    id: 'hub_arrival',
    patterns: [
      /arrived?\s*(at)?\s*(the)?\s*hub/i,                                      // EN
      /hub\s*arrival/i,                                                        // EN
      /(is|has)\s*(my)?\s*(package|shipment)?\s*(arrived?|reach)/i,            // EN
      /(warehouse|bodega|terminal|pier|port)\b/i,                              // EN/TL
      // TL — "nasa hub/bodega na ba", "nakarating na ba sa bodega"
      /\b(nasa|nandoon|andun|andoon)\s*(na)?\s*(sa)?\s*(hub|bodega|warehouse|terminal)\b/i,
      /\b(dumating|nakarating|narating)\s*na\s*(ba)?\s*(sa)?\s*(hub|bodega|warehouse)\b/i,
      // CEB — "naa na sa bodega", "abot na sa hub", "nakaabot na ba sa hub"
      /\bna(a|ay)\s*na\s*(ba)?\s*(sa)?\s*(hub|bodega|warehouse|terminal)\b/i,
      /\b(abot|naabot|niabot|nakaabot|nakab?ot)\s*na\s*(ba|man)?\s*(sa)?\s*(hub|bodega|warehouse)\b/i,
    ],
    handler: async (userId, message, context) => {
      const order = await resolveOrder(userId, message, context);
      if (order === NOT_FOUND) return trackingNotFoundReply(message);
      if (order === NEEDS_SELECTION) return bookingSelectionReply(context);
      if (!order) {
        return { text: "You don't have any bookings currently.", askResolved: true };
      }
      const arrivedStatuses = ['Arrived at Hub', 'Out for Delivery', 'Delivered'];
      const hasArrived = arrivedStatuses.includes(order.status);
      return {
        text: hasArrived
          ? `✅ Yes! Your shipment (${order.tracking_number}) has arrived at the destination hub.\n\nCurrent status: ${order.status}`
          : `Your shipment (${order.tracking_number}) has not yet arrived at the hub.\n\nCurrent status: ${order.status}`,
        askResolved: true,
      };
    },
  },

  // Payment / fee / cost / balance
  {
    id: 'payment_info',
    patterns: [
      /how\s*much\s*(is|are|do)?\s*(my|the|i)?\s*(shipping|pay|fee|cost|balance|owe|owed)/i, // EN
      /shipping\s*(fee|cost|rate|price)/i,                                     // EN
      /(payment|pay)\s*(status|info|information|detail)/i,                      // EN
      /\b(payment|refund)\s*history\b/i,                                      // EN
      TRACKING_PAYMENT_RX,
      // Bare "balance" and "outstanding" — "what is my outstanding balance?"
      // matched none of the older patterns, which all required a preceding
      // "remaining" / "how much".
      /\bbalance\b/i,                                                           // EN
      /\boutstanding\b/i,                                                       // EN
      /\bdues?\b/i,                                                             // EN
      /\bamount\s*(paid|due|owe|owing|remaining)?\b/i,                          // EN
      /do\s*i\s*(still)?\s*(have|owe)\s*(a)?\s*(balance|remaining|unpaid)/i,    // EN
      /is\s*my\s*payment\s*(done|complete|full)/i,                              // EN
      /paid\s*(already|in\s*full)?/i,                                           // EN
      /unpaid/i,                                                                // EN
      /partial\s*payment/i,                                                     // EN
      // TL — scoped to a payment noun on purpose; a bare "magkano" is a rate
      // question and belongs to the `pricing` intent further down.
      /\b(magkano|mgkno|mganu)\s*(pa|na|po|ba)?\s*(ang|ung|yung)?\s*(babayaran|bayad|utang|balanse|balance|kulang|hulog|kabuuan|total)\b/i,
      /\b(bayad|babayaran|balanse|utang|hulog)\s*(ko|namin|natin|ko\s*po)\b/i,
      /\b(nakabayad|bayad|nabayaran)\s*na\s*(ba|po|ako|kami)?\b/i,
      /\bmay\s*(pa)?\s*(utang|balanse|babayaran|kulang)\s*(pa)?\s*(ba)?\s*(ako)?\b/i,
      /\bkulang\s*(pa)?\s*(ba)?\s*(ang)?\s*(bayad|hulog)\b/i,
      /\b(resibo|risibo|receipt)\b/i,
      // Bare balance nouns in both local languages — "utang ko?", "balanse?".
      // Not `bayad` on its own: that one belongs to `pricing` as often as here.
      /\b(balanse|utang|bayronon|bayranan)\b/i,
      // CEB — same scoping rule as TL above
      /\b(pila|tagpila|pilay)\s*(pa|na|man|ba)?\s*(ang|akong|ako|ko)?\s*(bayad|bayronon|bayranan|utang|balanse|balance|kulang|total)\b/i,
      /\b(bayad|bayronon|bayranan|utang|balanse)\s*(nako|nakoa|namo|ko)\b/i,
      /\b(nakabayad|nabayran|bayad)\s*na\s*(ba|man)\s*(ko|ako|mi)?\b/i,
      /\bna(a|ay)\s*(pa)?\s*(ba)?\s*(ko|koy|akoy)\s*(utang|balanse|bayronon)\b/i,
    ],
    handler: async (userId, message, context) => {
      const order = await resolveOrder(userId, message, context);
      if (order === NOT_FOUND) return trackingNotFoundReply(message);
      if (order === NEEDS_SELECTION) return bookingSelectionReply(context);
      if (!order) {
        return { text: "You don't have any bookings, so there's no payment information to show.", askResolved: true };
      }

      const state = getSettlementState(order);
      const header = `💰 Payment details for ${order.tracking_number}:`;

      // No price means no financial amount yet; do not query payment history
      // just to turn three zeros into a misleading payment answer.
      if (state === SETTLEMENT_STATE.UNPRICED) {
        return {
          text: `${header}\n\n⚖️ Not priced yet.\n\nYour parcel is weighed at pickup and the shipping fee is computed from that weight, so there's no amount to show until then.\n\nCurrent status: ${order.status}`,
          askResolved: true,
        };
      }

      const activity = await fetchPaymentActivity(order.id);
      const activitySummary = summarizePaymentActivity(activity.payments, activity.refunds);
      const originalFee = Number(order.shipping_cost || 0) || 0;
      const discount = Number(order.discount_amount || 0) || 0;
      const finalFee = finalShippingFee(order);
      const feeLines = discount > 0
        ? `Original shipping fee: ${formatMoney(originalFee)}\nDiscount: ${formatMoney(discount)}\nFinal shipping fee: ${formatMoney(finalFee)}`
        : `Shipping fee: ${formatMoney(finalFee)}`;
      const method = paymentMethodLabel(order);
      const methodLine = method ? `\nHow this booking is paid: ${method}` : '';
      const refundLine = activitySummary.successfulRefundAmount > 0
        ? `Money returned: ${formatMoney(activitySummary.successfulRefundAmount)} (${activitySummary.refundCount} confirmed refund${activitySummary.refundCount === 1 ? '' : 's'})`
        : activitySummary.pendingRefundCount > 0
          ? `Refund status: ${activitySummary.pendingRefundCount} refund request${activitySummary.pendingRefundCount === 1 ? '' : 's'} still pending. It is not counted as money returned yet.`
          : activitySummary.failedRefundCount > 0
            ? 'Refund status: A refund attempt failed. Please ask an administrator to review it.'
            : 'No confirmed refund is recorded for this booking.';

      if (state === SETTLEMENT_STATE.CANCELLED) {
        return {
          text: `${header}\n\n🚫 This booking is cancelled. Its old shipping-charge difference is not an active balance to collect.\n\n${feeLines}\nAmount recorded as paid: ${formatMoney(Number(order.amount_paid || 0) || 0)}\n${refundLine}${methodLine}\n\nOpen Payment & Refund Summary or ask an administrator for the cancellation settlement decision.`,
          askResolved: true,
        };
      }

      const paid = parseFloat(order.amount_paid || 0) || 0;
      const owed = outstandingBalance(order);
      const paymentLine = state === SETTLEMENT_STATE.SETTLED
        ? '✅ Payment is complete. Thank you!'
        : paid > 0
          ? '⚠️ Partially paid — you still have a balance outstanding.'
          : '❌ Payment is still outstanding.';

      return {
        text: `${header}\n\n💵 ${feeLines}\n✅ Amount Paid: ${formatMoney(paid)}\n🔴 Balance: ${formatMoney(owed)}${methodLine}\n\n${paymentLine}\n${refundLine}`,
        askResolved: true,
      };
    },
  },

  // How to pay — the METHODS, as opposed to payment_info above, which answers
  // "what do I owe on my parcel".
  //
  // Deliberately placed AFTER payment_info: a message carrying a balance noun
  // ("magkano pa ang bayad ko", "naa pa koy utang?") is about that customer's
  // own ledger and is claimed there first. What falls through to here is the
  // general question — "pwede ba GCash?", "do you accept cash?" — which
  // payment_info has no pattern for.
  {
    id: 'mode_of_payment',
    patterns: [
      /how\s*(do\s*i|to|can\s*i)\s*pay\b/i,                                    // EN
      /\bcan\s*i\s*pay\b/i,                                                     // EN
      /modes?\s*of\s*payment|payment\s*(method|option|mode)s?/i,                // EN
      /\bdo\s*(you|u)\s*(accept|take|allow)\b/i,                                // EN
      /\bg-?cash\b/i,                                                           // EN/TL/CEB
      /\bpaymongo\b/i,                                                          // EN
      /\bcash\s*on\s*delivery\b|\bc\.?o\.?d\b/i,                                // EN
      /\bfreight\s*collect\b/i,                                                 // EN
      /\bpay\s*(via|thru|through|using|with|online|in\s*cash)\b/i,              // EN
      // TL — "paano magbayad", "pwede ba gcash", "tumatanggap ba kayo ng cash"
      /\b(paano|pano|panu|papaano)\s*(po|ba)?\s*(ako|kami)?\s*(mag)?-?\s*(bayad|babayad|magbayad|bayaran)\b/i,
      /\b(pwede|puede)\s*(po|ba)?\s*(ang|mag)?\s*-?(cash|online|bank|maya|card)\b/i,
      /\b(anong|ano\s*ang|ano'?ng)\s*(mga)?\s*(paraan|mode|option|pwede)\s*(ng|sa|para\s*sa)?\s*(bayad|pagbabayad|magbayad)\b/i,
      /\b(tumatanggap|tanggap|nagtatanggap)\s*(po|ba)?\s*(kayo)\b/i,
      /\bsaan\s*(po|ba)?\s*(ako|kami)?\s*(magbabayad|magbayad|pwedeng\s*magbayad)\b/i,
      // CEB — "unsaon pag bayad", "modawat ba mo ug cash"
      /\bunsa-?on\s*(man)?\s*(pag|nako|ko)?-?\s*(bayad|pagbayad|mobayad|mubayad)\b/i,
      /\b(modawat|nagdawat|gadawat|dawat)\s*(ba)?\s*(mo|kamo)\b/i,
      /\b(asa|hain)\s*(man)?\s*(ko|mi)\s*(mo|mu)?-?bayad\b/i,
      /\bunsa\s*(man)?\s*(ang)?\s*(paagi|modo)\s*sa\s*(pag)?bayad\b/i,
    ],
    handler: async () => ({
      // Three methods, because the schema has three: payment_method is
      // cash | gcash | paylater, and payer_type = 'receiver' is Freight
      // Collect — the settlement rules exempt it from the warehouse hold
      // precisely because it is paid at the door. Answering with only GCash
      // and cash would leave the most-asked local case ("COD ba?") unanswered.
      text: "We accept payments via GCash (securely powered by PayMongo) directly from your dashboard! 💳\n\nYou can also opt to pay in Cash during pickup/drop-off. 💰\n\nFreight Collect is available too — the receiver pays upon delivery. Pwede rin pong bayaran ng tatanggap sa oras ng delivery.\n\nTake note: your parcel is weighed at pickup and the fee is computed from that weight, so the exact amount is known then.",
      askResolved: true,
    }),
  },

  // Trip assignment
  {
    id: 'trip_info',
    patterns: [
      /which\s*trip/i,                                                         // EN
      /assigned\s*to\s*(a|which|what)?\s*trip/i,                               // EN
      /trip\s*(number|#|num|detail|info|assign)/i,                             // EN
      /what\s*trip/i,                                                          // EN
      /has\s*(my)?\s*(trip|shipment)\s*(started|depart)/i,                     // EN
      /trip\s*start/i,                                                         // EN
      // TL — "anong trip", "nakasama na ba sa barko", "umalis na ba ang barko"
      /\b(anong|ano\s*ang|aling|nasaan\s*ang)\s*(trip|barko|biyahe|bapor)\b/i,
      /\b(trip|biyahe|barko)\s*(ko|namin|natin)\b/i,
      /\b(umalis|nakaalis|lumarga|nakalarga|sumakay|nakasakay|nakasama)\s*na\s*(ba)?\b/i,
      /\bkasama\s*na\s*(ba)?\s*(sa)?\s*(trip|barko|biyahe)\b/i,
      /\bkailan\s*(ang|ung)?\s*(alis|larga|biyahe|trip)\b/i,
      /\b(nasa|asa|hain)\s*\w+\s*(ba|na)?\s*(ang|akong)?\s*(barko|bapor|biyahe|trip)\b/i,
      // CEB — "unsa akong trip", "naa na ba sa barko", "kanus-a molarga"
      /\b(unsa|asa|hain)\s*(man)?\s*(ang|akong|ako)?\s*(trip|barko|biyahe|bapor)\b/i,
      /\b(trip|biyahe|barko)\s*(nako|nakoa|namo)\b/i,
      /\b(nilarga|nakalarga|molarga|mularga|nigikan|migikan|nakagikan)\b/i,
      /\bkanus-?a\s*(man)?\s*(ang|mo|mu)?\s*(larga|gikan|biyahe|trip)\b/i,
    ],
    handler: async (userId, message, context) => {
      const order = await resolveOrder(userId, message, context);
      if (order === NOT_FOUND) return trackingNotFoundReply(message);
      if (order === NEEDS_SELECTION) return bookingSelectionReply(context);
      if (!order) {
        return { text: "You don't have any bookings currently.", askResolved: true };
      }
      if (!order.trips) {
        return {
          text: `Your shipment (${order.tracking_number}) has not been assigned to a trip yet.\n\nCurrent status: ${order.status}\n\nOur admin will assign it to an upcoming trip soon.`,
          askResolved: true,
        };
      }
      const trip = order.trips;
      const tripStatusLine = trip.status === 'in_progress'
        ? '🚢 Trip is currently underway.'
        : trip.status === 'completed'
        ? '✅ Trip has arrived at the destination.'
        : `📅 Trip is ${trip.status}.`;
      return {
        text: `🚢 Your shipment (${order.tracking_number}) is on:\n\n📋 Trip: ${trip.trip_number}\n🗺️ Route: ${trip.origin} → ${trip.destination}\n${tripStatusLine}`,
        askResolved: true,
      };
    },
  },

  // How to book / booking process
  {
    id: 'how_to_book',
    patterns: [
      /how\s*(to|do\s*i|can\s*i)\s*(book|place|create|make)\s*(a|an)?\s*(shipment|order|booking|cargo)/i, // EN
      /how\s*does?\s*(booking|shipment)\s*work/i,                              // EN
      /process\s*(of|for)\s*(booking|shipping)/i,                              // EN
      // TL — "paano mag book", "paano magpadala", "ano ang proseso ng booking"
      /\b(paano|pano|panu|papaano)\s*(po|ba)?\s*(ang)?\s*(mag)?-?\s*(book|booking|order|padala|magpadala|ipadala|magpaship)\b/i,
      /\b(paano|pano|panu)\s*(po|ba)?\s*(ang)?\s*(proseso|hakbang|steps)\b/i,
      /\b(ano|anong)\s*(ang)?\s*(proseso|hakbang|requirements|kailangan)\s*(ng|sa|para)?\s*(book|booking|padala)\b/i,
      /\b(gusto|balak|nais)\s*(ko|kong)\s*(mag)?-?\s*(padala|book|magpadala|ipadala)\b/i,
      // CEB — "unsaon pag book", "unsaon pagpadala", "unsa ang proseso"
      /\bunsa-?on\s*(man)?\s*(pag|nako|ko)?-?\s*(book|booking|padala|pagpadala|order)\b/i,
      /\bunsa\s*(man)?\s*(ang|akong)?\s*(proseso|buhaton|kinahanglan)\b/i,
      /\b(gusto|buot|tinguha)\s*(ko|nako|kong)\s*(mag|mo|mu)?-?\s*(padala|book|ipadala)\b/i,
      /\bpwede\s*(ko|ba)?\s*(mag|mo|mu)?-?\s*(padala|book)\b/i,
    ],
    handler: async () => ({
      // No "enter package weight" step: weight enters the system once, from the
      // scale at pickup, so the booking form does not ask for it.
      text: `📦 To book a shipment with CargoExpress PH:\n\n1️⃣ Go to the Book Shipment page from your dashboard\n2️⃣ Fill in sender & receiver details\n3️⃣ Describe your package contents\n4️⃣ Choose a route (Bohol → Manila or Manila → Bohol)\n5️⃣ Select a trip (optional) or let admin assign one\n6️⃣ Submit your booking\n\nYour parcel is weighed at pickup, and the shipping fee is computed from that weight. Payment is collected upon pickup.`,
      askResolved: true,
    }),
  },

  // Delivery timeline / how long / ETA
  {
    id: 'delivery_timeline',
    patterns: [
      /how\s*long\s*(does?|will)\s*(it\s*take|the\s*(delivery|shipping))/i,    // EN
      /when\s*will\s*(it|my\s*(package|shipment))\s*(arrive|be\s*delivered)/i,  // EN
      /eta/i,                                                                   // EN
      /delivery\s*time/i,                                                       // EN
      /how\s*many\s*days/i,                                                     // EN
      // TL — "gaano katagal", "ilang araw", "hanggang kailan"
      /\b(gaano|gano|ga'?no)\s*(po|ba)?\s*(ka)?(tagal|bilis)\b/i,
      /\bilang\s*(po|ba)?\s*(araw|oras|linggo|buwan)\b/i,
      /\bhanggang\s*(kailan|kelan)\b/i,
      /\b(kailan|kelan)\s*(po|ba)?\s*(ito|to|yan|iyan)?\s*(makakarating|darating|maihahatid)\b/i,
      // CEB — "pila ka adlaw", "unsa ka dugay", "hangtod kanus-a"
      /\bpila\s*(ka|ba)?\s*(ka)?\s*(adlaw|oras|semana|bulan)\b/i,
      /\bunsa\s*(ka)?\s*(dugay|paspas)\b/i,
      /\bhangtod\s*kanus-?a\b/i,
      /\bkadugayon\b/i,
    ],
    handler: async (userId, message, context) => {
      const hasSpecificBooking = Boolean(extractTrackingNumber(message) || context?.selectedBookingId || /\b(my|akong|aking|nako|ko)\b/i.test(message));
      if (!hasSpecificBooking) {
        return {
          text: 'I cannot promise a fixed delivery time from a general question. Delivery depends on the assigned trip, handoff status, and conditions at sea. Send a tracking number or ask about a specific booking for the latest recorded details.',
          askResolved: true,
        };
      }
      const order = await resolveOrder(userId, message, context);
      if (order === NOT_FOUND) return trackingNotFoundReply(message);
      if (order === NEEDS_SELECTION) return bookingSelectionReply(context);
      if (!order) return { text: "You don't have any bookings currently.", askResolved: true };
      const tripLine = order.trips
        ? `Assigned trip: ${order.trips.trip_number} (${order.trips.origin} → ${order.trips.destination})`
        : 'No trip is assigned yet.';
      return {
        text: `Latest recorded delivery details for ${order.tracking_number}:\n\nStatus: ${order.status}\n${tripLine}\n\nI cannot guarantee an arrival date from this status alone.`,
        askResolved: true,
      };
    },
  },

  // Price / rate
  {
    id: 'pricing',
    patterns: [
      /(how\s*much|what'?s?\s*the\s*(price|rate|cost))\s*(per\s*kilo|per\s*kg)?/i, // EN
      /rate\s*(per\s*kilo|per\s*kg)/i,                                         // EN
      /price\s*(list|per\s*kilo|per\s*kg)/i,                                   // EN
      /how\s*much\s*(would|does?)\s*(it|shipping)\s*cost/i,                    // EN
      // TL — "magkano kada kilo", "magkano ang padala", bare "magkano"
      /\b(magkano|mgkno|mganu|manu)\b/i,
      /\b(presyo|halaga|bayad)\s*(po|ba)?\s*(kada|per|sa\s*isang)?\s*(kilo|kg)\b/i,
      /\b(kada|per|isang)\s*(kilo|kg|kilong)\b/i,
      /\b(presyo|halaga|singil|listahan\s*ng\s*presyo)\b/i,
      // CEB — "tagpila", "pila kada kilo", "pila ang presyo"
      /\b(tagpila|tag\s*pila|pilay|pila)\s*(man|ba)?\s*(ang|ka)?\s*(kilo|presyo|bayad|padala)\b/i,
      /\b(kada|per)\s*(usa\s*ka)?\s*kilo\b/i,
      /\bpresyo\s*(sa|ug|og)\s*(kilo|padala)\b/i,
    ],
    handler: async () => {
      // Read live, never hardcoded: this is the same figure the pricing trigger
      // uses (company_information.default_price_per_kg, fallback 70 to match
      // global_price_per_kilo()). A number typed into this string would drift
      // the moment an admin changes the rate.
      const { data, error } = await supabase.from('company_information').select('default_price_per_kg').single();
      if (error || data?.default_price_per_kg == null || Number.isNaN(Number(data.default_price_per_kg)) || Number(data.default_price_per_kg) <= 0) {
        return {
          text: 'I cannot confirm the current rate right now because the live pricing setting is unavailable. Please try again or ask an administrator. I will not guess a price.',
          askResolved: false,
        };
      }
      const pricePerKg = Number(data.default_price_per_kg);

      // No peso figure or percentage for the bulky charge. The admin sets it per
      // parcel when they see the actual size, and quoting a number the system
      // cannot compute would be a promise the bot has no way to keep.
      return {
        text: [
          `💰 Standard rate: ${formatMoney(pricePerKg)} per kilogram.`,
          '',
          'For normal items — boxes, luggage, balikbayan boxes — kilo lang ang basehan:',
          `• 5 kg = ${formatMoney(5 * pricePerKg)}`,
          `• 10 kg = ${formatMoney(10 * pricePerKg)}`,
          `• 20 kg = ${formatMoney(20 * pricePerKg)}`,
          '',
          'This is our standard rate. Some trips have their own rate depending on the route, so your final fee follows the trip your parcel is booked on.',
          '',
          '📦 Bulky items (space charge)',
          '',
          'For items that are large but light — appliances, cabinets, plastic drawers, malalaking plastic boxes — our admin adds a small extra charge on top of the per-kilo rate.',
          '',
          'Ganito po kasi: masikip sa van. Kahit magaan, malaki ang kinakain nila sa espasyo, kaya konti na lang ang kasyang iba pang padala. Kaya may dagdag na bayad para sa espasyong nauubos.',
          '',
          'The exact amount depends on the actual size, so our admin computes it when they weigh and measure your parcel at pickup — and they will tell you the total before you pay.',
          '',
          'Payment is made upon pickup.',
        ].join('\n'),
        askResolved: true,
      };
    },
  },

  // Contact / phone / Facebook
  {
    id: 'contact_info',
    patterns: [
      /contact\s*(number|info|information|us|admin|support)/i,                 // EN
      /phone\s*number/i,                                                       // EN
      /facebook|fb\s*(page)?/i,                                                // EN
      /how\s*(can\s*i|to)\s*contact/i,                                         // EN
      /email\s*(address|contact)?/i,                                           // EN
      // TL — "ano ang contact number", "paano makipag-ugnayan", "cellphone number"
      /\b(numero|number)\s*(ng|nang|sa)\s*(cellphone|telepono|opisina|kompanya|office)\b/i,
      /\b(cellphone|celfon|selpon|telepono|landline)\s*(number|numero)?\b/i,
      /\b(paano|pano|panu)\s*(po|ba)?\s*(kayo|namin|ko)?\s*(ma)?(kontak|contact|makipag-?ugnayan|matawagan|tawagan)\b/i,
      /\b(anong|ano\s*ang)\s*(inyong)?\s*(contact|numero|email|fb|facebook|page)\b/i,
      /\b(asan|nasaan|saan)\s*(ang)?\s*(office|opisina|tindahan|branch)\b/i,
      // CEB — "unsa imong number", "asa mo makontak", "asa ang opisina"
      /\b(unsa|asa|hain)\s*(man)?\s*(ang|imong|inyong)?\s*(number|numero|contact|email|fb|facebook|page)\b/i,
      /\bunsa-?on\s*(nako|ko|pag)?\s*(pag)?-?(kontak|contact|tawag)\b/i,
      /\b(asa|hain)\s*(man)?\s*(ang|inyong)?\s*(opisina|office|tindahan|branch)\b/i,
    ],
    handler: async () => {
      const { data: info, error } = await supabase.from('company_information').select('smart_phone, globe_phone, facebook, email').single();
      if (error) throw error;
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
      /^(thank(s|\s*you)|ty|ok\s*thanks?|great\s*thanks?|okay\s*thanks?)/i,    // EN
      /^(bye|goodbye|take\s*care)/i,                                           // EN
      /\b(maraming|marami\s*pong?|daghang|dghang)?\s*salamat\b/i,              // TL/CEB
      /^(sige|sge|okay?|ok)\s*(po|lang|na)?\s*(salamat|thanks?|ty)\b/i,        // TL
      /^(salamat|thank\s*you)\s*(po|kaayo|kaau|ug|daghan)?\b/i,                // TL/CEB
      /^(amping|babay|paalam|hangtod\s*sa\s*sunod|bye\s*na)\b/i,               // CEB/TL
      /^(ayos|ayus|nice|okay?)\s*(na|lang|ra)\s*(po|man)?\b/i,                 // TL/CEB
    ],
    handler: async () => ({
      text: "You're welcome! 😊 Walang anuman! Wala'y sapayan!\n\nHave a great day — message us anytime, in English, Tagalog, or Bisaya.",
      askResolved: false,
    }),
  },
];

// ── Status descriptions ────────────────────────────────────────────────────────
const STATUS_DESCRIPTIONS = {
  'Pending': 'Your booking has been received and is awaiting review by our administrator.',
  'Pending Review': 'Your booking or route request is waiting for an administrator to review it.',
  'Pending Cancellation': 'Your cancellation request is waiting for an administrator to review it. It is not cancelled yet.',
  'Assigned': 'Your shipment has been assigned to a scheduled trip and is waiting for pickup.',
  'Picked Up': 'Your shipment has been collected and is being prepared for transport.',
  'In Transit': 'Your shipment is currently traveling toward the destination.',
  'Arrived at Hub': 'Your shipment has arrived at the destination hub and is being organized for delivery.',
  'Out for Delivery': 'Our delivery personnel is currently delivering your shipment.',
  'Delivered': 'Your shipment has been successfully delivered.',
  'Cancelled': 'This shipment has been cancelled.',
};

// ── Data fetchers ──────────────────────────────────────────────────────────────

// `actual_weight` is not decoration: every settlement answer has to ask whether
// the parcel has been weighed before it can read a ₱0 as anything.
const ORDER_FIELDS = `
  id, tracking_number, status, origin, destination,
  shipping_cost, discount_amount, amount_paid, remaining_balance, payment_status,
  payment_method, payer_type,
  actual_weight, sender_name, receiver_name,
  created_at,
  trips:trip_id (trip_number, origin, destination, status)
`;

const fetchCustomerOrders = async (userId, { includeCancelled = true, limit = 50 } = {}) => {
  if (!userId) return [];
  let query = supabase
    .from('orders')
    .select(ORDER_FIELDS)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (!includeCancelled) query = query.neq('status', 'Cancelled');
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
};

const fetchCustomerOrderCount = async (userId) => {
  const { count, error } = await supabase
    .from('orders')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId);
  if (error) throw error;
  return count || 0;
};

const BOOKING_PICKER_PAGE_SIZE = 5;

const fetchBookingPickerPage = async (userId, offset = 0) => {
  if (!userId) return { orders: [], total: 0 };
  let query = supabase
    .from('orders')
    .select(ORDER_FIELDS, { count: 'exact' })
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  // Keep the page bounded. The fallback is useful for the small provider-free
  // contract mock and does not change the production query path.
  query = typeof query.range === 'function'
    ? query.range(offset, offset + BOOKING_PICKER_PAGE_SIZE - 1)
    : query.limit(BOOKING_PICKER_PAGE_SIZE);
  const { data, count, error } = await query;
  if (error) throw error;
  return { orders: data || [], total: count || 0 };
};

/**
 * One specific order by tracking number.
 *
 * Scoped to `user_id` as well as the tracking number. RLS already restricts
 * this to the caller's own orders, but the explicit filter keeps the intent
 * visible here: a customer naming someone else's tracking number gets "not
 * found", not a cross-account read. `maybeSingle` because a miss is an ordinary
 * outcome — a typo — not an error.
 */
const fetchOrderByTrackingNumber = async (userId, trackingNumber) => {
  const { data, error } = await supabase
    .from('orders')
    .select(ORDER_FIELDS)
    .eq('user_id', userId)
    .eq('tracking_number', trackingNumber)
    .maybeSingle();
  if (error) throw error;
  return data || null;
};

const fetchOrderById = async (userId, orderId) => {
  if (!userId || !orderId) return null;
  const { data, error } = await supabase
    .from('orders')
    .select(ORDER_FIELDS)
    .eq('user_id', userId)
    .eq('id', orderId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
};

/**
 * Distinguishes "you named a parcel I can't find" from "you have no parcels".
 * Collapsing the two would answer a mistyped tracking number with the status of
 * an unrelated order.
 */
const NOT_FOUND = Symbol('tracking-not-found');
const NEEDS_SELECTION = Symbol('booking-selection-required');

const rememberOrder = (context, order) => {
  if (!context || !order) return;
  context.selectedBookingId = order.id || null;
  context.selectedTrackingNumber = order.tracking_number || null;
  context.selectedChoices = { ...(context.selectedChoices || {}), bookingId: order.id || null };
};

const bookingSelectionReply = context => ({
  text: `Which booking do you mean? Reply with its number, “first”, “second”, or the tracking number.\n\n${(context?.pendingClarification?.options || []).map((order, index) => `${index + 1}. ${order.tracking_number} — ${order.status} (${order.origin} → ${order.destination})`).join('\n')}`,
  askResolved: false,
  quickReplies: (context?.pendingClarification?.options || []).map(order => order.tracking_number),
});

const bookingPickerReply = (context, orders, total, offset = 0) => {
  const options = (orders || []).map(order =>
    menuAction(`${SUPPORT_ACTIONS.SELECT_BOOKING}:${order.id}`, `${order.tracking_number} · ${order.status}`, {
      description: `${order.origin} → ${order.destination}`,
    })
  );
  const actions = [...options];
  if (offset + options.length < total) {
    actions.push(menuAction(SUPPORT_ACTIONS.SHOW_MORE_BOOKINGS, 'Show more bookings'));
  }
  actions.push(
    menuAction(SUPPORT_ACTIONS.BACK, 'Back'),
    menuAction(SUPPORT_ACTIONS.MAIN_MENU, 'Main menu'),
    menuAction(SUPPORT_ACTIONS.TALK_TO_ADMIN, 'Talk to an admin'),
  );

  return {
    text: total
      ? `Choose a booking to continue. I found ${total} booking${total === 1 ? '' : 's'} under your account.${offset ? ` Showing bookings ${offset + 1}–${offset + options.length}.` : ''}`
      : "You don't have any bookings yet. You can book a shipment from the Book Shipment page.",
    askResolved: false,
    actions: total ? actions : [
      menuAction(SUPPORT_ACTIONS.BOOK_NEW, 'Book a shipment'),
      menuAction(SUPPORT_ACTIONS.MAIN_MENU, 'Main menu'),
      menuAction(SUPPORT_ACTIONS.TALK_TO_ADMIN, 'Talk to an admin'),
    ],
    quickReplies: options.map(option => option.label),
    picker: total ? { offset, total } : null,
  };
};

const setBookingSelection = (context, orders) => {
  if (!context || !Array.isArray(orders) || orders.length < 2) return;
  context.pendingClarification = {
    type: 'booking_selection',
    topic: context.currentTopic || 'booking',
    options: orders.slice(0, 5).map(order => ({
      id: order.id,
      tracking_number: order.tracking_number,
      status: order.status,
      origin: order.origin,
      destination: order.destination,
    })),
  };
};

/**
 * resolveOrder — the order this message is about.
 *
 * A named tracking number wins over recency; without one, the newest order is
 * the subject, which is what every handler assumed before. Returns NOT_FOUND
 * when a tracking number was named but matched nothing the customer owns, and
 * null when they have no orders at all.
 */
const resolveOrder = async (userId, message, context = null) => {
  const tracking = extractTrackingNumber(message);
  if (tracking) {
    const order = await fetchOrderByTrackingNumber(userId, tracking);
    if (order) rememberOrder(context, order);
    return order || NOT_FOUND;
  }
  if (context?.selectedBookingId) {
    const selected = await fetchOrderById(userId, context.selectedBookingId);
    if (selected) {
      rememberOrder(context, selected);
      return selected;
    }
    context.selectedBookingId = null;
    context.selectedTrackingNumber = null;
  }
  const orders = await fetchCustomerOrders(userId, { includeCancelled: true });
  if (orders.length > 1) {
    setBookingSelection(context, orders);
    return NEEDS_SELECTION;
  }
  if (orders[0]) rememberOrder(context, orders[0]);
  return orders[0] || null;
};

const trackingNotFoundReply = (message) => ({
  text: `I couldn't find ${extractTrackingNumber(message)} under your account.\n\nPlease double-check the tracking number or sign in to the account that owns the booking. I cannot show another customer's booking or payment details.`,
  askResolved: false,
});

/** Full status card for one order. Plain text — the chat renders raw strings. */
const describeOrder = (order) => {
  const lines = [
    `📦 Tracking #: ${order.tracking_number}`,
    `📍 Status: ${order.status}`,
    `🚢 Route: ${order.origin} → ${order.destination}`,
  ];
  if (order.trips) lines.push(`🚚 Trip: ${order.trips.trip_number}`);
  lines.push(`💰 ${describeSettlement(order)}`);
  const desc = STATUS_DESCRIPTIONS[order.status];
  return `Here's the latest on ${order.tracking_number}:\n\n${lines.join('\n')}${desc ? `\n\n${desc}` : ''}`;
};

/**
 * The money line, in the three states the schema actually has.
 *
 * An unweighed parcel has NO price — `shipping_cost` and `remaining_balance`
 * are both 0, and reading that as "₱0.00 balance, fully paid" is the exact
 * conflation `getSettlementState` exists to prevent. Outstanding is always the
 * derived figure, never the stored `remaining_balance`, which can lag a ledger
 * write.
 */
const describeSettlement = (order) => {
  const state = getSettlementState(order);
  if (state === SETTLEMENT_STATE.CANCELLED) {
    return 'Booking cancelled — no active shipment balance. See Payment & Refund Summary for its refund settlement.';
  }
  if (state === SETTLEMENT_STATE.UNPRICED) {
    return 'Not priced yet — your parcel is weighed at pickup, and the shipping fee is computed from that weight.';
  }
  const originalFee = parseFloat(order.shipping_cost || 0) || 0;
  const discount = parseFloat(order.discount_amount || 0) || 0;
  const finalFee = finalShippingFee(order);
  const paid = parseFloat(order.amount_paid || 0) || 0;
  const owed = outstandingBalance(order);
  const feeLine = discount > 0
    ? `Original shipping fee ${formatMoney(originalFee)} · Discount ${formatMoney(discount)} · Final fee ${formatMoney(finalFee)}`
    : `Shipping fee ${formatMoney(finalFee)}`;
  if (state === SETTLEMENT_STATE.SETTLED) {
    return `${feeLine} — fully paid. Thank you!`;
  }
  return `${feeLine} · Paid ${formatMoney(paid)} · Balance ${formatMoney(owed)}`;
};

const fetchPaymentActivity = async orderId => {
  const [paymentsResponse, refundsResponse] = await Promise.all([
    supabase.rpc('get_payment_transaction_history', { p_order_ids: [orderId] }),
    supabase.rpc('get_payment_refund_history', { p_order_ids: [orderId] }),
  ]);
  if (paymentsResponse.error) throw paymentsResponse.error;
  if (refundsResponse.error) throw refundsResponse.error;
  return {
    payments: paymentsResponse.data || [],
    refunds: refundsResponse.data || [],
  };
};

const summarizePaymentActivity = (payments = [], refunds = []) => {
  const successfulRefunds = refunds.filter(refund => refund.status === 'succeeded');
  const pendingRefunds = refunds.filter(refund => ['creating', 'pending', 'processing'].includes(refund.status) || refund.outcome_uncertain);
  const failedRefunds = refunds.filter(refund => refund.status === 'failed' && !refund.outcome_uncertain);
  return {
    paymentCount: payments.filter(payment => ['paid', 'partial'].includes(payment.payment_status)).length,
    refundCount: successfulRefunds.length,
    successfulRefundAmount: successfulRefunds.reduce((sum, refund) => sum + Number(refund.amount || 0), 0),
    pendingRefundCount: pendingRefunds.length,
    pendingRefundAmount: pendingRefunds.reduce((sum, refund) => sum + Number(refund.amount || 0), 0),
    failedRefundCount: failedRefunds.length,
  };
};

const paymentMethodLabel = order => {
  if (order.payer_type === 'receiver') return 'Freight Collect — the receiver pays on delivery';
  if (order.payment_method === 'paylater') return 'Pay Later — no payment is counted until a payment is recorded';
  if (order.payment_method === 'gcash') return 'GCash';
  if (order.payment_method === 'cash') return 'Cash';
  return null;
};

// ── Main export ────────────────────────────────────────────────────────────────

const TOPIC_CHOICE_INTENTS = {
  booking: ['how_to_book', 'booking_status', 'booking_changes'],
  payment: ['mode_of_payment', 'payment_info', 'payment_info'],
  delivery: ['shipment_location', 'shipment_location', 'trip_info'],
  pickup: ['pickup_status', 'packaging_guidelines', 'office_location'],
  refund: ['refund_policy', null, 'booking_changes'],
};

const resolvedConfirmationReply = (context, answer) => {
  context.pendingClarification = null;
  context.consecutiveUnrecognizedReplies = 0;
  if (answer === 'yes') {
    return {
      text: "You're welcome! If you have another question, type it anytime.",
      escalate: false,
      askResolved: false,
    };
  }
  return {
    text: null,
    escalate: true,
    askResolved: false,
  };
};

const handlePendingChoice = async (message, userId, context) => {
  const pending = context.pendingClarification;
  if (!pending) return null;

  if (pending.type === 'resolved_confirmation') {
    if (isBareYes(message)) return resolvedConfirmationReply(context, 'yes');
    if (isBareNo(message)) return resolvedConfirmationReply(context, 'no');
    if (/^(back|balik|uli)$/i.test(message)) {
      context.pendingClarification = null;
      return { text: TOPIC_MENU_TEXT, escalate: false, askResolved: false };
    }
    // A new substantive question overrides the old Yes/No prompt.
    context.pendingClarification = null;
    return null;
  }

  if (pending.type === 'booking_selection') {
    const choice = parseChoice(message, pending.options || []);
    if (choice?.type === 'back') {
      context.pendingClarification = null;
      context.selectedBookingId = null;
      context.selectedTrackingNumber = null;
      return { text: TOPIC_MENU_TEXT, escalate: false, askResolved: false };
    }
    if (choice?.type !== 'option') return null;
    const selected = pending.options[choice.index];
    const order = await fetchOrderById(userId, selected?.id);
    if (!order) {
      context.pendingClarification = null;
      context.selectedBookingId = null;
      context.selectedTrackingNumber = null;
      return { text: 'I could not confirm that booking under your account. Please send its tracking number or choose another booking.', escalate: false, askResolved: false };
    }
    rememberOrder(context, order);
    context.pendingClarification = null;
    context.consecutiveUnrecognizedReplies = 0;
    return {
      text: `Got it — I selected ${order.tracking_number}. What would you like to know about this booking?`,
      escalate: false,
      askResolved: false,
    };
  }

  if (pending.type === 'topic_selection' || pending.type === 'topic_followup') {
    const options = pending.type === 'topic_selection'
      ? TOPIC_OPTIONS
      : (TOPIC_FOLLOWUPS[pending.topic]?.options || []);
    const choice = parseChoice(message, options);
    if (choice?.type === 'back') {
      context.pendingClarification = { type: 'topic_selection', options: TOPIC_OPTIONS };
      context.currentTopic = null;
      return { text: TOPIC_MENU_TEXT, escalate: false, askResolved: false };
    }
    if (choice?.type !== 'option') return null;
    if (pending.type === 'topic_selection') {
      const topic = TOPIC_OPTIONS[choice.index]?.id;
      context.currentTopic = topic;
      context.selectedBookingId = null;
      context.selectedTrackingNumber = null;
      context.pendingClarification = { type: 'topic_followup', topic };
      return { text: TOPIC_FOLLOWUPS[topic].text, escalate: false, askResolved: false, quickReplies: TOPIC_FOLLOWUPS[topic].options };
    }
    const intentId = TOPIC_CHOICE_INTENTS[pending.topic]?.[choice.index];
    context.pendingClarification = null;
    if (intentId === null) {
      return { text: null, escalate: true, askResolved: false };
    }
    const intent = INTENTS.find(candidate => candidate.id === intentId);
    if (!intent) return null;
    try {
      const result = await intent.handler(userId, message, context);
      return { escalate: false, ...result };
    } catch (error) {
      throw error;
    }
  }

  return null;
};

const actionErrorReply = (retryActionId, actions) => ({
  text: "We couldn’t load this information. Please try again.",
  escalate: false,
  askResolved: false,
  unavailable: true,
  actions: [
    menuAction(SUPPORT_ACTIONS.RETRY, 'Retry', { actionId: retryActionId }),
    ...(actions || menuActions.main()),
  ],
});

const runIntentHandler = async (intentId, userId, context, message = '') => {
  const intent = INTENTS.find(candidate => candidate.id === intentId);
  if (!intent) throw new Error(`Unknown support intent: ${intentId}`);
  return intent.handler(userId, message, context);
};

const selectedBookingOrPicker = async (userId, context, parentActions = menuActions.main()) => {
  if (context?.selectedBookingId) {
    const order = await fetchOrderById(userId, context.selectedBookingId);
    if (order) {
      rememberOrder(context, order);
      return { order, picker: null };
    }
    context.selectedBookingId = null;
    context.selectedTrackingNumber = null;
  }
  const page = await fetchBookingPickerPage(userId, 0);
  if (!page.total) return { order: null, picker: bookingPickerReply(context, [], 0, 0) };
  context.pendingClarification = {
    type: 'booking_picker',
    offset: 0,
    total: page.total,
    parentActions,
  };
  return { order: null, picker: bookingPickerReply(context, page.orders, page.total, 0) };
};

const bookingDetailsReply = async (actionId, userId, context) => {
  const selected = await selectedBookingOrPicker(userId, context, menuActions.booking());
  if (selected.picker) return selected.picker;

  const order = selected.order;
  if (actionId === SUPPORT_ACTIONS.OPEN_BOOKING) {
    return {
      text: `Opening ${order.tracking_number}.`,
      actions: menuActions.booking(),
      navigateTo: `/customer/orders/${order.id}`,
      askResolved: false,
    };
  }

  if (actionId === SUPPORT_ACTIONS.BOOKING_STATUS) {
    return {
      text: describeOrder(order),
      escalate: false,
      askResolved: false,
      actions: menuActions.booking(),
    };
  }

  const intentId = {
    [SUPPORT_ACTIONS.PAYMENT_DETAILS]: 'payment_info',
    [SUPPORT_ACTIONS.TRIP_DETAILS]: 'trip_info',
  }[actionId];
  const result = await runIntentHandler(intentId, userId, context, 'selected booking');
  return { escalate: false, ...result, actions: menuActions.booking() };
};

const paymentBookingReply = async (userId, context) => {
  const page = await fetchBookingPickerPage(userId, 0);
  if (!page.total) return bookingPickerReply(context, [], 0, 0);
  context.currentTopic = 'payment';
  context.pendingClarification = {
    type: 'booking_picker',
    offset: 0,
    total: page.total,
    parentActions: menuActions.payment(),
  };
  return bookingPickerReply(context, page.orders, page.total, 0);
};

const shippingProcessReply = () => ({
  text: `Here is the usual process:

1. Book the shipment and enter the sender, receiver, route, and cargo details.
2. Pack the cargo securely and bring it for pickup or drop-off.
3. The parcel is weighed at pickup and the final shipping fee is computed from that weight.
4. The shipment is assigned to a trip, transported, and updated as it moves.

The booking page and your selected booking show the recorded status. I cannot promise an exact delivery time from a general question.`,
  askResolved: true,
  actions: menuActions.shipping(),
});

const executeSupportAction = async (actionId, userId, context) => {
  if (actionId === SUPPORT_ACTIONS.BACK) {
    const target = context.backActionId || SUPPORT_ACTIONS.MAIN_MENU;
    context.backActionId = null;
    return executeSupportAction(target, userId, context);
  }

  if (actionId === SUPPORT_ACTIONS.MAIN_MENU) {
    context.currentTopic = null;
    context.pendingClarification = { type: 'main_menu' };
    context.backActionId = null;
    context.selectedBookingId = null;
    context.selectedTrackingNumber = null;
    return {
      text: 'Choose a topic below, or talk to an admin.',
      escalate: false,
      askResolved: false,
      actions: menuActions.main(),
    };
  }

  if (actionId === SUPPORT_ACTIONS.TALK_TO_ADMIN) {
    context.pendingClarification = null;
    return { text: null, escalate: true, askResolved: false };
  }

  if (actionId === SUPPORT_ACTIONS.MY_BOOKINGS || actionId === SUPPORT_ACTIONS.SHOW_MORE_BOOKINGS) {
    const pending = context.pendingClarification?.type === 'booking_picker'
      ? context.pendingClarification
      : { offset: 0 };
    const offset = actionId === SUPPORT_ACTIONS.SHOW_MORE_BOOKINGS
      ? Number(pending.offset || 0) + BOOKING_PICKER_PAGE_SIZE
      : 0;
    const page = await fetchBookingPickerPage(userId, offset);
    context.currentTopic = 'booking';
    context.backActionId = SUPPORT_ACTIONS.MAIN_MENU;
    context.pendingClarification = {
      type: 'booking_picker',
      offset,
      total: page.total,
      parentActions: menuActions.booking(),
    };
    return bookingPickerReply(context, page.orders, page.total, offset);
  }

  if (actionId.startsWith(`${SUPPORT_ACTIONS.SELECT_BOOKING}:`)) {
    const orderId = actionId.slice(`${SUPPORT_ACTIONS.SELECT_BOOKING}:`.length);
    const order = await fetchOrderById(userId, orderId);
    if (!order) {
      context.selectedBookingId = null;
      context.selectedTrackingNumber = null;
      return {
        text: 'I could not confirm that booking under your account. Please choose a booking again.',
        escalate: false,
        askResolved: false,
        actions: [
          menuAction(SUPPORT_ACTIONS.MY_BOOKINGS, 'Choose a booking'),
          menuAction(SUPPORT_ACTIONS.MAIN_MENU, 'Main menu'),
          menuAction(SUPPORT_ACTIONS.TALK_TO_ADMIN, 'Talk to an admin'),
        ],
      };
    }
    rememberOrder(context, order);
    context.currentTopic = 'booking';
    context.pendingClarification = { type: 'booking_actions' };
    return {
      text: `You selected ${order.tracking_number} (${order.origin} → ${order.destination}). What would you like to see?`,
      escalate: false,
      askResolved: false,
      actions: menuActions.booking(),
    };
  }

  if (actionId === SUPPORT_ACTIONS.CHOOSE_ANOTHER_BOOKING) {
    context.selectedBookingId = null;
    context.selectedTrackingNumber = null;
    context.currentTopic = 'booking';
    return executeSupportAction(SUPPORT_ACTIONS.MY_BOOKINGS, userId, context);
  }

  if (actionId === SUPPORT_ACTIONS.PAYMENT_REFUND) {
    context.currentTopic = 'payment';
    context.backActionId = SUPPORT_ACTIONS.MAIN_MENU;
    context.pendingClarification = { type: 'payment_menu' };
    return {
      text: 'What would you like to know about payments or refunds?',
      escalate: false,
      askResolved: false,
      actions: menuActions.payment(),
    };
  }

  if (actionId === SUPPORT_ACTIONS.SHIPPING_INFO) {
    context.currentTopic = 'shipping';
    context.backActionId = SUPPORT_ACTIONS.MAIN_MENU;
    context.pendingClarification = { type: 'shipping_menu' };
    return {
      text: 'What shipping information do you need?',
      escalate: false,
      askResolved: false,
      actions: menuActions.shipping(),
    };
  }

  if (actionId === SUPPORT_ACTIONS.HOW_TO_BOOK) {
    context.currentTopic = 'booking';
    const result = await runIntentHandler('how_to_book', userId, context);
    return {
      escalate: false,
      ...result,
      actions: [
        menuAction(SUPPORT_ACTIONS.BOOK_NEW, 'Open Book Shipment'),
        menuAction(SUPPORT_ACTIONS.MAIN_MENU, 'Main menu'),
        menuAction(SUPPORT_ACTIONS.TALK_TO_ADMIN, 'Talk to an admin'),
      ],
    };
  }

  if (actionId === SUPPORT_ACTIONS.BOOK_NEW) {
    return { text: null, escalate: false, askResolved: false, navigateTo: '/customer/book' };
  }

  if (actionId === SUPPORT_ACTIONS.PAYMENT_BOOKING) {
    context.backActionId = SUPPORT_ACTIONS.PAYMENT_REFUND;
    return paymentBookingReply(userId, context);
  }

  const intentActionMap = {
    [SUPPORT_ACTIONS.PAYMENT_METHODS]: ['mode_of_payment', menuActions.payment()],
    [SUPPORT_ACTIONS.REFUND_GUIDANCE]: ['refund_policy', menuActions.payment()],
    [SUPPORT_ACTIONS.SHIPPING_RATES]: ['pricing', menuActions.shipping()],
    [SUPPORT_ACTIONS.SERVICE_AREAS]: ['service_areas', menuActions.shipping()],
    [SUPPORT_ACTIONS.PACKAGING]: ['packaging_guidelines', menuActions.shipping()],
    [SUPPORT_ACTIONS.RESTRICTED_ITEMS]: ['prohibited_items', menuActions.shipping()],
    [SUPPORT_ACTIONS.CONTACT]: ['contact_info', menuActions.shipping()],
  };
  if (intentActionMap[actionId]) {
    const [intentId, actions] = intentActionMap[actionId];
    context.currentTopic = ['shipping_rates', 'service_areas', 'packaging', 'restricted_items', 'contact'].includes(actionId)
      ? 'shipping'
      : 'payment';
    const result = await runIntentHandler(intentId, userId, context);
    return { escalate: false, ...result, actions };
  }

  if (actionId === SUPPORT_ACTIONS.PICKUP_DELIVERY) return shippingProcessReply();

  if ([SUPPORT_ACTIONS.BOOKING_STATUS, SUPPORT_ACTIONS.PAYMENT_DETAILS, SUPPORT_ACTIONS.TRIP_DETAILS, SUPPORT_ACTIONS.OPEN_BOOKING].includes(actionId)) {
    context.currentTopic = 'booking';
    return bookingDetailsReply(actionId, userId, context);
  }

  return {
    text: 'Choose a topic below, or talk to an admin.',
    escalate: false,
    askResolved: false,
    actions: menuActions.main(),
  };
};

/** Process a stable menu action ID; visible labels never enter the matcher. */
const getBotReplyForAction = async (actionId, userId, suppliedContext = null) => {
  const context = suppliedContext && typeof suppliedContext === 'object'
    ? suppliedContext
    : createConversationContext(userId);
  if (context.userId !== userId || context.version !== CONTEXT_VERSION) {
    resetConversationContext(context, userId, context.conversationId || null);
  }
  const requestedAction = String(actionId || '').trim();
  const retryActionId = requestedAction === SUPPORT_ACTIONS.RETRY ? context.lastActionId : requestedAction;
  if (!retryActionId) return { text: 'Choose a topic below, or talk to an admin.', escalate: false, askResolved: false, actions: menuActions.main() };
  context.lastActionId = retryActionId;
  try {
    const reply = await executeSupportAction(retryActionId, userId, context);
    return reply.actions ? reply : { ...reply, actions: menuActions.main() };
  } catch (error) {
    console.warn('[Bot] Menu action failed:', error?.message || error);
    return actionErrorReply(retryActionId, menuActions.main());
  }
};

const isTopicMenuRequest = message =>
  /^(help|tabang|options?|menu|what\s*(can|do)\s*you\s*(help|do)|what\s*can\s*i\s*ask|ano\s*ang\s*pwede|unsa\s*imong\s*matabang)\s*[?!.,]*$/i.test(message);

/**
 * getBotReply
 *
 * @param {string}  text       Raw message from the customer
 * @param {string}  userId     Authenticated customer's UUID. RLS remains the
 *                             authority; this value is never trusted for data
 *                             access without an explicit user_id filter.
 * @param {Object}  context    Optional page-owned conversation context.
 * @returns {Promise<{text: string, escalate: boolean, askResolved: boolean}>}
 */
const getBotReply = async (text, userId, suppliedContext = null) => {
  const trimmed = normalizeMessage(text);
  const context = suppliedContext && typeof suppliedContext === 'object'
    ? suppliedContext
    : createConversationContext(userId);

  if (context.userId !== userId || context.version !== CONTEXT_VERSION) {
    resetConversationContext(context, userId, context.conversationId || null);
  }
  context.preferredLanguage = detectPreferredLanguage(trimmed);

  if (!trimmed) {
    context.pendingClarification = { type: 'topic_selection', options: TOPIC_OPTIONS };
    return { text: TOPIC_MENU_TEXT, escalate: false, askResolved: false };
  }

  // A choice is meaningful only when the preceding bot message established a
  // matching menu/selection. In particular, a bare "yes" never becomes a
  // payment consent or a booking action by itself.
  if (context.pendingClarification) {
    const pendingResult = await handlePendingChoice(trimmed, userId, context);
    if (pendingResult) return pendingResult;
  }

  // A direct tracking number is an order selector, not a generic greeting or
  // a public lookup. The actual query remains scoped to the authenticated user.
  const explicitTopic = detectTopic(trimmed);
  if (explicitTopic && context.currentTopic && explicitTopic !== context.currentTopic) {
    // A selected booking remains useful across related questions such as
    // "check mine" → "what is my balance?". An explicit tracking number or
    // the topic menu is what changes/clears the selected booking.
    context.pendingClarification = null;
  }
  if (explicitTopic) context.currentTopic = explicitTopic;

  if (isBareHow(trimmed) && context.currentTopic) {
    const followup = TOPIC_FOLLOWUPS[context.currentTopic];
    if (followup) {
      context.pendingClarification = { type: 'topic_followup', topic: context.currentTopic };
      return { text: followup.text, escalate: false, askResolved: false, quickReplies: followup.options };
    }
  }

  if (isTopicMenuRequest(trimmed)) {
    context.currentTopic = null;
    context.pendingClarification = { type: 'topic_selection', options: TOPIC_OPTIONS };
    context.selectedBookingId = null;
    context.selectedTrackingNumber = null;
    return { text: TOPIC_MENU_TEXT, escalate: false, askResolved: false, quickReplies: TOPIC_OPTIONS.map(option => option.label) };
  }

  // Specific FAQs are checked before broad handoff patterns. A refund policy
  // question and packing advice are answerable; a case-specific missing
  // payment/refund or damage/loss report goes to a human.
  if (shouldEscalate(trimmed)) {
    context.pendingClarification = null;
    return { text: null, escalate: true, askResolved: false };
  }

  const trackingIntentIds = extractTrackingNumber(trimmed)
    ? (TRACKING_PAYMENT_RX.test(trimmed) ? ['payment_info'] : ['shipment_location'])
    : [];
  const intentsToTry = [
    ...trackingIntentIds.map(id => INTENTS.find(intent => intent.id === id)).filter(Boolean),
    ...INTENTS.filter(intent => !trackingIntentIds.includes(intent.id)),
  ];

  for (const intent of intentsToTry) {
    if (!intent.patterns.some(rx => rx.test(trimmed))) continue;
    try {
      const result = await intent.handler(userId, trimmed, context);
      context.currentTopic = INTENT_TOPIC[intent.id] || context.currentTopic;
      context.consecutiveUnrecognizedReplies = 0;
      if (result.askResolved) {
        context.pendingClarification = { type: 'resolved_confirmation', topic: context.currentTopic };
      }
      return { escalate: false, ...result };
    } catch (err) {
      console.warn('[Bot] Intent handler error:', err?.message || err);
      context.pendingClarification = null;
      return {
        text: 'I cannot load that information right now. Please try again, or choose “Talk to an Admin” so the team can help you without guessing.',
        escalate: false,
        askResolved: false,
        unavailable: true,
      };
    }
  }

  // If the user typed a broad topic word (e.g. "booking", "about payment")
  // but it didn't match a specific intent, show them the menu for that topic.
  if (explicitTopic) {
    const followup = TOPIC_FOLLOWUPS[explicitTopic];
    if (followup) {
      context.consecutiveUnrecognizedReplies = 0;
      context.pendingClarification = { type: 'topic_followup', topic: explicitTopic };
      return { text: followup.text, escalate: false, askResolved: false, quickReplies: followup.options };
    }
  }

  context.consecutiveUnrecognizedReplies += 1;
  const repeatedHint = context.consecutiveUnrecognizedReplies >= 2
    ? '\n\nI may be missing your question. You can choose a topic above or tap “Talk to an Admin.”'
    : '';
  return {
    text: `I’m not sure what you mean yet. You can ask about a booking, payment, delivery, pickup, or refund.${repeatedHint}`,
    escalate: false,
    askResolved: false,
  };
};

/**
 * BOT_GREETING — Sent automatically when customer opens chat for the first time
 */
const BOT_GREETING = `Hello! 👋 Kumusta! Maayong adlaw!
Welcome to CargoExpress PH Support.

I'm CargoMate PH, your support assistant.

Choose a topic below, or talk to an admin. You do not need to type a question.`;

return { createConversationContext, resetConversationContext, getSupportKnowledgeCatalog, SUPPORT_ACTIONS, getMainMenuActions, summarizePaymentActivity, getBotReplyForAction, getBotReply, BOT_GREETING, BOT_WELCOME_BACK };
};
