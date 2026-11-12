import React, { useEffect, useState } from 'react';
import { readOfflineOrders } from '../services/offlineOrders';

// Offline order status (Stage 11, Unit B). Reads the last-synced order
// list from localStorage — written by BuyerDashboard on every successful
// orders fetch. Shows real statuses only: when nothing was ever synced,
// the empty state says so honestly and no orders are invented.
const OfflineOrderStatus = () => {
  const [online, setOnline] = useState(() => (typeof navigator !== 'undefined' ? navigator.onLine : true));
  const [snapshot, setSnapshot] = useState(() => readOfflineOrders());

  useEffect(() => {
    const refresh = () => {
      setOnline(navigator.onLine);
      setSnapshot(readOfflineOrders());
    };
    window.addEventListener('online', refresh);
    window.addEventListener('offline', refresh);
    return () => {
      window.removeEventListener('online', refresh);
      window.removeEventListener('offline', refresh);
    };
  }, []);

  return (
    <section aria-label="Offline order status" className="bg-white rounded-[32px] p-8 shadow-sm border border-cream-dark">
      <h2 className="font-playfair text-xl font-bold text-green-deep mb-2">Your orders — offline</h2>
      {!online && (
        <p role="status" className="text-sm font-bold text-amber mb-4">
          You are offline — showing your last synced orders.
        </p>
      )}
      {!snapshot ? (
        <p className="text-sm text-gray-600">No orders synced yet — connect once to see your orders offline.</p>
      ) : (
        <>
          <p className="text-sm text-gray-600 mb-4">
            Last updated {new Date(snapshot.syncedAt).toLocaleString()}
          </p>
          {snapshot.orders.length === 0 ? (
            <p className="text-sm text-gray-600">No orders synced yet — connect once to see your orders offline.</p>
          ) : (
            <ul className="space-y-3">
              {snapshot.orders.map((order) => (
                <li key={order.id} className="flex items-center justify-between p-4 bg-cream/10 rounded-2xl border border-cream-dark/50">
                  <div>
                    <p className="text-sm font-bold text-green-deep">
                      {order.productName ? `Ordered ${order.productName}` : 'Order'}
                    </p>
                    <p className="text-xs text-gray-600">
                      {order.created_at ? new Date(order.created_at).toLocaleDateString() : ''}
                      {typeof order.total_price === 'number' ? ` · ₹${order.total_price}` : ''}
                    </p>
                  </div>
                  <span className="px-3 py-1 rounded-full text-xs font-black uppercase bg-green-fresh/20 text-green-deep">
                    {order.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
};

export default OfflineOrderStatus;
