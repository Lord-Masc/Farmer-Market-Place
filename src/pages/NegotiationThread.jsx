import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import Navbar from '../components/Navbar';
import Footer from '../components/Footer';
import OfferCard from '../components/OfferCard';
import CropPassportCard from '../components/CropPassportCard';
import { supabase } from '../services/supabase';
import { negotiationsFetch, offersFetch, publicPassportFetch, requirementsFetch } from '../services/escrowApi';

// One negotiation thread (Stage 4, module C): the requirement, its offers,
// counter/accept actions for the counterparty only, the agreement + linked
// order once accepted, and each quoting farmer's passport (Stage 2 card).
// A 404 passport (missing/unverified farmer) renders nothing — never a
// fake badge. The negotiation id is the requirement id.
const pick = (obj, snake, camel) => obj?.[snake] ?? obj?.[camel];

const NegotiationThread = () => {
  const { id } = useParams();
  const { user, profile, loading: authLoading } = useAuth();
  const navigate = useNavigate();

  const [thread, setThread] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [forbidden, setForbidden] = useState(false);
  const [passports, setPassports] = useState({});
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);

  // Quote form (farmer posts the first offer on the requirement).
  // A quote names the farmer's own listing (product_id) — acceptance
  // creates the real order from it, and orders.product_id is NOT NULL.
  const [quote, setQuote] = useState({ price: '', quantity: '', expiresAt: '', productId: '' });
  const [quoteTiers, setQuoteTiers] = useState([]);
  const [quoteError, setQuoteError] = useState('');
  const [ownProducts, setOwnProducts] = useState([]);
  const [productsLoading, setProductsLoading] = useState(false);
  // Counter form (the counterparty answers one open offer).
  const [countering, setCountering] = useState(null);
  const [counter, setCounter] = useState({ price: '', quantity: '', expiresAt: '' });
  const [counterTiers, setCounterTiers] = useState([]);
  // Accept form (buyer confirms delivery address, then accepts).
  const [accepting, setAccepting] = useState(null);
  const [acceptForm, setAcceptForm] = useState({ deliveryAddress: '', buyerPhone: '' });
  // One idempotency key per (offer, attempt), reused across retries so a
  // retried accept never creates a duplicate order (BuyerDashboard pattern).
  const acceptKeyRef = useRef(null);

  useEffect(() => {
    if (!user && !authLoading) navigate('/login');
  }, [user, authLoading, navigate]);

  const loadThread = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await negotiationsFetch(`/${id}`);
      setThread(data);
      // Fetch each quoting farmer's public passport; a 404 means
      // unverified/missing and is swallowed — no passport is rendered.
      const offers = data.offers || [];
      const farmerIds = [...new Set(offers.map((o) => pick(o, 'farmer_id', 'farmerId')).filter(Boolean))];
      const found = {};
      await Promise.all(farmerIds.map(async (farmerId) => {
        try {
          found[farmerId] = await publicPassportFetch(`/farmers/${farmerId}/passport`);
        } catch (err) {
          if (err.status !== 404) console.error('Passport load failed:', err);
        }
      }));
      setPassports(found);
    } catch (err) {
      if (err.status === 403) setForbidden(true);
      else if (err.status === 404) setError('This negotiation does not exist.');
      else setError(err.message || 'Could not load this negotiation.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (user) void loadThread();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, id]);

  // The farmer quotes on one of their own listings — same direct query
  // FarmerDashboard uses for the farmer's products.
  useEffect(() => {
    if (!user || profile?.role !== 'farmer') return;
    let cancelled = false;
    setProductsLoading(true);
    supabase.from('products').select('*').eq('farmer_id', user.id).order('created_at', { ascending: false })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) console.error('Own products load failed:', error);
        else setOwnProducts(data || []);
        setProductsLoading(false);
      });
    return () => { cancelled = true; };
  }, [user, profile?.role]);

  const requirement = thread?.requirement || {};
  const offers = thread?.offers || [];
  const agreement = thread?.agreement || null;
  const fairPriceAnchor = pick(thread, 'fair_price_anchor', 'fairPriceAnchor');
  const buyerId = pick(requirement, 'buyer_id', 'buyerId');
  const isBuyer = !!user && !!buyerId && user.id === buyerId;
  const isParticipant = isBuyer || offers.some((o) => pick(o, 'farmer_id', 'farmerId') === user?.id);

  // Who authored the latest version of an offer: the counterparty is the
  // other side. Tolerates the backend naming the author either way.
  const offerAuthorId = (offer) => offer.author_id ?? offer.created_by ?? pick(offer, 'farmer_id', 'farmerId') ?? pick(offer, 'buyer_id', 'buyerId') ?? null;
  const offerFarmerId = (offer) => pick(offer, 'farmer_id', 'farmerId');

  const isExpired = (offer) => {
    const expiresAt = pick(offer, 'expires_at', 'expiresAt');
    return expiresAt ? new Date(expiresAt) < new Date() : false;
  };
  const isOpen = (offer) => offer.status === 'open' && !isExpired(offer) && !agreement;

  const canCounter = (offer) => {
    if (!isOpen(offer)) return false;
    const authorId = offerAuthorId(offer);
    if (isBuyer) return authorId == null || authorId !== user.id;
    // A farmer counters only a buyer-authored counter on their own offer.
    if (user?.id && offerFarmerId(offer) === user.id) return authorId === buyerId;
    return false;
  };
  const canAccept = (offer) => {
    if (!isOpen(offer)) return false;
    if (!isBuyer) return false;
    const authorId = offerAuthorId(offer);
    return authorId == null || authorId !== user.id;
  };

  // Tiers the user typed: drop empty rows, send house-style snake_case.
  // Tier inner fields are { min_quantity, price } (backend validates them).
  const cleanTiers = (rows) => rows
    .filter((t) => t.min_quantity !== '' && t.price !== '')
    .map((t) => ({ min_quantity: parseFloat(t.min_quantity), price: parseFloat(t.price) }));

  const validateOfferForm = (form, tiers) => {
    const price = parseFloat(form.price);
    const quantity = parseFloat(form.quantity);
    if (!Number.isFinite(price) || price <= 0) return 'Enter a price greater than 0.';
    if (!Number.isFinite(quantity) || quantity <= 0) return 'Enter a quantity greater than 0.';
    if (!form.expiresAt) return 'Enter an expiry date and time.';
    if (new Date(form.expiresAt) <= new Date()) return 'The expiry must be in the future.';
    for (const tier of tiers) {
      if ((tier.min_quantity === '' || tier.price === '') && (tier.min_quantity !== '' || tier.price !== '')) {
        return 'Each tier needs both a minimum quantity and a price.';
      }
      if (tier.min_quantity !== '' && (!Number.isFinite(parseFloat(tier.min_quantity)) || parseFloat(tier.min_quantity) <= 0)) {
        return 'Tier quantities must be greater than 0.';
      }
      if (tier.price !== '' && (!Number.isFinite(parseFloat(tier.price)) || parseFloat(tier.price) <= 0)) {
        return 'Tier prices must be greater than 0.';
      }
    }
    return '';
  };

  const offerBody = (form, tiers) => ({
    price: parseFloat(form.price),
    quantity: parseFloat(form.quantity),
    ...(cleanTiers(tiers).length > 0 ? { price_tiers: cleanTiers(tiers) } : {}),
    expires_at: new Date(form.expiresAt).toISOString(),
  });

  const handleQuote = async (e) => {
    e.preventDefault();
    const err = validateOfferForm(quote, quoteTiers);
    if (err) { setQuoteError(err); return; }
    if (!quote.productId) { setQuoteError('Choose one of your listings to quote on.'); return; }
    setBusy(true);
    setQuoteError('');
    try {
      await requirementsFetch(`/${id}/offers`, {
        method: 'POST',
        body: { ...offerBody(quote, quoteTiers), product_id: quote.productId },
      });
      setQuote({ price: '', quantity: '', expiresAt: '', productId: '' });
      setQuoteTiers([]);
      await loadThread();
    } catch (err2) {
      setQuoteError(err2.message || 'Could not send the quote.');
    } finally {
      setBusy(false);
    }
  };

  const startCounter = (offer) => {
    setActionError('');
    setCountering(offer);
    setCounter({ price: String(offer.price ?? ''), quantity: String(offer.quantity ?? ''), expiresAt: '' });
    setCounterTiers([]);
  };

  const handleCounter = async (e) => {
    e.preventDefault();
    if (!countering) return;
    const err = validateOfferForm(counter, counterTiers);
    if (err) { setActionError(err); return; }
    setBusy(true);
    setActionError('');
    try {
      await offersFetch(`/${countering.id}/counter`, { method: 'POST', body: offerBody(counter, counterTiers) });
      setCountering(null);
      await loadThread();
    } catch (err2) {
      setActionError(err2.message || 'Could not send the counter-offer.');
    } finally {
      setBusy(false);
    }
  };

  // Accepting creates the order, so the backend needs a delivery
  // address (400 without one) — collect it before accepting.
  const startAccept = (offer) => {
    setActionError('');
    setAccepting(offer);
    setAcceptForm({ deliveryAddress: '', buyerPhone: '' });
  };

  const handleAccept = async (e) => {
    e.preventDefault();
    if (!accepting) return;
    if (!acceptForm.deliveryAddress.trim()) {
      setActionError('Enter a delivery address to accept the offer.');
      return;
    }
    if (!acceptKeyRef.current || acceptKeyRef.current.offerId !== accepting.id) {
      acceptKeyRef.current = { offerId: accepting.id, key: crypto.randomUUID() };
    }
    setBusy(true);
    setActionError('');
    try {
      const res = await offersFetch(`/${accepting.id}/accept`, {
        method: 'POST',
        body: {
          delivery_address: acceptForm.deliveryAddress.trim(),
          ...(acceptForm.buyerPhone.trim() ? { buyer_phone: acceptForm.buyerPhone.trim() } : {}),
        },
        headers: { 'Idempotency-Key': acceptKeyRef.current.key },
      });
      acceptKeyRef.current = null;
      setAccepting(null);
      if (res?.agreement || res?.order) setThread((prev) => ({ ...prev, agreement: res.agreement ?? prev?.agreement, order: res.order ?? prev?.order }));
      await loadThread();
    } catch (err) {
      setActionError(err.message || 'Could not accept the offer.');
    } finally {
      setBusy(false);
    }
  };

  const formatDate = (value) => (value ? new Date(value).toLocaleDateString() : '—');
  const order = thread?.order || agreement?.order || null;
  // The agreement freezes the locked price/quantity (locked_price,
  // locked_quantity) — never the listing price.
  const lockedPrice = pick(agreement, 'locked_price', 'lockedPrice') ?? agreement?.price;
  const lockedQuantity = pick(agreement, 'locked_quantity', 'lockedQuantity') ?? agreement?.quantity;
  const orderId = order?.id || pick(agreement, 'order_id', 'orderId');

  const tierEditor = (tiers, setTiers) => (
    <div>
      <p className="text-xs font-bold uppercase text-gray-400 mb-2">Quantity tiers (optional)</p>
      {tiers.map((tier, i) => (
        <div key={i} className="flex gap-3 mb-2">
          <input
            type="number" min="0.01" step="0.01" placeholder="Min quantity"
            className="flex-1 bg-cream rounded-xl p-3"
            value={tier.min_quantity}
            onChange={(e) => setTiers(tiers.map((t, j) => (j === i ? { ...t, min_quantity: e.target.value } : t)))}
          />
          <input
            type="number" min="0.01" step="0.01" placeholder="Price (₹)"
            className="flex-1 bg-cream rounded-xl p-3"
            value={tier.price}
            onChange={(e) => setTiers(tiers.map((t, j) => (j === i ? { ...t, price: e.target.value } : t)))}
          />
          <button type="button" onClick={() => setTiers(tiers.filter((_, j) => j !== i))} className="text-red-500 font-bold px-2">✕</button>
        </div>
      ))}
      <button type="button" onClick={() => setTiers([...tiers, { min_quantity: '', price: '' }])} className="text-sm font-bold text-green-mid hover:text-green-deep">
        + Add tier
      </button>
    </div>
  );

  const offerFormFields = (form, setForm, tiers, setTiers) => (
    <>
      <div>
        <label className="text-xs font-bold uppercase text-gray-400">Price (₹)</label>
        <input required type="number" min="0.01" step="0.01" className="w-full bg-cream rounded-xl p-4 mt-1" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} />
      </div>
      <div>
        <label className="text-xs font-bold uppercase text-gray-400">Quantity</label>
        <input required type="number" min="0.01" step="0.01" className="w-full bg-cream rounded-xl p-4 mt-1" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} />
      </div>
      <div className="md:col-span-2">
        <label className="text-xs font-bold uppercase text-gray-400">Expires at</label>
        <input required type="datetime-local" className="w-full bg-cream rounded-xl p-4 mt-1" value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} />
      </div>
      <div className="md:col-span-2">{tierEditor(tiers, setTiers)}</div>
    </>
  );

  return (
    <div className="min-h-screen font-dmsans bg-cream">
      <Navbar />
      <main className="pt-32 pb-20 px-[5%] max-w-[1400px] mx-auto">
        {loading ? (
          <p className="text-center py-20 text-gray-400 italic">Loading negotiation...</p>
        ) : forbidden ? (
          <p className="py-20 text-center text-gray-500 font-medium">You don&apos;t have access to this page.</p>
        ) : error ? (
          <p className="py-20 text-center text-red-600">{error}</p>
        ) : (
          <>
            <header className="mb-10">
              <Link to="/requirements" className="text-sm font-bold text-green-mid hover:text-green-deep">← All requirements</Link>
              <h1 className="font-playfair text-4xl font-black text-green-deep mt-2 mb-2">
                {requirement.crop || 'Negotiation'}
              </h1>
              <p className="text-[#4a4a4a] text-lg">
                {requirement.quantity} — {requirement.quality}
                {' · '}Target: ₹{pick(requirement, 'target_price', 'targetPrice')}
              </p>
              <p className="text-gray-500">
                Delivery: {formatDate(pick(requirement, 'delivery_window_start', 'deliveryWindowStart'))} – {formatDate(pick(requirement, 'delivery_window_end', 'deliveryWindowEnd'))}
                {requirement.status ? ` · ${requirement.status}` : ''}
              </p>
            </header>

            {/* FairPrice anchor slot (Stage 3 wires this to mandi_prices).
                Renders NOTHING while fairPriceAnchor is null — no price is
                ever invented here. When Stage 3 lands, render the anchor
                from fairPriceAnchor inside this block. */}
            {fairPriceAnchor != null && null}

            {agreement && (
              <section className="bg-green-deep text-white rounded-[24px] p-6 shadow-sm mb-10">
                <h2 className="font-playfair text-xl font-bold mb-2">Agreement locked 🤝</h2>
                <p className="text-sm opacity-90">
                  Price locked at ₹{lockedPrice}
                  {lockedQuantity != null ? ` for ${lockedQuantity}` : ''}
                  {pick(agreement, 'locked_at', 'lockedAt') ? ` on ${new Date(pick(agreement, 'locked_at', 'lockedAt')).toLocaleDateString()}` : ''}.
                </p>
                {orderId && (
                  <p className="text-sm mt-2">
                    Order created:{' '}
                    <Link to={`/checkout?orderId=${encodeURIComponent(orderId)}`} className="font-bold underline">View order →</Link>
                  </p>
                )}
              </section>
            )}

            {actionError && <p className="text-sm text-red-600 mb-6">{actionError}</p>}

            {!agreement && !isBuyer && profile?.role === 'farmer' && (
              <section className="bg-white rounded-[24px] p-6 shadow-sm mb-10">
                <h2 className="font-playfair text-xl font-bold text-green-deep mb-6">Quote on this requirement</h2>
                <form onSubmit={handleQuote} className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="md:col-span-2">
                    <label className="text-xs font-bold uppercase text-gray-400">Your listing</label>
                    <select required className="w-full bg-cream rounded-xl p-4 mt-1" value={quote.productId} onChange={(e) => setQuote({ ...quote, productId: e.target.value })}>
                      <option value="">Choose one of your listings…</option>
                      {ownProducts.map((p) => (
                        <option key={p.id} value={p.id}>{p.name || p.crop || 'Listing'} — ₹{p.user_price ?? p.price}</option>
                      ))}
                    </select>
                    {!productsLoading && ownProducts.length === 0 && (
                      <p className="text-sm text-gray-500 mt-2">You have no listings yet — <Link to="/farmer-dashboard" className="font-bold text-green-mid">list a product first</Link>.</p>
                    )}
                  </div>
                  {offerFormFields(quote, setQuote, quoteTiers, setQuoteTiers)}
                  {quoteError && <p className="md:col-span-2 text-sm text-red-600">{quoteError}</p>}
                  <button type="submit" disabled={busy} className="md:col-span-2 bg-green-deep text-white font-black py-4 rounded-xl disabled:opacity-50">
                    {busy ? 'Sending...' : 'Send Quote'}
                  </button>
                </form>
              </section>
            )}

            {countering && (
              <section className="bg-white rounded-[24px] p-6 shadow-sm mb-10">
                <h2 className="font-playfair text-xl font-bold text-green-deep mb-6">Counter-offer</h2>
                <form onSubmit={handleCounter} className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {offerFormFields(counter, setCounter, counterTiers, setCounterTiers)}
                  <button type="submit" disabled={busy} className="bg-green-deep text-white font-black py-4 rounded-xl disabled:opacity-50">
                    {busy ? 'Sending...' : 'Send Counter-offer'}
                  </button>
                  <button type="button" onClick={() => setCountering(null)} className="bg-cream text-green-deep font-black py-4 rounded-xl border border-cream-dark">
                    Cancel
                  </button>
                </form>
              </section>
            )}

            {accepting && (
              <section className="bg-white rounded-[24px] p-6 shadow-sm mb-10">
                <h2 className="font-playfair text-xl font-bold text-green-deep mb-2">Accept this offer</h2>
                <p className="text-sm text-gray-500 mb-6">Accepting locks the price at ₹{accepting.price} and creates the order. Enter where it should be delivered.</p>
                <form onSubmit={handleAccept} className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div>
                    <label className="text-xs font-bold uppercase text-gray-400">Delivery address</label>
                    <input required className="w-full bg-cream rounded-xl p-4 mt-1" placeholder="Village, town, district…" value={acceptForm.deliveryAddress} onChange={(e) => setAcceptForm({ ...acceptForm, deliveryAddress: e.target.value })} />
                  </div>
                  <div>
                    <label className="text-xs font-bold uppercase text-gray-400">Phone (optional)</label>
                    <input type="tel" className="w-full bg-cream rounded-xl p-4 mt-1" placeholder="Your phone number" value={acceptForm.buyerPhone} onChange={(e) => setAcceptForm({ ...acceptForm, buyerPhone: e.target.value })} />
                  </div>
                  <button type="submit" disabled={busy} className="bg-green-deep text-white font-black py-4 rounded-xl disabled:opacity-50">
                    {busy ? 'Accepting...' : 'Confirm & Accept'}
                  </button>
                  <button type="button" onClick={() => setAccepting(null)} className="bg-cream text-green-deep font-black py-4 rounded-xl border border-cream-dark">
                    Cancel
                  </button>
                </form>
              </section>
            )}

            <section className="mb-10">
              <h2 className="font-playfair text-2xl font-bold text-green-deep mb-6">Offers</h2>
              {offers.length === 0 ? (
                <p className="text-gray-500 font-medium py-10 text-center border-4 border-dashed border-cream-dark rounded-[48px]">No offers yet.</p>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {offers.map((offer) => (
                    <OfferCard
                      key={offer.id}
                      offer={offer}
                      canCounter={canCounter(offer)}
                      canAccept={canAccept(offer)}
                      onCounter={startCounter}
                      onAccept={startAccept}
                      busy={busy}
                    />
                  ))}
                </div>
              )}
              {!agreement && user && !isParticipant && (
                <p className="text-sm text-gray-500 mt-6">Only the buyer and the quoting farmer can counter or accept offers on this negotiation.</p>
              )}
              {!agreement && isBuyer && offers.length > 0 && !offers.some((o) => canCounter(o) || canAccept(o)) && (
                <p className="text-sm text-gray-500 mt-6">No open offers you can act on right now.</p>
              )}
            </section>

            <section>
              <h2 className="font-playfair text-2xl font-bold text-green-deep mb-6">Quoting farmers</h2>
              {Object.keys(passports).length === 0 ? (
                <p className="text-gray-500 font-medium py-10 text-center">No verified farmer passports to show for these offers.</p>
              ) : (
                Object.entries(passports).map(([farmerId, data]) => {
                  const lots = data?.lots || [];
                  const farmer = data?.farmer;
                  const name = [farmer?.first_name, farmer?.last_name].filter(Boolean).join(' ') || 'Farmer';
                  return (
                    <div key={farmerId} className="mb-10">
                      <div className="flex items-center gap-3 mb-4">
                        <Link to={`/farmers/${farmerId}`} className="font-playfair text-xl font-bold text-green-deep hover:underline">{name}</Link>
                        <span className="inline-flex items-center gap-2 bg-green-fresh/10 text-green-deep text-xs font-black px-4 py-2 rounded-full border border-green-fresh/20">✓ Verified farmer</span>
                      </div>
                      {lots.length === 0 ? (
                        <p className="text-gray-500 font-medium">No crop lots published yet.</p>
                      ) : (
                        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
                          {lots.map((lot) => (
                            <CropPassportCard key={lot.id || lot.product_id || lot.crop} lot={lot} />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </section>
          </>
        )}
      </main>
      <Footer />
    </div>
  );
};

export default NegotiationThread;
