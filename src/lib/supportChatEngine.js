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
import { getSettlementState, outstandingBalance, SETTLEMENT_STATE } from '../constants/status';

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
  /damaged?/i,  /\bbroken\b/i,  /\bcrushed\b/i,                       // EN
  /\bsira(ng|n|do)?\b/i,  /\bnasira\b/i,                              // TL
  /\bguba(ng|on|y)?\b/i,  /\b(na|gi)guba\b/i,                         // CEB
  /\b(na)?bas[aá]g\b/i,  /\bnabuak\b/i,                               // TL/CEB
  /\b(na)?punit\b/i,  /\b(na)?gisi\b/i,  /\bgision\b/i,               // TL/CEB
  /\b(lamog|yupi|yupî|dukdok|pisó)\b/i,                               // TL/CEB
  /\bnabasa\s*(ang|ako|akong|ko|ung|yung)\b/i,                        // TL/CEB (got wet)
  /\bnahulog\b/i,  /\bnatapon\b/i,  /\bnayabo\b/i,                    // TL/CEB

  // ── Lost / missing / stolen ─────────────────────────────────────────────────
  /lost\s*(package|shipment|parcel|item)/i,                           // EN
  /missing\s*(package|shipment|item)/i,                               // EN
  /\bstolen\b/i,                                                      // EN
  /\bnawa(la|wala|le)\b/i,  /\bnangawala\b/i,                         // TL/CEB
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

  // ── Refund / reimbursement ──────────────────────────────────────────────────
  /refund/i,                                                          // EN
  /(report|reimburse|reimbursement)/i,                                // EN
  /\bibalik\s*(ang|akong|ung|yung)?\s*(bayad|pera|kwarta|kuwarta)\b/i, // TL
  /\b(iuli|isauli|sauli|iulî)\b/i,                                    // CEB
  /\bbawi(in)?\s*(ang|ko|akong)?\s*(bayad|pera|kwarta)\b/i,           // TL
  /\bbayaran\s*(ninyo|niyo|mo)\b/i,                                   // TL

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

// ── Tracking numbers ───────────────────────────────────────────────────────────

// CE-YYYYMMDD-NNNN, the format generated by generate_order_tracking_number().
// Separators are loose (dash, space, none) because customers retype these by
// hand from a screenshot; the extracted value is normalised before querying.
const TRACKING_NUMBER_RX = /\bCE[-\s]?(\d{8})[-\s]?(\d{4})\b/i;

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

// ── Intent matchers ────────────────────────────────────────────────────────────
//
// Every intent carries English (EN), Tagalog (TL) and Bisaya/Cebuano (CEB)
// phrasings. First match in this array wins, so the local patterns are scoped
// to the same specificity as their English neighbours: shared words that could
// belong to two intents ("magkano", "numero", "naabot") always require a
// disambiguating noun rather than matching bare.
const INTENTS = [
  // Greeting / hi / hello
  {
    id: 'greeting',
    patterns: [
      /^(hi+|hello+|hey|yo|good\s*(morning|afternoon|evening|day))\b/i,        // EN
      /^(mabuhay|kumusta|kamusta|k?musta|kmsta|hoy|uy|oy)\b/i,                 // TL
      /^(maayong|ma?ayong)\s*(buntag|hapon|udto|gabii|gabi|adlaw)/i,           // CEB
      /^(magandang)\s*(umaga|hapon|gabi|araw)/i,                               // TL
      /^(unsa\s*man|kumusta\s*ka|kamusta\s*po)\b/i,                            // CEB/TL
      /^(pwede|puydi|puede)\s*(po|ko|ba)?\s*(mag)?tanong\b/i,                  // TL/CEB
      /^(tabang|help)\s*(po|ko|ba)?\b/i,                                       // CEB/EN
    ],
    handler: async () => ({
      text: 'Hi there! 👋 Kumusta! Maayong adlaw!\n\nHow can I help you today? You can write in English, Tagalog, or Bisaya — kahit anong lengguwahe, sabihin lang po.\n\nYou can ask me about your:\n• Shipment status — asa na ang padala ko?\n• Booking information — may booking ba ako?\n• Payment details — magkano ang bayad ko?\n• Tracking number\n• Delivery process',
      askResolved: false,
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
    handler: async (userId, message) => {
      // A message naming a tracking number is asking about THAT parcel, not
      // about the newest one. Answering with the latest order instead is how
      // "status of CE-20260714-0007" got a reply about a different shipment.
      const tracking = extractTrackingNumber(message);
      if (tracking) {
        const order = await fetchOrderByTrackingNumber(userId, tracking);
        // No guessing which order they meant — a wrong parcel's status is worse
        // than saying we could not find this one.
        if (!order) return trackingNotFoundReply(message);
        return { text: describeOrder(order), askResolved: true };
      }

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
        text: `Here are your tracking numbers:\n\n${lines}\n\nYou can use any of these on the Track Package page for full details.`,
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
      /\basa\s*na\s*(ni|to|ang)\s*(akong|ako)\b/i,
      /\bwala\s*pa\s*(ba)?\s*(ni|to|ang|akong|yung|ung)\b/i,
      /\bhindi\s*pa\s*ba\b/i,
    ],
    handler: async (userId, message) => {
      const order = await resolveOrder(userId, message);
      if (order === NOT_FOUND) return trackingNotFoundReply(message);
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
    handler: async (userId, message) => {
      const order = await resolveOrder(userId, message);
      if (order === NOT_FOUND) return trackingNotFoundReply(message);
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
      unless(`${DURATION_WORDS}|${HUB_WORDS}`, 'deliver(y|ed|ing)'),           // EN
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
    handler: async (userId, message) => {
      const order = await resolveOrder(userId, message);
      if (order === NOT_FOUND) return trackingNotFoundReply(message);
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
    handler: async (userId, message) => {
      const order = await resolveOrder(userId, message);
      if (order === NOT_FOUND) return trackingNotFoundReply(message);
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
    handler: async (userId, message) => {
      const order = await resolveOrder(userId, message);
      if (order === NOT_FOUND) return trackingNotFoundReply(message);
      if (!order) {
        return { text: "You don't have any bookings, so there's no payment information to show.", askResolved: true };
      }

      const state = getSettlementState(order);
      const header = `💰 Payment details for ${order.tracking_number}:`;

      // Unpriced is its own answer. The old version printed ₱0.00 / ₱0.00 /
      // ₱0.00 and then "Payment is unpaid" for a parcel that has no price yet —
      // three zeros that look like a settled order and a badge that contradicts
      // them.
      if (state === SETTLEMENT_STATE.UNPRICED) {
        return {
          text: `${header}\n\n⚖️ Not priced yet.\n\nYour parcel is weighed at pickup and the shipping fee is computed from that weight, so there's no amount to show until then.\n\nCurrent status: ${order.status}`,
          askResolved: true,
        };
      }

      const cost = parseFloat(order.shipping_cost || 0) || 0;
      const paid = parseFloat(order.amount_paid || 0) || 0;
      const owed = outstandingBalance(order);
      const paymentLine = state === SETTLEMENT_STATE.SETTLED
        ? '✅ Payment is complete. Thank you!'
        : paid > 0
          ? '⚠️ Partially paid — you still have a balance outstanding.'
          : '❌ Payment is still outstanding.';

      return {
        text: `${header}\n\n💵 Shipping Fee: ₱${cost.toFixed(2)}\n✅ Amount Paid: ₱${paid.toFixed(2)}\n🔴 Balance: ₱${owed.toFixed(2)}\n\n${paymentLine}`,
        askResolved: true,
      };
    },
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
    handler: async (userId, message) => {
      const order = await resolveOrder(userId, message);
      if (order === NOT_FOUND) return trackingNotFoundReply(message);
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
    handler: async () => ({
      text: `⏱️ Delivery Timeline:\n\n• Bohol → Manila: Approximately 3–5 business days\n• Manila → Bohol: Approximately 3–5 business days\n\nActual delivery time may vary depending on trip schedules and weather conditions at sea.`,
      askResolved: true,
    }),
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
      let pricePerKg = 70;
      try {
        const { data } = await supabase.from('company_information').select('default_price_per_kg').single();
        if (data?.default_price_per_kg) pricePerKg = parseFloat(data.default_price_per_kg);
      } catch { /* use default */ }

      // No peso figure or percentage for the bulky charge. The admin sets it per
      // parcel when they see the actual size, and quoting a number the system
      // cannot compute would be a promise the bot has no way to keep.
      return {
        text: [
          `💰 Standard rate: ₱${pricePerKg.toFixed(2)} per kilogram.`,
          '',
          'For normal items — boxes, luggage, balikbayan boxes — kilo lang ang basehan:',
          `• 5 kg = ₱${(5 * pricePerKg).toFixed(2)}`,
          `• 10 kg = ₱${(10 * pricePerKg).toFixed(2)}`,
          `• 20 kg = ₱${(20 * pricePerKg).toFixed(2)}`,
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
  shipping_cost, amount_paid, remaining_balance, payment_status,
  actual_weight, sender_name, receiver_name,
  created_at,
  trips:trip_id (trip_number, origin, destination, status)
`;

const fetchCustomerOrders = async (userId) => {
  const { data, error } = await supabase
    .from('orders')
    .select(ORDER_FIELDS)
    .eq('user_id', userId)
    .neq('status', 'Cancelled')
    .order('created_at', { ascending: false })
    .limit(5);
  if (error) throw error;
  return data || [];
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

/**
 * Distinguishes "you named a parcel I can't find" from "you have no parcels".
 * Collapsing the two would answer a mistyped tracking number with the status of
 * an unrelated order.
 */
const NOT_FOUND = Symbol('tracking-not-found');

/**
 * resolveOrder — the order this message is about.
 *
 * A named tracking number wins over recency; without one, the newest order is
 * the subject, which is what every handler assumed before. Returns NOT_FOUND
 * when a tracking number was named but matched nothing the customer owns, and
 * null when they have no orders at all.
 */
const resolveOrder = async (userId, message) => {
  const tracking = extractTrackingNumber(message);
  if (tracking) {
    return (await fetchOrderByTrackingNumber(userId, tracking)) || NOT_FOUND;
  }
  const orders = await fetchCustomerOrders(userId);
  return orders[0] || null;
};

const trackingNotFoundReply = (message) => ({
  text: `I couldn't find ${extractTrackingNumber(message)} under your account.\n\nPlease double-check the tracking number — it looks like CE-20260807-1234. If it was booked with a different account, the Track Package page can look it up without signing in.`,
  askResolved: true,
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
  if (state === SETTLEMENT_STATE.UNPRICED) {
    return 'Not priced yet — your parcel is weighed at pickup, and the shipping fee is computed from that weight.';
  }
  const cost = parseFloat(order.shipping_cost || 0) || 0;
  const paid = parseFloat(order.amount_paid || 0) || 0;
  const owed = outstandingBalance(order);
  if (state === SETTLEMENT_STATE.SETTLED) {
    return `Shipping fee ₱${cost.toFixed(2)} — fully paid. Thank you!`;
  }
  return `Shipping fee ₱${cost.toFixed(2)} · Paid ₱${paid.toFixed(2)} · Balance ₱${owed.toFixed(2)}`;
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
        const result = await intent.handler(userId, trimmed);
        return { escalate: false, ...result };
      } catch (err) {
        // If DB query fails, fall through to fallback
        console.warn('[Bot] Intent handler error:', err.message);
      }
    }
  }

  // 3. Fallback — no match
  return {
    text: "I'm sorry, I didn't quite understand that. 🤔\nPasensya na po — hindi ko masyadong nakuha. Pasaylo, wala nako masabti.\n\nI can help you with:\n• Shipment status & location — asa na / nasaan na\n• Tracking number\n• Payment details — magkano / tagpila ang bayad\n• Booking information\n• Delivery timeline — ilang araw / pila ka adlaw\n• Pricing & rates — presyo kada kilo\n\nYou can also give me a tracking number like CE-20260807-1234 for one specific parcel.\n\nIf you'd rather speak to a person, tap “Talk to an Agent” below.",
    escalate: false,
    askResolved: true,
  };
};

/**
 * BOT_GREETING — Sent automatically when customer opens chat for the first time
 */
export const BOT_GREETING = `Hello! 👋 Kumusta! Maayong adlaw!
Welcome to CargoExpress PH Support.

I'm your virtual assistant. Pwede kang mag-message sa English, Tagalog, o Bisaya — kung unsa'y sayon nimo.

I can help you with:

• Shipment status & location
• Booking information
• Payment details & balance
• Tracking numbers
• Delivery process & timeline
• Frequently asked questions

How can I help you today?`;
