// Offline order snapshot (Stage 11, Unit B). The buyer dashboard writes the
// last-synced order list here on every successful orders fetch; the
// OfflineOrderStatus component reads it back when the network is gone.
// Only the fields the offline view renders are stored — never tokens,
// addresses, or farmer contact details.
export const OFFLINE_ORDERS_KEY = 'fm-offline-orders';

export function saveOfflineOrders(orders) {
  try {
    const snapshot = {
      syncedAt: new Date().toISOString(),
      orders: (orders || []).map((o) => ({
        id: o.id,
        status: o.status,
        total_price: o.total_price,
        created_at: o.created_at,
        productName: o.product?.name || null,
      })),
    };
    localStorage.setItem(OFFLINE_ORDERS_KEY, JSON.stringify(snapshot));
  } catch {
    // Storage full or unavailable (private mode) — offline status is a
    // convenience, never a reason to break the orders fetch.
  }
}

export function readOfflineOrders() {
  try {
    const raw = localStorage.getItem(OFFLINE_ORDERS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.orders)) return null;
    return parsed;
  } catch {
    return null;
  }
}
