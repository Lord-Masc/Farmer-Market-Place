// Shared Playwright mock layer for the Stage 11 regression happy paths.
//
// SCOPE (read this before trusting a green run): these specs verify the
// FRONTEND UI FLOW end-to-end (signup -> list -> order -> pay -> ship ->
// deliver -> release; dispute -> resolve; group buy -> settle). They do
// NOT verify live integration. Every network call the app makes is
// intercepted in the browser and answered by the in-memory store below:
//   * Supabase Auth (/auth/v1/*) and PostgREST (/rest/v1/*) on the dummy
//     host https://mock.supabase.co (set via VITE_SUPABASE_URL in
//     playwright.config.js — no real project, no real key).
//   * The escrow backend (/api/*) on http://127.0.0.1:5001 (set via
//     VITE_ESCROW_API_URL) — answered by the same store, not the real API.
//   * Razorpay Checkout is stubbed with window.Razorpay (addInitScript):
//     the handler fires immediately with fake ids; no gateway is loaded.
//   * Google Maps / Google Fonts requests are aborted (the app degrades
//     without them: geocoding is skipped when no key/window.google).
// The backend Jest suite (457 tests) is the contract check for the real
// API; the live smoke test (Rishabh) is the integration check. Nothing
// here touches production Supabase, Razorpay, or any live endpoint.
import { test as base } from '@playwright/test';

export const MOCK_SUPABASE_URL = 'https://mock.supabase.co';
export const MOCK_API_URL = 'http://127.0.0.1:5001';

// Minimal 1x1 PNG for the two photo uploads the listing form requires.
export const PNG_1X1 = globalThis.Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAwMCAO+ip1sAAAAASUVORK5CYII=',
  'base64',
);

const b64url = (obj) =>
  globalThis.Buffer.from(JSON.stringify(obj)).toString('base64url');

export function fakeJwt(userId, email) {
  const header = b64url({ alg: 'none', typ: 'JWT' });
  const payload = b64url({ sub: userId, email, exp: 1893456000, iat: 1763000000 });
  return `${header}.${payload}.mock-signature`;
}

function userIdFromAuth(request) {
  const header = request.headers().authorization || '';
  const token = header.replace(/^Bearer\s+/i, '');
  try {
    return JSON.parse(globalThis.Buffer.from(token.split('.')[1], 'base64url').toString()).sub;
  } catch {
    return null;
  }
}

let seq = 0;
const nextId = (prefix) => `${prefix}-${++seq}-${Date.now().toString(36)}`;

// One store per test file run, shared across the browser contexts in a
// test (farmer + buyer + admin act on the same marketplace).
export function createStore() {
  return {
    users: new Map(), // email -> { id, email, role, first_name, last_name, phone_number, state }
    profiles: [], // { id, email, role, first_name, last_name, phone_number, ... }
    products: [], // { id, farmer_id, name, quantity, unit, user_price, category, ... }
    orders: [], // { id, product_id, buyer_id, farmer_id, quantity, unit, total_price, status, ... }
    payments: [], // { id, order_id, status }
    disputes: [], // { id, order_id, buyer_id, farmer_id, category, status, ... }
    disputeMessages: [], // { id, dispute_id, author_id, author_role, body, created_at }
    groupBuys: [], // { id, owner_id, crop, threshold_quantity, unit, deadline, status, total_quantity, ... }
    groupParticipants: [], // { id, group_buy_id, user_id, contribution_quantity, share }
    settlements: [], // { id, group_buy_id, participant_id, amount_paise, status }
  };
}

function sessionFor(store, user) {
  const access_token = fakeJwt(user.id, user.email);
  return {
    access_token,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: 1893456000,
    refresh_token: `mock-refresh-${user.id}`,
    user: {
      id: user.id,
      email: user.email,
      user_metadata: {
        first_name: user.first_name,
        last_name: user.last_name,
        phone_number: user.phone_number,
        role: user.role,
        state: user.state || null,
      },
      app_metadata: {},
      aud: 'authenticated',
      created_at: new Date().toISOString(),
    },
  };
}

function applyPostgrestFilters(rows, params) {
  let out = [...rows];
  for (const [key, value] of params.entries()) {
    if (key === 'select' || key === 'order' || key === 'limit' || key === 'offset') continue;
    const eq = value.match(/^eq\.(.*)$/);
    const inMatch = value.match(/^in\.\((.*)\)$/);
    if (eq) out = out.filter((r) => String(r[key]) === decodeURIComponent(eq[1]));
    else if (inMatch) {
      const set = new Set(inMatch[1].split(',').map((v) => decodeURIComponent(v)));
      out = out.filter((r) => set.has(String(r[key])));
    }
    // Unknown operators are ignored: the mock answers with the full set.
  }
  const order = params.get('order');
  if (order) {
    const [col, dir] = order.split('.');
    out.sort((a, b) => {
      if (a[col] < b[col]) return dir === 'desc' ? 1 : -1;
      if (a[col] > b[col]) return dir === 'desc' ? -1 : 1;
      return 0;
    });
  }
  return out;
}

export async function installMocks(page, store) {
  // Razorpay Checkout stub: loadRazorpay() short-circuits on
  // window.Razorpay, so the real script is never fetched; open() fires
  // the handler with fake ids on the next tick.
  await page.addInitScript(() => {
    window.Razorpay = class {
      constructor(options) { this.options = options; }
      open() {
        setTimeout(() => {
          this.options.handler({
            razorpay_order_id: this.options.order_id,
            razorpay_payment_id: 'pay_mock_1',
            razorpay_signature: 'sig_mock',
          });
        }, 50);
      }
      on() {}
    };
  });

  // External services the app degrades without: fail fast, never hang.
  await page.route('**/maps.googleapis.com/**', (route) => route.abort());
  await page.route('**/fonts.googleapis.com/**', (route) => route.abort());
  await page.route('**/fonts.gstatic.com/**', (route) => route.abort());
  await page.route('**/checkout.razorpay.com/**', (route) => route.abort());
  await page.route('**/source.unsplash.com/**', (route) => route.abort());
  // The mocked upload endpoint returns a mock.supabase.co storage URL;
  // answer image loads for it with the 1x1 PNG instead of hitting the
  // network (the dummy host does not exist).
  await page.route('**/mock.supabase.co/storage/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: PNG_1X1 }));

  // ---- Supabase Auth (GoTrue) ----
  await page.route('**/mock.supabase.co/auth/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace('/auth/v1/', '');

    if (path === 'signup' && req.method() === 'POST') {
      const body = req.postDataJSON() || {};
      const meta = body.data || {};
      const existing = store.users.get(body.email);
      if (existing) {
        return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'User already registered', msg: 'User already registered' }) });
      }
      const user = {
        id: nextId('user'),
        email: body.email,
        role: meta.role || 'buyer',
        first_name: meta.first_name || '',
        last_name: meta.last_name || '',
        phone_number: meta.phone_number || '',
        state: meta.state || null,
      };
      store.users.set(body.email, user);
      // The handle_new_user trigger creates the profiles row from metadata.
      store.profiles.push({ ...user, created_at: new Date().toISOString() });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(sessionFor(store, user)) });
    }

    if (path === 'token' && req.method() === 'POST') {
      const grant = url.searchParams.get('grant_type');
      if (grant === 'refresh_token') {
        const body = req.postDataJSON() || {};
        const userId = (body.refresh_token || '').replace('mock-refresh-', '');
        const user = [...store.users.values()].find((u) => u.id === userId);
        if (!user) return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'invalid_grant' }) });
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(sessionFor(store, user)) });
      }
      const body = req.postDataJSON() || {};
      const user = store.users.get(body.email);
      if (!user) return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Invalid login credentials', msg: 'Invalid login credentials' }) });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(sessionFor(store, user)) });
    }

    if (path === 'user' && req.method() === 'GET') {
      const userId = userIdFromAuth(req);
      const user = [...store.users.values()].find((u) => u.id === userId);
      if (!user) return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'invalid token' }) });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(sessionFor(store, user).user) });
    }

    if (path === 'logout') {
      return route.fulfill({ status: 204, body: '' });
    }

    return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: `mock: unhandled auth route ${path}` }) });
  });

  // ---- Supabase PostgREST ----
  await page.route('**/mock.supabase.co/rest/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const table = url.pathname.replace('/rest/v1/', '');
    const params = url.searchParams;
    const isSingle = (req.headers().accept || '').includes('application/vnd.pgrst.object+json');

    const tableRows = () => {
      if (table === 'public_farmer_profiles') {
        return store.profiles.filter((p) => p.role === 'farmer').map((p) => ({
          id: p.id, first_name: p.first_name, last_name: p.last_name, phone_number: p.phone_number,
        }));
      }
      return store[table] || [];
    };

    if (req.method() === 'GET') {
      const rows = applyPostgrestFilters(tableRows(), params);
      if (isSingle) {
        if (rows.length !== 1) {
          return route.fulfill({ status: 406, contentType: 'application/json', body: JSON.stringify({ code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' }) });
        }
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows[0]) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) });
    }

    if (req.method() === 'POST') {
      const body = req.postDataJSON();
      const rows = Array.isArray(body) ? body : [body];
      const inserted = rows.map((r) => {
        const row = { id: nextId(table.slice(0, -1) || 'row'), created_at: new Date().toISOString(), ...r };
        if (table === 'products') {
          row.price = row.user_price;
          row.status = 'active';
        }
        store[table].push(row);
        return row;
      });
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(inserted) });
    }

    if (req.method() === 'PATCH') {
      const body = req.postDataJSON() || {};
      const rows = applyPostgrestFilters(tableRows(), params);
      rows.forEach((r) => Object.assign(r, body));
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) });
    }

    if (req.method() === 'DELETE') {
      const rows = applyPostgrestFilters(tableRows(), params);
      store[table] = tableRows().filter((r) => !rows.includes(r));
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) });
    }

    return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: `mock: unhandled rest method ${req.method()}` }) });
  });

  // ---- Escrow backend API (mock) ----
  await page.route('**/127.0.0.1:5001/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(/^\/api/, '');
    const callerId = userIdFromAuth(req);
    const caller = [...store.users.values()].find((u) => u.id === callerId);
    const json = (status, obj) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) });
    const body = () => { try { return req.postDataJSON() || {}; } catch { return {}; } };
    const orderTotal = (o) => o.total_price;

    // Order creation (POST /api/orders).
    if (path === '/orders' || path === '/orders/') {
      if (req.method() !== 'POST') return json(404, { error: 'mock: unhandled orders route' });
      const b = body();
      const product = store.products.find((p) => p.id === b.product_id);
      if (!product) return json(404, { error: 'Product not found', code: 'PRODUCT_NOT_FOUND' });
      const multiplier = b.unit === 'quintal' ? 100 : 1;
      const order = {
        id: nextId('order'),
        product_id: product.id,
        buyer_id: callerId,
        farmer_id: product.farmer_id,
        quantity: b.quantity,
        unit: b.unit,
        unit_at_order: b.unit,
        price_at_order: product.user_price,
        total_price: product.user_price * b.quantity * multiplier,
        delivery_address: b.delivery_address,
        buyer_phone: b.buyer_phone,
        status: 'PENDING',
        created_at: new Date().toISOString(),
      };
      store.orders.push(order);
      return json(201, { order });
    }

    // Escrow lifecycle.
    if (path.startsWith('/escrow/')) {
      const b = body();
      const order = store.orders.find((o) => o.id === (b.order_id || b.orderId));
      if (path === '/escrow/update-status') {
        if (!order) return json(404, { error: 'Order not found', code: 'ORDER_NOT_FOUND' });
        order.status = b.newStatus;
        if (b.newStatus === 'CONFIRMED') productDecrement(store, order);
        return json(200, { success: true, order });
      }
      if (path === '/escrow/create-order') {
        if (!order) return json(404, { error: 'Order not found', code: 'ORDER_NOT_FOUND' });
        if (order.status === 'PAID') return json(200, { alreadyPaid: true });
        // Real contract (escrowService.createRazorpayOrder): the response
        // carries order_id — EscrowCheckout's verify step sends it back.
        return json(200, { order_id: order.id, razorpay_order_id: `order_mock_${order.id}`, amount: orderTotal(order) * 100, currency: 'INR' });
      }
      if (path === '/escrow/verify-payment') {
        if (!order) return json(404, { error: 'Order not found', code: 'ORDER_NOT_FOUND' });
        order.status = 'PAID';
        store.payments.push({ id: nextId('payment'), order_id: order.id, status: 'HELD' });
        return json(200, { success: true, order });
      }
      if (path === '/escrow/ship-order') {
        if (!order) return json(404, { error: 'Order not found', code: 'ORDER_NOT_FOUND' });
        order.status = 'SHIPPED';
        return json(200, { success: true, order });
      }
      if (path === '/escrow/confirm-delivery') {
        if (!order) return json(404, { error: 'Order not found', code: 'ORDER_NOT_FOUND' });
        order.status = 'COMPLETED';
        const payment = store.payments.find((p) => p.order_id === order.id);
        if (payment) payment.status = 'RELEASED';
        return json(200, { success: true, order });
      }
      return json(404, { error: `mock: unhandled escrow route ${path}` });
    }

    // Image upload (POST /api/uploads/image?kind=...).
    if (path === '/uploads/image') {
      return json(200, { publicUrl: 'https://mock.supabase.co/storage/v1/object/public/product-images/mock.jpg' });
    }

    // Farmer's own crop passports (dashboard loads them on mount).
    if (path === '/passports/mine' && req.method() === 'GET') {
      return json(200, { lots: [], stats: null });
    }

    // Notifications bell (inbox badge) — empty inbox in the mock.
    if (path === '/notifications' && req.method() === 'GET') {
      return json(200, { notifications: [], unread_count: 0 });
    }

    // Transporters list for the ship modal — empty in the mock; the
    // self-delivery path ("Ship Without Transporter") is what the spec uses.
    if (path === '/transporters' && req.method() === 'GET') {
      return json(200, { transporters: [] });
    }

    // Disputes.
    if (path === '/disputes' || path === '/disputes/') {
      if (req.method() === 'POST') {
        const b = body();
        const order = store.orders.find((o) => o.id === b.order_id);
        if (!order) return json(404, { error: 'Order not found', code: 'ORDER_NOT_FOUND' });
        const dispute = {
          id: nextId('dispute'), order_id: order.id, buyer_id: order.buyer_id,
          farmer_id: order.farmer_id, category: b.category, status: 'filed',
          created_at: new Date().toISOString(),
        };
        store.disputes.push(dispute);
        store.disputeMessages.push({
          id: nextId('msg'), dispute_id: dispute.id, author_id: callerId,
          author_role: caller?.role || 'buyer', body: b.description, created_at: new Date().toISOString(),
        });
        return json(201, { dispute });
      }
      const visible = caller?.role === 'admin'
        ? store.disputes
        : store.disputes.filter((d) => d.buyer_id === callerId || d.farmer_id === callerId);
      return json(200, { disputes: visible });
    }
    if (path === '/disputes/stats') {
      const resolved = store.disputes.filter((d) => d.status === 'resolved').length;
      return json(200, {
        total: store.disputes.length, resolved,
        resolution_rate: store.disputes.length ? resolved / store.disputes.length : null,
        avg_resolution_hours: null,
      });
    }
    const disputeMatch = path.match(/^\/disputes\/([^/]+)(\/.*)?$/);
    if (disputeMatch) {
      const dispute = store.disputes.find((d) => d.id === disputeMatch[1]);
      if (!dispute) return json(404, { error: 'Dispute not found', code: 'DISPUTE_NOT_FOUND' });
      const sub = disputeMatch[2] || '';
      if (sub === '' && req.method() === 'GET') {
        return json(200, {
          dispute: { ...dispute, description: store.disputeMessages.find((m) => m.dispute_id === dispute.id)?.body || '' },
          evidence: [],
          messages: store.disputeMessages.filter((m) => m.dispute_id === dispute.id),
          shipment: null,
        });
      }
      if (sub === '/message' && req.method() === 'POST') {
        const b = body();
        const msg = { id: nextId('msg'), dispute_id: dispute.id, author_id: callerId, author_role: caller?.role || 'buyer', body: b.body, created_at: new Date().toISOString() };
        store.disputeMessages.push(msg);
        return json(201, { message: msg });
      }
      return json(404, { error: `mock: unhandled dispute route ${path}` });
    }
    if (path.startsWith('/admin/disputes/')) {
      const m = path.match(/^\/admin\/disputes\/([^/]+)\/(status|resolve)$/);
      if (!m) return json(404, { error: `mock: unhandled admin dispute route ${path}` });
      const dispute = store.disputes.find((d) => d.id === m[1]);
      if (!dispute) return json(404, { error: 'Dispute not found', code: 'DISPUTE_NOT_FOUND' });
      const b = body();
      if (m[2] === 'resolve') {
        if (dispute.status === 'resolved') return json(409, { error: 'Dispute already resolved', code: 'ALREADY_RESOLVED' });
        dispute.status = 'resolved';
        // Real contract (disputeService.resolveDispute): resolution is the
        // outcome STRING, with note/amount as separate flat fields — the
        // detail page renders {dispute.resolution} as a React child, so
        // an object here crashes the page.
        dispute.resolution = b.outcome;
        dispute.resolution_note = b.note || null;
        dispute.resolution_amount_paise = b.amount_paise ?? null;
        if (b.outcome === 'refund') {
          const order = store.orders.find((o) => o.id === dispute.order_id);
          if (order) order.status = 'REFUNDED';
        }
        return json(200, { dispute });
      }
      dispute.status = b.status;
      return json(200, { dispute });
    }

    // Group buys.
    if (path === '/group-buys' || path === '/group-buys/') {
      if (req.method() === 'POST') {
        const b = body();
        const group = {
          id: nextId('group'), owner_id: callerId, crop: b.crop,
          threshold_quantity: b.threshold_quantity, unit: b.unit || 'kg',
          deadline: b.deadline, status: 'open', total_quantity: 0,
          created_at: new Date().toISOString(),
        };
        store.groupBuys.push(group);
        return json(201, { group_buy: group });
      }
      return json(200, { group_buys: store.groupBuys });
    }
    const groupMatch = path.match(/^\/group-buys\/([^/]+)(\/.*)?$/);
    if (groupMatch) {
      const group = store.groupBuys.find((g) => g.id === groupMatch[1]);
      if (!group) return json(404, { error: 'Group buy not found', code: 'GROUP_BUY_NOT_FOUND' });
      const sub = groupMatch[2] || '';
      const participants = store.groupParticipants.filter((p) => p.group_buy_id === group.id);
      if (sub === '' && req.method() === 'GET') {
        return json(200, { group_buy: group, participants });
      }
      if (sub === '/join' && req.method() === 'POST') {
        const b = body();
        const existing = participants.find((p) => p.user_id === callerId);
        if (existing) return json(409, { error: 'Already joined', code: 'ALREADY_JOINED' });
        const participant = {
          id: nextId('participant'), group_buy_id: group.id, user_id: callerId,
          contribution_quantity: b.contribution_quantity, share: null,
        };
        store.groupParticipants.push(participant);
        group.total_quantity = participants.reduce((s, p) => s + Number(p.contribution_quantity), 0) + Number(b.contribution_quantity);
        return json(201, { participant });
      }
      if (sub === '/close' && req.method() === 'POST') {
        const b = body();
        const product = store.products.find((p) => p.id === b.product_id);
        if (!product) return json(404, { error: 'Product not found', code: 'PRODUCT_NOT_FOUND' });
        const totalQty = group.total_quantity;
        const unitPrice = b.unit_price ?? product.user_price;
        const totalPaise = Math.round(unitPrice * totalQty * 100);
        const order = {
          id: nextId('order'), product_id: product.id, buyer_id: callerId,
          farmer_id: product.farmer_id, quantity: totalQty, unit: group.unit,
          unit_at_order: group.unit, price_at_order: unitPrice, total_price: unitPrice * totalQty,
          delivery_address: b.delivery_address, buyer_phone: b.buyer_phone,
          status: 'PENDING', created_at: new Date().toISOString(),
        };
        store.orders.push(order);
        group.status = 'closed';
        group.order_id = order.id;
        group.requirement_id = null;
        // Largest-remainder split of the pooled total across participants.
        const all = store.groupParticipants.filter((p) => p.group_buy_id === group.id);
        const exact = all.map((p) => ({ p, amount: (totalPaise * Number(p.contribution_quantity)) / totalQty }));
        let assigned = 0;
        const rows = exact.map(({ p, amount }) => {
          const base = Math.floor(amount);
          assigned += base;
          return { p, amount: base, frac: amount - base };
        });
        let remainder = totalPaise - assigned;
        rows.sort((a, b2) => b2.frac - a.frac);
        for (const r of rows) { if (remainder <= 0) break; r.amount += 1; remainder -= 1; }
        rows.forEach(({ p, amount }) => {
          p.share = Number(p.contribution_quantity) / totalQty;
          store.settlements.push({ id: nextId('settlement'), group_buy_id: group.id, participant_id: p.id, user_id: p.user_id, contribution_quantity: p.contribution_quantity, share: p.share, amount_paise: amount, status: 'pending' });
        });
        return json(200, { group_buy: group, order });
      }
      if (sub === '/settlement' && req.method() === 'GET') {
        const settlements = store.settlements.filter((s) => s.group_buy_id === group.id);
        if (!settlements.length) return json(404, { error: 'No settlement yet', code: 'SETTLEMENT_NOT_FOUND' });
        const totalPaise = settlements.reduce((s, r) => s + r.amount_paise, 0);
        // Top-level shape: the detail page does setSettlement(data) and
        // reads settlement.settlements / settlement.total_paise.
        return json(200, { group_buy_id: group.id, settlements, total_paise: totalPaise });
      }
      return json(404, { error: `mock: unhandled group route ${path}` });
    }

    // Anything else the UI calls that the mock does not model yet: fail
    // loudly in the test output instead of silently returning empty data.
    return json(404, { error: `mock: unhandled api route ${req.method()} ${path}` });
  });
}

function productDecrement(store, order) {
  const product = store.products.find((p) => p.id === order.product_id);
  if (!product) return;
  const multiplier = order.unit === 'quintal' ? 100 : 1;
  product.quantity = Math.max(0, Number(product.quantity) - Number(order.quantity) * multiplier);
}

// Sign up through the real signup form (role: 'farmer' | 'buyer' |
// 'admin') and wait for the dashboard landing. The mocked signup returns
// a session, so SignUp.jsx navigates to /<role>-dashboard directly.
export async function signupAs(page, { firstName, lastName, email, phone, password, role }) {
  await page.goto(`/signup?role=${role}`);
  // Role toggle buttons: "🛒 I'm a Buyer" / "👨‍🌾 I'm a Farmer".
  await page.getByRole('button', { name: role === 'farmer' ? /I'm a Farmer/ : /I'm a Buyer/ }).click();
  await page.getByPlaceholder('First Name').fill(firstName);
  await page.getByPlaceholder('Last Name').fill(lastName);
  await page.getByPlaceholder('name@example.com').fill(email);
  await page.getByPlaceholder('10-digit mobile number').fill(phone);
  await page.getByPlaceholder('Create a strong password (min 6 chars)').fill(password);
  if (role === 'farmer') {
    // Farm Location (UP District) is a required select for farmers.
    await page.locator('select').first().selectOption({ index: 1 });
  }
  // The submit stays disabled until the terms checkbox is ticked.
  await page.locator('input[type="checkbox"]').check();
  await page.getByRole('button', { name: role === 'farmer' ? 'Create Farmer Account' : 'Create Buyer Account' }).click();
  await page.waitForURL(new RegExp(`/${role}-dashboard`), { timeout: 15000 });
}

// Seed an admin user straight into the mock store: the app has no admin
// signup or admin login toggle (Login.jsx only offers buyer/farmer), so
// the admin session is seeded the way the first-admin bootstrap does it
// in production — a profiles row with role 'admin'.
export function seedAdmin(store, email = 'admin@mock.local') {
  const user = {
    id: nextId('user'), email, role: 'admin',
    first_name: 'Admin', last_name: 'User', phone_number: '9999999999', state: null,
  };
  store.users.set(email, user);
  store.profiles.push({ ...user, created_at: new Date().toISOString() });
  return user;
}

// Seed a signed-in session for an already-stored user by writing the
// Supabase storage key before the app loads (gotrue-js reads it in
// getSession on mount). Used for the admin, who has no login form.
export async function seedSession(page, store, email) {
  const user = store.users.get(email);
  if (!user) throw new Error(`mock: no user ${email} in store`);
  const session = sessionFor(store, user);
  await page.addInitScript((s) => {
    localStorage.setItem('sb-mock-auth-token', JSON.stringify(s));
  }, session);
}

// The farmer dashboard opens a "Geotag Your Farm" / "Pin Your Farm"
// modal on first load when the profile has no lat/lng (the mock profile
// has none). Two overlays render stacked; "Dismiss" (second modal) both
// closes and records the dismissal in sessionStorage, so once per
// context. Waits briefly because the modal appears after the async
// profile load — a plain count() check races it.
export async function dismissFarmerLocationModal(page) {
  const dismiss = page.getByRole('button', { name: 'Dismiss', exact: true });
  const later = page.getByRole('button', { name: "I'll tag it later" });
  try {
    await Promise.race([
      dismiss.waitFor({ timeout: 8000 }),
      later.waitFor({ timeout: 8000 }),
    ]);
  } catch {
    return; // modal never appeared (profile already geotagged)
  }
  if (await dismiss.count()) await dismiss.click();
  else if (await later.count()) await later.click();
}

// Buyer-side twin of the farmer location modal ("Set your location",
// "Dismiss (Show All)" button). Same first-load-only behaviour, keyed
// on sessionStorage 'locationDismissed'.
export async function dismissBuyerLocationModal(page) {
  const dismiss = page.getByRole('button', { name: 'Dismiss (Show All)' });
  try {
    await dismiss.waitFor({ timeout: 8000 });
  } catch {
    return; // modal never appeared
  }
  await dismiss.click();
}

export const test = base;
