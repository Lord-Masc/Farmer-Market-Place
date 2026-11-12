'use strict';
// Digital Crop Passport (Stage 2, module A).
// Service layer only — authorization lives in the route middleware
// (requireAuth / requireRole('farmer') for the farmer routes); these
// functions assume the caller was already authorized. The two public
// reads enforce the verified-farmer gate here: a passport is only ever
// returned for a farmer whose profiles.verification_status is 'verified'.
// All reads go through the service-role client; PostgREST has no anon
// SELECT on crop_passports, so there is no other public path to a lot.
// mandi_price_reference is snapshotted server-side from the product's
// gov_price — the ONLY mandi-price source this stage may use — and stored
// NULL when gov_price is NULL or 0. A price is never invented.
const supabaseAdmin = require('../utils/supabaseAdmin');
const { AppError } = require('../utils/errors');
const { logAudit } = require('../utils/auditLog');

const QUALITY_GRADES = ['A', 'B', 'C', 'ungraded'];

// Same getSingle shape as escrowService: supabase-js returns arrays.
const getSingle = (data) => (data && data.length > 0 ? data[0] : null);

function validationError(message) {
  return new AppError(422, 'VALIDATION_ERROR', message);
}

function isNonEmptyString(value, maxLength) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

// A real calendar date (2026-13-40 passes Date.parse's leniency in some
// engines, so the components are checked back), not in the future.
function isValidPastDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    return false;
  }
  return value <= new Date().toISOString().slice(0, 10);
}

function validateCreateInput(body = {}) {
  const { product_id, crop, variety, quantity, unit, harvest_date, quality_grade, photos } = body;
  if (typeof product_id !== 'string' || !product_id.trim()) {
    throw validationError('product_id is required.');
  }
  if (!isNonEmptyString(crop, 120)) {
    throw validationError('crop must be a non-empty string of at most 120 characters.');
  }
  if (variety !== undefined && variety !== null && (typeof variety !== 'string' || variety.length > 120)) {
    throw validationError('variety must be a string of at most 120 characters.');
  }
  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty <= 0) {
    throw validationError('quantity must be a number greater than 0.');
  }
  if (!isNonEmptyString(unit, 20)) {
    throw validationError('unit must be a non-empty string of at most 20 characters.');
  }
  if (!isValidPastDate(harvest_date)) {
    throw validationError('harvest_date must be a valid date that is not in the future.');
  }
  if (!QUALITY_GRADES.includes(quality_grade)) {
    throw validationError('quality_grade must be A, B, C or ungraded.');
  }
  if (photos !== undefined && photos !== null) {
    if (!Array.isArray(photos) || photos.length > 5) {
      throw validationError('photos must be an array of at most 5 URLs.');
    }
    for (const photo of photos) {
      if (typeof photo !== 'string' || photo.length > 2048 || !/^https?:\/\/.+/.test(photo)) {
        throw validationError('each photo must be an http(s) URL of at most 2048 characters.');
      }
    }
  }
  return {
    product_id: product_id.trim(),
    crop: crop.trim(),
    variety: variety === undefined || variety === null || variety === '' ? null : variety,
    quantity: qty,
    unit: unit.trim(),
    harvest_date,
    quality_grade,
    photos: photos || [],
  };
}

async function fetchProduct(productId) {
  const { data, error } = await supabaseAdmin
    .from('products')
    .select('id,farmer_id,name,gov_price')
    .eq('id', productId);
  if (error) throw error;
  return getSingle(data);
}

// The farmer's stats row from the farmer_stats view (plain view, always
// fresh). No row exists for a farmer with zero orders — that is null, not
// a zeroed row.
async function getFarmerStats(farmerId) {
  const { data, error } = await supabaseAdmin
    .from('farmer_stats')
    .select('*')
    .eq('farmer_id', farmerId);
  if (error) throw error;
  return getSingle(data);
}

// Attach product names to lots (second query — no PostgREST embed, keeps
// the mock-friendly select shape, same as verificationService).
async function withProductNames(lots) {
  if (!lots || lots.length === 0) return [];
  const productIds = [...new Set(lots.map((l) => l.product_id))];
  const { data: products, error } = await supabaseAdmin
    .from('products')
    .select('id,name')
    .in('id', productIds);
  if (error) throw error;
  const names = Object.fromEntries((products || []).map((p) => [p.id, p.name]));
  return lots.map((lot) => ({ ...lot, product_name: names[lot.product_id] || null }));
}

async function fetchOwnPassports(farmerId) {
  const { data, error } = await supabaseAdmin
    .from('crop_passports')
    .select('*')
    .eq('farmer_id', farmerId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

// Create a passport lot for one of the caller's own products. The product
// lookup and the ownership check share one 403 so a missing product and
// someone else's product are indistinguishable (no existence oracle).
async function createPassport(farmerId, body) {
  const input = validateCreateInput(body);
  const product = await fetchProduct(input.product_id);
  if (!product || product.farmer_id !== farmerId) {
    throw new AppError(403, 'FORBIDDEN', 'You can only create a passport for your own product.');
  }
  const { data: existing, error: existingError } = await supabaseAdmin
    .from('crop_passports')
    .select('id')
    .eq('product_id', input.product_id);
  if (existingError) throw existingError;
  // The UNIQUE(product_id) constraint is the race backstop; this check
  // gives the clean 409 instead of a constraint error.
  if (existing && existing.length > 0) {
    throw new AppError(409, 'PASSPORT_EXISTS', 'A passport already exists for this product.');
  }
  const govPrice = Number(product.gov_price);
  const mandiPrice = Number.isFinite(govPrice) && govPrice > 0 ? govPrice : null;
  const { data: inserted, error: insertError } = await supabaseAdmin
    .from('crop_passports')
    .insert({
      product_id: input.product_id,
      farmer_id: farmerId,
      crop: input.crop,
      variety: input.variety,
      quantity: input.quantity,
      unit: input.unit,
      harvest_date: input.harvest_date,
      quality_grade: input.quality_grade,
      photos: input.photos,
      mandi_price_reference: mandiPrice,
    })
    .select('*');
  if (insertError) throw insertError;
  const passport = getSingle(inserted);
  await logAudit(farmerId, 'passport.created', { product_id: input.product_id, passport_id: passport.id });
  return passport;
}

// The farmer's own lots (with product names) plus their stats row.
async function listMyPassports(farmerId) {
  const lots = await withProductNames(await fetchOwnPassports(farmerId));
  const stats = await getFarmerStats(farmerId);
  return { lots, stats: stats || null };
}

// Public farmer passport. A missing farmer and an unverified farmer give
// the SAME 404, so the endpoint never reveals whether the id exists.
async function getFarmerPassport(farmerId) {
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('id,first_name,last_name,city,state,verification_status,verified_at')
    .eq('id', farmerId);
  if (error) throw error;
  const farmer = getSingle(data);
  if (!farmer || farmer.verification_status !== 'verified') {
    throw new AppError(404, 'PASSPORT_NOT_FOUND', 'Passport not found.');
  }
  const lots = await withProductNames(await fetchOwnPassports(farmerId));
  const stats = await getFarmerStats(farmerId);
  return {
    farmer: {
      id: farmer.id,
      first_name: farmer.first_name,
      last_name: farmer.last_name,
      city: farmer.city,
      state: farmer.state,
      verification_status: farmer.verification_status,
      verified_at: farmer.verified_at,
    },
    stats: stats || null,
    lots,
  };
}

// Public product passport. An unverified farmer's lot is never leaked:
// the lot fields stay null and only farmer_verified: false is shown.
async function getProductPassport(productId) {
  const product = await fetchProduct(productId);
  if (!product) {
    throw new AppError(404, 'PASSPORT_NOT_FOUND', 'Passport not found.');
  }
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('id,verification_status')
    .eq('id', product.farmer_id);
  if (error) throw error;
  const farmer = getSingle(data);
  if (!farmer || farmer.verification_status !== 'verified') {
    return { product_id: product.id, farmer_verified: false, passport: null };
  }
  const { data: rows, error: passportError } = await supabaseAdmin
    .from('crop_passports')
    .select('*')
    .eq('product_id', product.id);
  if (passportError) throw passportError;
  return { product_id: product.id, farmer_verified: true, passport: getSingle(rows) || null };
}

module.exports = {
  createPassport,
  listMyPassports,
  getFarmerPassport,
  getProductPassport,
};
