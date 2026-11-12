'use strict';
// Notification templates (Stage 9, module H) — Hindi/English strings
// per event type, parameterized from the payload.
//
// Grounding rule (same class as the Stage 8 assistant): a title/body
// is built ONLY from the payload — a number appears only when the
// payload carries it. A template called with an empty payload contains
// NO digits at all (asserted in notifications.test.js), so no template
// may hard-code a count, a day, a rate, or any other number. Language
// comes from the user's preference, default 'hi' (Hindi-first, per
// the Stage 8 precedent).
const { AppError } = require('../utils/errors');

// The event-type enum — these exact strings are used everywhere: the
// migration CHECK, emit() calls, preferences, and the frontend.
const EVENT_TYPES = [
  'order_created', 'order_confirmed', 'order_declined', 'order_paid',
  'order_shipped', 'order_completed', 'refund_requested', 'refunded',
  'offer_received', 'offer_countered', 'offer_accepted', 'offer_rejected',
  'group_joined', 'group_closed', 'settlement_ready',
  'shipment_booked', 'shipment_status', 'shipment_delivered',
  'dispute_filed', 'dispute_status', 'dispute_resolved',
  'verification_submitted', 'verification_approved', 'verification_rejected',
];

const CHANNELS = ['in_app', 'email', 'sms'];

// Optional fragments — each renders only when the payload carries the
// field, so a no-data template stays digit-free and honest.
function moneyFragment(payload, lang) {
  if (payload.total_price == null) return '';
  return lang === 'hi'
    ? ` Kul rakam ₹${payload.total_price} hai.`
    : ` Total amount ₹${payload.total_price}.`;
}

function priceFragment(payload, lang) {
  if (payload.price == null) return '';
  return lang === 'hi' ? ` Keemat ₹${payload.price} hai.` : ` Price ₹${payload.price}.`;
}

function quantityFragment(payload, lang) {
  if (payload.quantity == null || payload.unit == null) return '';
  return lang === 'hi'
    ? ` Matra ${payload.quantity} ${payload.unit}.`
    : ` Quantity ${payload.quantity} ${payload.unit}.`;
}

function cropFragment(payload, lang) {
  if (!payload.crop) return '';
  return lang === 'hi' ? ` Fasal: ${payload.crop}.` : ` Crop: ${payload.crop}.`;
}

function statusFragment(payload, lang) {
  if (!payload.status) return '';
  return lang === 'hi' ? ` Nayi sthiti: ${payload.status}.` : ` New status: ${payload.status}.`;
}

function outcomeFragment(payload, lang) {
  if (!payload.outcome) return '';
  return lang === 'hi' ? ` Nirnay: ${payload.outcome}.` : ` Outcome: ${payload.outcome}.`;
}

function categoryFragment(payload, lang) {
  if (!payload.category) return '';
  return lang === 'hi' ? ` Shreni: ${payload.category}.` : ` Category: ${payload.category}.`;
}

function noteFragment(payload, lang) {
  if (!payload.note) return '';
  return lang === 'hi' ? ` Karan: ${payload.note}.` : ` Reason: ${payload.note}.`;
}

// Each entry: [hiTitle, enTitle, hiBody(payload), enBody(payload)].
const TEMPLATES = {
  order_created: ['Naya order', 'New order',
    (p) => `Aapka order ban gaya hai.${moneyFragment(p, 'hi')}${quantityFragment(p, 'hi')}`,
    (p) => `Your order has been placed.${moneyFragment(p, 'en')}${quantityFragment(p, 'en')}`],
  order_confirmed: ['Order confirm ho gaya', 'Order confirmed',
    () => 'Kisan ne aapka order confirm kar diya hai.',
    () => 'The farmer has confirmed your order.'],
  order_declined: ['Order decline kar diya gaya', 'Order declined',
    () => 'Kisan ne aapka order decline kar diya hai.',
    () => 'The farmer has declined your order.'],
  order_paid: ['Bhugtan mil gaya', 'Payment received',
    (p) => `Order ka bhugtan mil gaya hai.${moneyFragment(p, 'hi')}`,
    (p) => `Payment for your order has been received.${moneyFragment(p, 'en')}`],
  order_shipped: ['Order bhej diya gaya', 'Order shipped',
    () => 'Aapka order bhej diya gaya hai.',
    () => 'Your order has been shipped.'],
  order_completed: ['Order pura ho gaya', 'Order complete',
    () => 'Order pura ho gaya hai aur bhugtan jaari kar diya gaya hai.',
    () => 'Your order is complete and the payment has been released.'],
  refund_requested: ['Refund ka anurodh', 'Refund requested',
    () => 'Aapke order par refund ka anurodh mila hai.',
    () => 'A refund has been requested for your order.'],
  refunded: ['Refund kar diya gaya', 'Refund issued',
    (p) => `Aapke order ka refund kar diya gaya hai.${moneyFragment(p, 'hi')}`,
    (p) => `Your order has been refunded.${moneyFragment(p, 'en')}`],
  offer_received: ['Naya offer mila', 'New offer received',
    (p) => `Aapki requirement par naya offer mila hai.${priceFragment(p, 'hi')}${cropFragment(p, 'hi')}`,
    (p) => `You received a new offer on your requirement.${priceFragment(p, 'en')}${cropFragment(p, 'en')}`],
  offer_countered: ['Offer par jawab mila', 'Offer countered',
    (p) => `Aapke offer par jawab mila hai.${priceFragment(p, 'hi')}`,
    (p) => `Your offer received a counter.${priceFragment(p, 'en')}`],
  offer_accepted: ['Offer swikar ho gaya', 'Offer accepted',
    (p) => `Offer swikar kar liya gaya hai.${priceFragment(p, 'hi')}${quantityFragment(p, 'hi')}`,
    (p) => `Your offer was accepted.${priceFragment(p, 'en')}${quantityFragment(p, 'en')}`],
  offer_rejected: ['Offer aswikar ho gaya', 'Offer rejected',
    () => 'Offer aswikar kar diya gaya hai.',
    () => 'Your offer was rejected.'],
  group_joined: ['Group se jud gaye', 'Someone joined your group',
    (p) => `Aapke group se ek kisan jud gaya hai.${cropFragment(p, 'hi')}`,
    (p) => `A farmer joined your group buy.${cropFragment(p, 'en')}`],
  group_closed: ['Group band ho gaya', 'Group closed',
    (p) => `Group band ho gaya hai aur order ban gaya hai.${cropFragment(p, 'hi')}`,
    (p) => `Your group buy is closed and the order has been placed.${cropFragment(p, 'en')}`],
  settlement_ready: ['Hisab taiyar hai', 'Settlement ready',
    () => 'Aapke group ka hisab taiyar hai.',
    () => 'Your group settlement is ready.'],
  shipment_booked: ['Delivery book ho gayi', 'Delivery booked',
    () => 'Aapke order ki delivery book ho gayi hai.',
    () => 'Delivery for your order has been booked.'],
  shipment_status: ['Delivery ki sthiti badli', 'Delivery status changed',
    (p) => `Aapki delivery ki sthiti badal gayi hai.${statusFragment(p, 'hi')}`,
    (p) => `Your delivery status changed.${statusFragment(p, 'en')}`],
  shipment_delivered: ['Delivery ho gayi', 'Delivery complete',
    () => 'Aapki delivery ho gayi hai.',
    () => 'Your delivery is complete.'],
  dispute_filed: ['Vivad darj hua', 'Dispute filed',
    (p) => `Aapke order par vivad darj kiya gaya hai.${categoryFragment(p, 'hi')}`,
    (p) => `A dispute was filed on your order.${categoryFragment(p, 'en')}`],
  dispute_status: ['Vivad ki sthiti badli', 'Dispute status changed',
    (p) => `Aapke vivad ki sthiti badal gayi hai.${statusFragment(p, 'hi')}`,
    (p) => `Your dispute status changed.${statusFragment(p, 'en')}`],
  dispute_resolved: ['Vivad sulajh gaya', 'Dispute resolved',
    (p) => `Aapka vivad sulajh gaya hai.${outcomeFragment(p, 'hi')}`,
    (p) => `Your dispute is resolved.${outcomeFragment(p, 'en')}`],
  verification_submitted: ['Verification arzi mili', 'Verification submitted',
    () => 'Verification ke liye ek arzi mili hai.',
    () => 'A verification application was submitted.'],
  verification_approved: ['Verification swikar ho gayi', 'Verification approved',
    () => 'Aapki verification swikar ho gayi hai.',
    () => 'Your verification was approved.'],
  verification_rejected: ['Verification aswikar ho gayi', 'Verification rejected',
    (p) => `Aapki verification aswikar ho gayi hai.${noteFragment(p, 'hi')}`,
    (p) => `Your verification was rejected.${noteFragment(p, 'en')}`],
};

function buildTemplate(type, language, payload = {}) {
  const entry = TEMPLATES[type];
  if (!entry) {
    throw new AppError(422, 'VALIDATION_ERROR', `Unknown notification type: ${type}.`);
  }
  const [hiTitle, enTitle, hiBody, enBody] = entry;
  const lang = language === 'en' ? 'en' : 'hi';
  return lang === 'en'
    ? { title: enTitle, body: enBody(payload) }
    : { title: hiTitle, body: hiBody(payload) };
}

module.exports = { EVENT_TYPES, CHANNELS, TEMPLATES, buildTemplate };
