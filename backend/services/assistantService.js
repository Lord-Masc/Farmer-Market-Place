'use strict';
// AI Farmer Assistant (Stage 8, module G) — structured pipeline, NOT
// free-text generation: deterministic intent detection (Hindi-first
// keyword/pattern matching) -> tool calls against the platform's own
// services -> a templated answer built ONLY from the returned data,
// with sources[] citing the exact rows. No LLM call anywhere in this
// path (see llmProvider.js — the stub is never imported here).
//
// Grounding rule: a data-backed answer MUST cite at least one source,
// and every number in the answer must appear in the JSON of sources[].
// A "no data" answer stores sources: [] explicitly with no_data: true,
// so the conversation log is honest about what was (not) known.
//
// Stage 3 is BLOCKED: the mandi_prices table does NOT exist. The
// price tool treats a table-missing error (PostgREST 42P01 / PGRST205)
// as "no data available", never a 500 — and never invents a number.
const supabaseAdmin = require('../utils/supabaseAdmin');
const { AppError, notAccessible } = require('../utils/errors');
const negotiationService = require('./negotiationService');
const logisticsService = require('./logisticsService');
const disputeService = require('./disputeService');

const getSingle = (data) => (data && data.length > 0 ? data[0] : null);

// Hindi + English crop words -> the canonical crop name the tables use.
const CROPS = [
  ['gehun', 'Wheat'], ['wheat', 'Wheat'],
  ['chawal', 'Rice'], ['dhan', 'Rice'], ['rice', 'Rice'],
  ['makka', 'Maize'], ['maize', 'Maize'], ['corn', 'Maize'],
  ['aloo', 'Potato'], ['potato', 'Potato'],
  ['pyaaz', 'Onion'], ['onion', 'Onion'],
  ['tamatar', 'Tomato'], ['tomato', 'Tomato'],
  ['kapas', 'Cotton'], ['cotton', 'Cotton'],
  ['ganna', 'Sugarcane'], ['sugarcane', 'Sugarcane'],
  ['sarso', 'Mustard'], ['mustard', 'Mustard'],
  ['baingan', 'Brinjal'], ['brinjal', 'Brinjal'],
  ['gobhi', 'Cauliflower'], ['cauliflower', 'Cauliflower'],
  ['mirch', 'Chilli'], ['chilli', 'Chilli'], ['chili', 'Chilli'],
  ['dal', 'Pulses'], ['pulses', 'Pulses'],
  ['soyabean', 'Soybean'], ['soybean', 'Soybean'],
  ['moong', 'Moong'], ['chana', 'Chickpea'], ['chickpea', 'Chickpea'],
];

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// An id token must carry a digit (ord1, off1, tr1) or be a UUID —
// otherwise a plain word after "order" ("kahan") would be mistaken
// for an id.
function looksLikeId(token) {
  return !!token && (/\d/.test(token) || UUID_RE.test(token));
}

function extractId(message, labels) {
  const uuid = UUID_RE.exec(message);
  if (uuid) return uuid[0];
  const pattern = new RegExp(`(?:${labels.join('|')})\\s*[#:\\-]?\\s*([A-Za-z0-9][A-Za-z0-9_-]*)`, 'i');
  const match = pattern.exec(message);
  if (match && looksLikeId(match[1])) return match[1];
  return null;
}

// The requested price is the LAST number in the message once the id
// tokens are stripped (so the "1" in "off1" is never read as a price).
function extractPrice(message, ids) {
  let text = message;
  for (const id of ids) {
    if (id) text = text.split(id).join(' ');
  }
  const numbers = text.match(/\d[\d,]*/g);
  if (!numbers) return null;
  return Number(numbers[numbers.length - 1].replace(/,/g, ''));
}

function extractDates(message) {
  return message.match(/\d{4}-\d{2}-\d{2}/g) || [];
}

function extractCrop(message) {
  const lower = message.toLowerCase();
  for (const [word, crop] of CROPS) {
    if (lower.includes(word)) return crop;
  }
  return null;
}

function extractDisputeCategory(message) {
  const lower = message.toLowerCase();
  if (/\b(paisa|paise|payment|refund|bhugtan)\b/.test(lower)) return 'payment';
  if (/(nahi aaya|nahin aaya|nahi pahuncha|nahin pahuncha|pahuncha nahi|delivery nahi|nahi mila|not delivered)/.test(lower)) return 'non_delivery';
  if (/\b(kam|vajan|weight|quantity|adhura|adhoora)\b/.test(lower)) return 'quantity';
  if (/\b(kharab|kharaab|quality|bekar|sada|ganda)\b/.test(lower)) return 'quality';
  return null;
}

const containsAny = (lower, words) => words.some((w) => lower.includes(w));

// Deterministic intent detection, Hindi-first. Order matters: price
// before listing (both match "kya hai"), dispute before transport
// ("delivery nahi" is a dispute, not a booking), negotiate/transport
// before the bare "order" fallback to tracking.
function detectIntent(message) {
  const lower = String(message || '').toLowerCase();
  if (containsAny(lower, ['bhaav', 'bhav', 'keemat', 'kimat', 'mandi', 'daam', 'price', 'rate'])) {
    return { intent: 'price', entities: { crop: extractCrop(lower) } };
  }
  if (containsAny(lower, ['shikayat', 'shikaya', 'dispute', 'vivad', 'complaint'])) {
    return {
      intent: 'file_dispute',
      entities: { order_id: extractId(lower, ['order', 'ord']), category: extractDisputeCategory(lower) },
    };
  }
  if (containsAny(lower, ['sauda', 'mol-bhaav', 'molbhaav', 'negotiate', 'counter', 'offer', 'bargain'])) {
    const offerId = extractId(lower, ['offer', 'off']);
    return {
      intent: 'negotiate',
      entities: { offer_id: offerId, requested_price: extractPrice(lower, [offerId]) },
    };
  }
  if (containsAny(lower, ['transport', 'gaadi', 'gadi', 'bhejna', 'bhej', 'shipment'])) {
    const dates = extractDates(lower);
    return {
      intent: 'book_transport',
      entities: {
        order_id: extractId(lower, ['order', 'ord']),
        transporter_id: extractId(lower, ['transporter']),
        delivery_window_start: dates[0] || null,
        delivery_window_end: dates[1] || null,
      },
    };
  }
  if (containsAny(lower, ['track', 'kahan hai', 'kahan h', 'order status', 'order'])) {
    return { intent: 'track_order', entities: { order_id: extractId(lower, ['order', 'ord']) } };
  }
  if (containsAny(lower, ['sabzi', 'fasal', 'dikhao', 'dikh', 'kya hai', 'list', 'produce', 'show'])) {
    return { intent: 'list_produce', entities: {} };
  }
  return { intent: 'unknown', entities: {} };
}

function noData(intent, entities, answer) {
  return { intent, entities, answer, sources: [], no_data: true };
}

function isTableMissing(error) {
  if (!error) return false;
  return error.code === '42P01'
    || error.code === 'PGRST205'
    || /does not exist/i.test(String(error.message || ''));
}

async function toolListProduce() {
  const { data, error } = await supabaseAdmin
    .from('products')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) throw error;
  const rows = data || [];
  if (rows.length === 0) {
    return noData('list_produce', {}, 'Abhi koi sabzi listed nahi hai. (No produce is listed yet.)');
  }
  const sources = rows.map((r) => ({
    type: 'product', id: r.id, name: r.name, price: r.user_price, unit: r.unit,
  }));
  const lines = rows.map((r) => `${r.name} — ₹${r.user_price} per ${r.unit || 'kg'}`).join('; ');
  return {
    intent: 'list_produce', entities: {},
    answer: `Aaj ki sabzi: ${lines}. (Today's produce.)`,
    sources, no_data: false,
  };
}

async function toolPrice(entities) {
  const crop = entities.crop;
  if (!crop) {
    return noData('price', entities, 'Kis fasal ka bhaav chahiye? Fasal ka naam batayen. (Which crop\'s price do you need?)');
  }
  const { data, error } = await supabaseAdmin
    .from('mandi_prices')
    .select('*')
    .eq('crop', crop)
    .limit(5);
  // Stage 3 has not landed: a missing table is "no data", not a 500.
  if (error) {
    if (isTableMissing(error)) {
      return noData('price', entities, `${crop} ka mandi bhaav abhi uplabdh nahi hai. Mandi ke bhaav judne ke baad yahan dikhenge. (No mandi price data is available yet.)`);
    }
    throw error;
  }
  const rows = data || [];
  if (rows.length === 0) {
    return noData('price', entities, `${crop} ka mandi bhaav abhi uplabdh nahi hai. (No mandi price data is available for this crop yet.)`);
  }
  const row = rows[0];
  const sources = rows.map((r) => ({
    type: 'mandi_price', id: r.id, crop: r.crop, price: r.price,
    mandi: r.mandi || null, unit: r.unit || null, date: r.date || r.as_on || null,
  }));
  const price = row.price;
  const unit = row.unit ? ` per ${row.unit}` : '';
  const mandi = row.mandi ? ` — ${row.mandi} mandi` : '';
  const date = (row.date || row.as_on) ? `, ${row.date || row.as_on}` : '';
  return {
    intent: 'price', entities,
    answer: `${crop} ka mandi bhaav ₹${price}${unit} hai${mandi}${date}. (Mandi price.)`,
    sources, no_data: false,
  };
}

async function fetchOrder(orderId) {
  const { data, error } = await supabaseAdmin.from('orders').select('*').eq('id', orderId);
  if (error) throw error;
  return getSingle(data);
}

async function toolTrackOrder(callerId, entities) {
  if (!entities.order_id) {
    return noData('track_order', entities, 'Kis order ko track karna hai? Order ID batayen. (Which order should I track?)');
  }
  const order = await fetchOrder(entities.order_id);
  // Same generic no-data for a missing order and someone else's order.
  if (!order || (order.buyer_id !== callerId && order.farmer_id !== callerId)) {
    return noData('track_order', entities, 'Order nahi mila ya aapka nahi hai. (Order not found.)');
  }
  const orderSource = { type: 'order', id: order.id, status: order.status };
  const { data: shipments, error } = await supabaseAdmin
    .from('shipments').select('*').eq('order_id', order.id);
  if (error) throw error;
  const shipment = getSingle(shipments || []);
  if (!shipment) {
    return {
      intent: 'track_order', entities,
      answer: `Order ${order.id}: status ${order.status} hai. Abhi tak shipment book nahi hui hai. (No shipment booked yet.)`,
      sources: [orderSource], no_data: false,
    };
  }
  const tracked = await logisticsService.trackShipment(callerId, shipment.id);
  const trackedShipment = tracked.shipment || tracked;
  return {
    intent: 'track_order', entities,
    answer: `Order ${order.id}: status ${order.status} hai. Shipment ${shipment.id}: ${trackedShipment.status}. (Order tracked.)`,
    sources: [orderSource, { type: 'shipment', id: shipment.id, status: trackedShipment.status }],
    no_data: false,
  };
}

// The farmer's floor on their active offer: the lowest price in its
// price_tiers, or the offer price when there are no tiers.
function offerFloor(offer) {
  const tiers = Array.isArray(offer.price_tiers) ? offer.price_tiers : [];
  if (tiers.length === 0) return Number(offer.price);
  return Math.min(...tiers.map((t) => Number(t.price)));
}

async function toolNegotiate(callerId, entities) {
  if (!entities.offer_id) {
    return noData('negotiate', entities, 'Kis offer par sauda karna hai? Offer ID batayen. (Which offer should I negotiate?)');
  }
  const { data, error } = await supabaseAdmin.from('offers').select('*').eq('id', entities.offer_id);
  if (error) throw error;
  const offer = getSingle(data);
  // Only the farmer who owns the offer — anyone else gets the same
  // generic 404 as a missing offer (no existence oracle).
  if (!offer || offer.farmer_id !== callerId) {
    throw new AppError(404, 'NEGOTIATION_NOT_FOUND', 'Negotiation not found.');
  }
  if (entities.requested_price === null || entities.requested_price === undefined) {
    return noData('negotiate', entities, 'Kis keemat par sauda karna hai? Keemat batayen. (At what price should I negotiate?)');
  }
  const floor = offerFloor(offer);
  // floor is a scalar so the UI (which renders only scalar source
  // fields) can show the refusal's key number; price_tiers rides along
  // as the full offer shape for the grounding check.
  const offerSource = {
    type: 'offer', id: offer.id, price: offer.price, floor, price_tiers: offer.price_tiers || [],
  };
  if (entities.requested_price < floor) {
    return {
      intent: 'negotiate', entities,
      answer: `Mana kar diya gaya (refused): is offer ki sabse kam keemat ₹${floor} hai, isse kam par sauda nahi ho sakta. (The lowest price on this offer is ₹${floor} — I cannot go below it.)`,
      sources: [offerSource], no_data: false,
    };
  }
  // Within limits: place the counter as the farmer. The service
  // enforces its own rules (the latest offer must not be the farmer's
  // own — a farmer counters a buyer's counter, never their own quote).
  const counter = await negotiationService.counterOffer(callerId, offer.id, {
    price: entities.requested_price,
    quantity: offer.quantity,
    price_tiers: offer.price_tiers || [],
    expires_at: offer.expires_at,
  });
  return {
    intent: 'negotiate', entities,
    answer: `Sauda bhej diya gaya: ₹${counter.price} par counter-offer ban gaya hai. (Counter-offer placed at ₹${counter.price}.)`,
    sources: [{ type: 'offer', id: counter.id, price: counter.price }],
    no_data: false,
  };
}

async function toolBookTransport(callerId, entities) {
  if (!entities.order_id || !entities.transporter_id) {
    return noData('book_transport', entities, 'Transport book karne ke liye order ID aur transporter ID chahiye. (I need the order ID and transporter ID to book transport.)');
  }
  const order = await fetchOrder(entities.order_id);
  if (!order || order.farmer_id !== callerId) {
    return noData('book_transport', entities, 'Order nahi mila ya aapka nahi hai. (Order not found.)');
  }
  // Booking needs a committed delivery window — it is never invented:
  // without dates the assistant asks for them instead of booking.
  if (!entities.delivery_window_start || !entities.delivery_window_end) {
    return noData('book_transport', entities, 'Delivery ki tareekhen batayen — kab se kab tak? (Please share the delivery window dates.)');
  }
  const quote = await logisticsService.quoteShipment(callerId, {
    order_id: order.id, transporter_id: entities.transporter_id,
  });
  const shipment = await logisticsService.bookShipment(callerId, {
    order_id: order.id,
    transporter_id: entities.transporter_id,
    price_paise: quote.price_paise,
    delivery_window_start: entities.delivery_window_start,
    delivery_window_end: entities.delivery_window_end,
  });
  return {
    intent: 'book_transport', entities,
    answer: `Gaadi book ho gayi: shipment ${shipment.id}, kiraya ${shipment.price_paise} paise hai. (Transport booked.)`,
    sources: [
      { type: 'shipment', id: shipment.id, status: shipment.status, price_paise: shipment.price_paise },
      { type: 'quote', price_paise: quote.price_paise, distance_km: quote.distance_km, currency: quote.currency },
    ],
    no_data: false,
  };
}

async function toolFileDispute(callerId, message, entities) {
  if (!entities.order_id) {
    return noData('file_dispute', entities, 'Kis order ki shikayat hai? Order ID batayen. (Which order is the dispute about?)');
  }
  if (!entities.category) {
    return noData('file_dispute', entities, 'Samajh nahi aaya — samasya kya hai: kharab maal, kam vajan, delivery nahi aayi, ya paisa? (What is the problem: bad quality, short quantity, non-delivery, or payment?)');
  }
  const order = await fetchOrder(entities.order_id);
  // The service re-enforces counterparty, but the generic 404 here
  // keeps a missing order and someone else's order indistinguishable.
  if (!order || (order.buyer_id !== callerId && order.farmer_id !== callerId)) {
    throw notAccessible();
  }
  const dispute = await disputeService.fileDispute(callerId, {
    order_id: order.id, category: entities.category, description: message.trim(),
  });
  return {
    intent: 'file_dispute', entities,
    answer: `Shikayat darj ho gayi: dispute ${dispute.id}, status ${dispute.status} hai. (Dispute filed.)`,
    sources: [{ type: 'dispute', id: dispute.id, status: dispute.status, category: dispute.category, order_id: dispute.order_id }],
    no_data: false,
  };
}

function toolUnknown(entities) {
  return noData(
    'unknown', entities,
    'Samajh nahi aaya. Main inme madad kar sakta hoon: mandi bhaav, order track karna, sauda, transport book karna, shikayat darj karna, aur sabzi dekhna. (I did not understand — I can help with mandi prices, order tracking, negotiation, transport booking, disputes, and browsing produce.)',
  );
}

async function handleMessage(userId, message) {
  const { intent, entities } = detectIntent(message);
  switch (intent) {
    case 'list_produce': return toolListProduce();
    case 'price': return toolPrice(entities);
    case 'track_order': return toolTrackOrder(userId, entities);
    case 'negotiate': return toolNegotiate(userId, entities);
    case 'book_transport': return toolBookTransport(userId, entities);
    case 'file_dispute': return toolFileDispute(userId, message, entities);
    default: return toolUnknown(entities);
  }
}

// One row holds a conversation's whole history (messages jsonb); each
// call appends the user turn + the assistant turn. A conversation_id
// that does not exist — or belongs to someone else — never opens that
// row: a fresh conversation is started instead.
async function chat(userId, message, conversationId) {
  if (typeof message !== 'string' || !message.trim()) {
    throw new AppError(400, 'VALIDATION_ERROR', 'message must be a non-empty string.');
  }
  if (typeof message === 'string' && message.length > 2000) {
    throw new AppError(400, 'VALIDATION_ERROR', 'message must be at most 2000 characters.');
  }
  const result = await handleMessage(userId, message);
  const now = new Date().toISOString();
  const userTurn = { role: 'user', content: message, at: now };
  const assistantTurn = {
    role: 'assistant', content: result.answer, intent: result.intent,
    sources: result.sources, no_data: result.no_data, at: now,
  };

  let row = null;
  if (conversationId) {
    const { data, error } = await supabaseAdmin
      .from('assistant_conversations')
      .select('*')
      .eq('id', conversationId)
      .eq('user_id', userId);
    if (error) throw error;
    row = getSingle(data);
  }
  if (row) {
    const messages = [...(Array.isArray(row.messages) ? row.messages : []), userTurn, assistantTurn];
    const { data: updated, error } = await supabaseAdmin
      .from('assistant_conversations')
      .update({ messages, sources: result.sources, updated_at: now })
      .eq('id', row.id)
      .eq('user_id', userId)
      .select('*');
    if (error) throw error;
    row = getSingle(updated) || row;
  } else {
    const { data: inserted, error } = await supabaseAdmin
      .from('assistant_conversations')
      .insert({
        user_id: userId,
        messages: [userTurn, assistantTurn],
        sources: result.sources,
      })
      .select('*');
    if (error) throw error;
    row = getSingle(inserted);
  }
  return { conversation_id: row.id, ...result };
}

module.exports = { detectIntent, handleMessage, chat };
