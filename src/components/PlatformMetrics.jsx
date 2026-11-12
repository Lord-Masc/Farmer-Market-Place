import React from 'react';

// Platform metrics (Stage 10, module I), shared by the admin Metrics
// page and the public Transparency page — the same aggregated fields,
// rendered the same way on both. Every value is a real number or null
// (null = no data); nulls render as "No data yet", never an invented 0.
// Amounts arrive in paise and render as rupees. Rates arrive as
// fractions and render as % (a value already > 1 is read as a percent).
// mandi_modal_paise is null until Stage 3 FairPrice lands — the
// comparison row says so explicitly instead of showing a price.
const formatRupees = (paise) =>
  paise == null ? 'No data yet' : `₹${(Number(paise) / 100).toFixed(2)}`;

const formatCount = (value) => (value == null ? 'No data yet' : `${value}`);

const formatRate = (value) =>
  value == null ? 'No data yet' : `${Math.round(value > 1 ? value : value * 100)}%`;

const formatHours = (value) =>
  value == null ? 'No data yet' : `${Math.round(value)}h`;

const PlatformMetrics = ({ metrics }) => {
  if (!metrics) {
    return <p className="font-bold text-gray-500">No metrics yet.</p>;
  }

  const group = metrics.group_selling || null;
  const delivery = metrics.notification_delivery || null;

  return (
    <div>
      {/* Key metric cards */}
      <section className="grid grid-cols-2 sm:grid-cols-4 gap-6 mb-10">
        <div className="bg-white rounded-[24px] p-6 shadow-sm">
          <p className="text-xs text-gray-600 font-bold uppercase tracking-wider mb-1">Total orders</p>
          <p className="text-2xl font-black text-green-deep">{formatCount(metrics.total_orders)}</p>
        </div>
        <div className="bg-white rounded-[24px] p-6 shadow-sm">
          <p className="text-xs text-gray-600 font-bold uppercase tracking-wider mb-1">GMV</p>
          <p className="text-2xl font-black text-green-deep">{formatRupees(metrics.gmv_paise)}</p>
        </div>
        <div className="bg-white rounded-[24px] p-6 shadow-sm">
          <p className="text-xs text-gray-600 font-bold uppercase tracking-wider mb-1">Median farmer realisation</p>
          <p className="text-2xl font-black text-green-deep">{formatRupees(metrics.median_realisation_paise)}</p>
        </div>
        <div className="bg-white rounded-[24px] p-6 shadow-sm">
          <p className="text-xs text-gray-600 font-bold uppercase tracking-wider mb-1">Dispute rate</p>
          <p className="text-2xl font-black text-green-deep">{formatRate(metrics.dispute_rate)}</p>
        </div>
        <div className="bg-white rounded-[24px] p-6 shadow-sm">
          <p className="text-xs text-gray-600 font-bold uppercase tracking-wider mb-1">Disputes</p>
          <p className="text-2xl font-black text-green-deep">{formatCount(metrics.dispute_count)}</p>
        </div>
        <div className="bg-white rounded-[24px] p-6 shadow-sm">
          <p className="text-xs text-gray-600 font-bold uppercase tracking-wider mb-1">Avg. resolution time</p>
          <p className="text-2xl font-black text-green-deep">{formatHours(metrics.avg_resolution_hours)}</p>
        </div>
        <div className="bg-white rounded-[24px] p-6 shadow-sm">
          <p className="text-xs text-gray-600 font-bold uppercase tracking-wider mb-1">On-time delivery rate</p>
          <p className="text-2xl font-black text-green-deep">{formatRate(metrics.on_time_rate)}</p>
        </div>
        <div className="bg-white rounded-[24px] p-6 shadow-sm">
          <p className="text-xs text-gray-600 font-bold uppercase tracking-wider mb-1">Mandi modal price</p>
          <p className="text-2xl font-black text-green-deep">{formatRupees(metrics.mandi_modal_paise)}</p>
        </div>
      </section>

      {/* Realisation vs mandi comparison */}
      <section className="bg-white rounded-[24px] p-6 shadow-sm mb-10">
        <h2 className="font-playfair text-xl font-bold text-green-deep mb-4">Farmer realisation vs mandi price</h2>
        {metrics.mandi_modal_paise == null ? (
          <p className="font-bold text-gray-500">No mandi data yet — FairPrice (Stage 3) is not live.</p>
        ) : (
          <p className="font-bold text-green-deep">
            Median realisation {formatRupees(metrics.median_realisation_paise)}
            {' vs '}mandi modal {formatRupees(metrics.mandi_modal_paise)}
          </p>
        )}
        {metrics.median_realisation_paise == null && metrics.mandi_modal_paise != null && (
          <p className="font-bold text-gray-500 mt-2">No realisation data yet.</p>
        )}
      </section>

      {/* Group selling */}
      <section className="bg-white rounded-[24px] p-6 shadow-sm mb-10">
        <h2 className="font-playfair text-xl font-bold text-green-deep mb-4">Group selling</h2>
        {!group ? (
          <p className="font-bold text-gray-500">No data yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="text-[10px] font-black uppercase text-gray-600 tracking-widest">
                  <th className="py-3 pr-4">Groups total</th>
                  <th className="py-3 pr-4">Groups closed</th>
                  <th className="py-3 pr-4">Pooled quantity</th>
                  <th className="py-3 pr-4">Pooled GMV</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-t border-cream-dark font-bold text-green-deep">
                  <td className="py-3 pr-4">{formatCount(group.groups_total)}</td>
                  <td className="py-3 pr-4">{formatCount(group.groups_closed)}</td>
                  <td className="py-3 pr-4">{formatCount(group.pooled_quantity)}</td>
                  <td className="py-3 pr-4">{formatRupees(group.pooled_gmv_paise)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Notification delivery */}
      <section className="bg-white rounded-[24px] p-6 shadow-sm">
        <h2 className="font-playfair text-xl font-bold text-green-deep mb-4">Notification delivery</h2>
        {!delivery ? (
          <p className="font-bold text-gray-500">No data yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="text-[10px] font-black uppercase text-gray-600 tracking-widest">
                  <th className="py-3 pr-4">Sent</th>
                  <th className="py-3 pr-4">Failed</th>
                  <th className="py-3 pr-4">Deferred</th>
                  <th className="py-3 pr-4">Pending</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-t border-cream-dark font-bold text-green-deep">
                  <td className="py-3 pr-4">{formatCount(delivery.sent)}</td>
                  <td className="py-3 pr-4">{formatCount(delivery.failed)}</td>
                  <td className="py-3 pr-4">{formatCount(delivery.deferred)}</td>
                  <td className="py-3 pr-4">{formatCount(delivery.pending)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
};

export default PlatformMetrics;
