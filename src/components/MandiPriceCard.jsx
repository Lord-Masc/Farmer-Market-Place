import React, { useEffect, useState } from 'react';
import { fairPriceFetch } from '../services/escrowApi';

// Mandi price card (Stage 3, module B) — the public mandi price for one
// commodity, with source + data date + freshness on EVERY render.
// A commodity with no data renders "no data reported today" — never a
// stale or other-mandi number. compact renders a single line for the
// product grid (Product.jsx); the full card is for the dashboard.
const inr = (n) => `₹${Number(n).toLocaleString('en-IN')}`;

function MandiPriceCard({ commodity, state, mandi, compact = false }) {
  // The fetched payload is stored with the request key it belongs to:
  // while a new commodity loads, data is null (loading) — the previous
  // crop's price is never shown for the new one.
  const key = `${commodity}|${state || ''}|${mandi || ''}`;
  const [result, setResult] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fairPriceFetch(commodity, { state, mandi })
      .then((data) => { if (!cancelled) setResult({ key, data }); })
      .catch((err) => { if (!cancelled) setResult({ key, error: err.message || 'Mandi price unavailable right now.' }); });
    return () => { cancelled = true; };
  }, [commodity, state, mandi, key]);

  const data = result?.key === key ? result.data : null;
  const error = result?.key === key ? result.error || '' : '';

  if (compact) {
    if (!data) return null; // loading / error: no line, no invented number
    if (data.no_data) {
      return <p className="text-xs text-gray-500 mt-2">Mandi: no data reported today</p>;
    }
    const primary = data.primary || {};
    return (
      <p className="text-xs text-gray-500 mt-2">
        Mandi {inr(primary.modal_price)}/qtl · {primary.mandi || '—'}
        {data.date ? ` · ${data.date}` : ''}
      </p>
    );
  }

  return (
    <div className="bg-cream/40 rounded-2xl p-5 border border-cream-dark">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-playfair text-lg font-bold text-green-deep">{commodity}</h3>
        {data?.freshness && (
          <span className={`px-2 py-1 rounded-full text-[10px] font-black uppercase ${data.freshness.isStale ? 'bg-amber/20 text-amber' : 'bg-green-fresh/15 text-green-mid'}`}>
            {data.freshness.label}
          </span>
        )}
      </div>

      {!data && !error && <p className="text-sm text-gray-500 italic">Loading mandi price…</p>}
      {error && <p className="text-sm text-gray-500">{error}</p>}
      {data?.no_data && (
        <>
          <p className="text-sm font-bold text-green-deep">no data reported today</p>
          <p className="text-[11px] text-gray-500 mt-2">Source: Agmarknet / data.gov.in</p>
        </>
      )}
      {data && !data.no_data && (
        <>
          <p className="text-2xl font-black text-green-deep">
            {inr(data.primary.modal_price)}
            <span className="text-xs font-medium text-gray-600"> /quintal</span>
          </p>
          <p className="text-xs text-gray-600 mt-1">
            Min {inr(data.primary.min_price)} · Max {inr(data.primary.max_price)}
            {data.primary.mandi ? ` · ${data.primary.mandi}` : ''}
          </p>
          {data.change_pct_vs_yesterday !== null && data.change_pct_vs_yesterday !== undefined && (
            <p className="text-xs font-bold mt-2 text-green-mid">
              {data.change_pct_vs_yesterday >= 0 ? '▲' : '▼'} {Math.abs(data.change_pct_vs_yesterday)}% vs yesterday
              {data.avg7_modal !== null && data.avg7_modal !== undefined && (
                <span className="text-gray-600 font-medium"> · 7-day avg {inr(data.avg7_modal)}</span>
              )}
            </p>
          )}
          {Array.isArray(data.nearby) && data.nearby.length > 0 && (
            <p className="text-[11px] text-gray-500 mt-2">
              Nearby: {data.nearby.slice(0, 3).map((n) => `${n.mandi} ${inr(n.modal_price)}`).join(' · ')}
            </p>
          )}
          <p className="text-[11px] text-gray-500 mt-3">
            Source: Agmarknet / data.gov.in{data.date ? ` · ${data.date}` : ''}
          </p>
        </>
      )}
    </div>
  );
}

export default MandiPriceCard;
