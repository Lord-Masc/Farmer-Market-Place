import React from 'react';

// One offer in a negotiation thread: price, quantity, quantity tiers if
// present, expiry and status. Every number comes from the API response.
// Tiers are rendered defensively — only fields the backend sent are shown.
const STATUS_LABELS = {
  open: 'Open',
  countered: 'Countered',
  accepted: 'Accepted',
  rejected: 'Rejected',
  expired: 'Expired',
};

const pick = (obj, snake, camel) => obj?.[snake] ?? obj?.[camel];

const OfferCard = ({ offer, canCounter, canAccept, onCounter, onAccept, busy }) => {
  const expiresAt = pick(offer, 'expires_at', 'expiresAt');
  const expired = expiresAt ? new Date(expiresAt) < new Date() : false;
  // An open offer past its expiry is expired even if the backend has not
  // flipped the stored status yet.
  const status = offer.status === 'open' && expired ? 'expired' : (offer.status || 'open');
  // Backend stores tiers as price_tiers ([{min_quantity, price}]).
  const tiers = Array.isArray(offer.price_tiers) ? offer.price_tiers : (Array.isArray(offer.tiers) ? offer.tiers : []);
  const farmerId = pick(offer, 'farmer_id', 'farmerId');

  return (
    <div className="bg-white rounded-[24px] p-6 shadow-sm border border-cream-dark">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <p className="text-2xl font-black text-green-deep">₹{offer.price}</p>
          <p className="text-sm text-[#4a4a4a]">
            {offer.quantity} {offer.unit ? `${offer.unit}` : ''}
          </p>
        </div>
        <span className="px-3 py-1 rounded-full text-[10px] font-black uppercase bg-green-fresh/10 text-green-fresh">
          {STATUS_LABELS[status] || status}
        </span>
      </div>

      {tiers.length > 0 && (
        <div className="mb-3">
          <p className="text-xs text-gray-600 font-bold uppercase tracking-wider mb-1">Quantity tiers</p>
          <ul className="text-sm text-[#4a4a4a] space-y-1">
            {tiers.map((tier, i) => {
              const minQty = tier.min_quantity ?? tier.quantity ?? tier.from;
              const tierPrice = tier.price ?? tier.unit_price;
              return (
                <li key={i}>
                  {minQty != null ? `From ${minQty} — ` : ''}
                  {tierPrice != null ? `₹${tierPrice}` : ''}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <p className="text-sm text-gray-500 mb-4">
        {expiresAt
          ? expired
            ? `Expired on ${new Date(expiresAt).toLocaleString()}`
            : `Expires ${new Date(expiresAt).toLocaleString()}`
          : 'No expiry set.'}
      </p>

      {(canCounter || canAccept) && status === 'open' && (
        <div className="flex gap-3">
          {canCounter && (
            <button
              onClick={() => onCounter(offer)}
              disabled={busy}
              className="flex-1 bg-cream text-green-deep py-2 rounded-xl text-sm font-bold border border-cream-dark hover:bg-amber/10 disabled:opacity-50"
            >
              Counter
            </button>
          )}
          {canAccept && (
            <button
              onClick={() => onAccept(offer)}
              disabled={busy}
              className="flex-1 bg-green-deep text-white py-2 rounded-xl text-sm font-bold hover:bg-green-mid disabled:opacity-50"
            >
              Accept
            </button>
          )}
        </div>
      )}
      {farmerId && (
        <p className="text-[10px] text-gray-600 font-bold uppercase mt-3">Farmer ID: {String(farmerId).slice(0, 8)}</p>
      )}
    </div>
  );
};

export default OfferCard;
