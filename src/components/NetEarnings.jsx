import React, { useEffect, useState } from 'react';
import { fairPriceNetEarningsFetch } from '../services/escrowApi';

// Net-earnings card (Stage 3, module B) — mandi modal minus the
// itemised platform estimates, computed server-side (one maths
// implementation, pinned in fairPriceService.test.js). The result is
// labelled "estimated" and the assumptions are shown, because the
// transport / commission / packaging / wastage numbers are platform
// estimates — there is NO official dataset for them, never presented
// as fact. No mandi price or no cost params yet = an honest empty
// state, never a number.
const inr = (n) => `₹${Number(n).toLocaleString('en-IN')}`;

function NetEarnings({ commodity, quantity, unit = 'quintal', state, mandi }) {
  // Same keyed-result pattern as MandiPriceCard: while a new quantity
  // loads, the previous estimate is never shown for the new one.
  const key = `${commodity}|${quantity}|${unit}|${state || ''}|${mandi || ''}`;
  const [result, setResult] = useState(null);

  useEffect(() => {
    let cancelled = false;
    if (!quantity || Number(quantity) <= 0) return undefined;
    fairPriceNetEarningsFetch(commodity, { quantity, unit, state, mandi })
      .then((data) => { if (!cancelled) setResult({ key, data }); })
      .catch((err) => { if (!cancelled) setResult({ key, error: err.message || 'Net earnings unavailable right now.' }); });
    return () => { cancelled = true; };
  }, [commodity, quantity, unit, state, mandi, key]);

  const data = result?.key === key ? result.data : null;
  const error = result?.key === key ? result.error || '' : '';

  if (!quantity || Number(quantity) <= 0) return null;

  const qtyLabel = `${quantity} ${unit === 'kg' ? 'kg' : 'quintals'}`;

  return (
    <div className="bg-cream/40 rounded-2xl p-5 border border-cream-dark">
      <h3 className="font-playfair text-lg font-bold text-green-deep mb-1">
        Estimated net earnings — {commodity} ({qtyLabel})
      </h3>
      <p className="text-[11px] text-gray-500 mb-4">
        Estimated — transport, commission, packaging and wastage are platform estimates, not official rates.
      </p>

      {!data && !error && <p className="text-sm text-gray-500 italic">Calculating…</p>}
      {error && <p className="text-sm text-gray-500">{error}</p>}
      {data?.no_data && (
        <p className="text-sm font-bold text-green-deep">No mandi price reported today — net earnings can&apos;t be estimated.</p>
      )}
      {data?.no_params && (
        <p className="text-sm font-bold text-green-deep">
          Mandi modal {inr(data.modal_price)}/quintal{data.date ? ` · ${data.date}` : ''} — but the cost
          parameters aren&apos;t set yet, so no estimate. An admin sets them first.
        </p>
      )}
      {data?.earnings && (
        <>
          <p className="text-2xl font-black text-green-deep">
            {inr(data.earnings.net)}
            <span className="text-xs font-medium text-gray-600"> net · {inr(data.earnings.netPerQuintal)}/quintal</span>
          </p>
          <dl className="text-xs text-gray-600 mt-3 space-y-1">
            <div className="flex justify-between"><dt>Gross ({inr(data.modal_price)}/qtl × {data.earnings.saleableQty} qtl saleable)</dt><dd className="font-bold text-green-deep">{inr(data.earnings.gross)}</dd></div>
            <div className="flex justify-between"><dt>Transport</dt><dd>− {inr(data.earnings.transport)}</dd></div>
            <div className="flex justify-between"><dt>Commission ({data.earnings.assumptions.commission_pct}%)</dt><dd>− {inr(data.earnings.commission)}</dd></div>
            <div className="flex justify-between"><dt>Packaging</dt><dd>− {inr(data.earnings.packaging)}</dd></div>
            <div className="flex justify-between"><dt>Platform fee</dt><dd>− {inr(data.earnings.platformFee)}</dd></div>
            <div className="flex justify-between"><dt>Wastage ({data.earnings.assumptions.wastage_pct}% · {data.earnings.wastageQty} qtl)</dt><dd>—</dd></div>
          </dl>
          <p className="text-[11px] text-gray-500 mt-3">
            Source: Agmarknet / data.gov.in{data.date ? ` · ${data.date}` : ''} · cost params v{data.earnings.assumptions.params_version ?? '—'}
          </p>
        </>
      )}
    </div>
  );
}

export default NetEarnings;
