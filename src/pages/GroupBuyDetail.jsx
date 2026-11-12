import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import Navbar from '../components/Navbar';
import Footer from '../components/Footer';
import CropPassportCard from '../components/CropPassportCard';
import { supabase } from '../services/supabase';
import {
  getGroupBuy, joinGroupBuy, negotiateGroupBuy, closeGroupBuy,
  getGroupBuySettlement, negotiationsFetch, publicPassportFetch,
} from '../services/escrowApi';

// One group buy (Stage 5, module D): the demand pool, its participants,
// the owner's negotiate/close actions, and — once closed — each
// participant's share of the pooled order total. Settlement rows record
// what each participant owes toward the pooled order (integer paise);
// collection is a later stage, so amounts are never labelled "payout".
// Transport is Stage 6: the API returns transport: null and nothing is
// rendered for it here. A 404 passport (missing/unverified farmer)
// renders no passport and no name — never a fake badge.
const GroupBuyDetail = () => {
  const { id } = useParams();
  const { user, profile, loading: authLoading } = useAuth();
  const navigate = useNavigate();

  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [forbidden, setForbidden] = useState(false);
  const [passports, setPassports] = useState({});
  const [agreement, setAgreement] = useState(null);
  const [settlement, setSettlement] = useState(null);
  const [settlementError, setSettlementError] = useState('');

  const [joinQty, setJoinQty] = useState('');
  const [joinError, setJoinError] = useState('');
  const [busy, setBusy] = useState(false);

  // Negotiate form (owner turns the pooled demand into a requirement).
  const [negotiateForm, setNegotiateForm] = useState({
    targetPrice: '', deliveryWindowStart: '', deliveryWindowEnd: '', quality: '',
  });
  const [negotiateError, setNegotiateError] = useState('');
  const [createdRequirement, setCreatedRequirement] = useState(null);

  // Direct-close form (owner buys the pooled lot from another farmer's
  // listing — the group buys FROM a farmer, never from the owner).
  const [closeForm, setCloseForm] = useState({
    productId: '', deliveryAddress: '', unitPrice: '', buyerPhone: '',
  });
  const [closeError, setCloseError] = useState('');
  const [closeNote, setCloseNote] = useState('');
  const [buyableProducts, setBuyableProducts] = useState([]);
  const [productsLoading, setProductsLoading] = useState(false);

  useEffect(() => {
    if (!user && !authLoading) navigate('/login');
  }, [user, authLoading, navigate]);

  const loadSettlement = async () => {
    try {
      const data = await getGroupBuySettlement(id);
      setSettlement(data);
      setSettlementError('');
    } catch (err) {
      // 404 is the generic "not a party / no settlement" response — the
      // settlement section simply stays hidden; anything else is shown.
      if (err.status !== 404) setSettlementError(err.message || 'Could not load the settlement.');
      setSettlement(null);
    }
  };

  const loadDetail = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await getGroupBuy(id);
      setDetail(data);
      const group = data.group_buy || {};
      // Fetch each participant farmer's public passport; a 404 means
      // unverified/missing and is swallowed — no passport is rendered.
      const participantIds = [...new Set((data.participants || []).map((p) => p.user_id).filter(Boolean))];
      const found = {};
      await Promise.all(participantIds.map(async (farmerId) => {
        try {
          found[farmerId] = await publicPassportFetch(`/farmers/${farmerId}/passport`);
        } catch (err) {
          if (err.status !== 404) console.error('Passport load failed:', err);
        }
      }));
      setPassports(found);
      // If the group already has a requirement, check whether it has an
      // accepted agreement — that decides the close path (negotiated vs
      // direct). A failed thread read falls back to the direct form; the
      // backend still enforces the negotiation-pending 409.
      if (group.requirement_id) {
        try {
          const thread = await negotiationsFetch(`/${group.requirement_id}`);
          setAgreement(thread?.agreement || null);
        } catch (err) {
          if (err.status !== 404) console.error('Negotiation thread load failed:', err);
          setAgreement(null);
        }
      } else {
        setAgreement(null);
      }
      if (group.status === 'closed' || group.order_id) await loadSettlement();
    } catch (err) {
      if (err.status === 403) setForbidden(true);
      else if (err.status === 404) setError('This group buy does not exist.');
      else setError(err.message || 'Could not load this group buy.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (user) void loadDetail();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, id]);

  const group = detail?.group_buy || {};
  const participants = detail?.participants || [];
  const totalQuantity = detail?.total_quantity ?? group.total_quantity ?? 0;
  const threshold = Number(group.threshold_quantity) || 0;
  const thresholdMet = threshold > 0 && Number(totalQuantity) >= threshold;
  const isOwner = !!user && !!group.owner_id && user.id === group.owner_id;
  const isParticipant = participants.some((p) => p.user_id === user?.id);
  const isOpen = group.status === 'open';
  const pastDeadline = group.deadline ? new Date(group.deadline) < new Date() : false;
  const hasRequirement = !!group.requirement_id;
  const isClosed = group.status === 'closed' || !!group.order_id;
  const canJoin = isOpen && !pastDeadline && profile?.role === 'farmer' && !isParticipant;
  // Direct close is the path when there is no accepted agreement; the
  // negotiated path (empty body) applies only once the requirement's
  // agreement exists.
  const negotiatedClose = hasRequirement && !!agreement;

  // Listings the pooled order could buy: every product except the owner's
  // own — same direct query BuyerDashboard uses for the marketplace list.
  useEffect(() => {
    if (!user || !isOwner || !isOpen || !thresholdMet || negotiatedClose) return;
    let cancelled = false;
    setProductsLoading(true);
    supabase.from('products').select('*').order('created_at', { ascending: false })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) console.error('Products load failed:', error);
        else setBuyableProducts((data || []).filter((p) => p.farmer_id !== user.id));
        setProductsLoading(false);
      });
    return () => { cancelled = true; };
  }, [user, isOwner, isOpen, thresholdMet, negotiatedClose]);

  const handleJoin = async (e) => {
    e.preventDefault();
    const contributionQuantity = parseFloat(joinQty);
    if (!Number.isFinite(contributionQuantity) || contributionQuantity <= 0) {
      setJoinError('Enter a quantity greater than 0.');
      return;
    }
    setBusy(true);
    setJoinError('');
    try {
      await joinGroupBuy(id, { contribution_quantity: contributionQuantity });
      setJoinQty('');
      await loadDetail();
    } catch (err) {
      setJoinError(err.message || 'Could not join the group.');
    } finally {
      setBusy(false);
    }
  };

  const handleNegotiate = async (e) => {
    e.preventDefault();
    const targetPrice = parseFloat(negotiateForm.targetPrice);
    if (!Number.isFinite(targetPrice) || targetPrice <= 0) {
      setNegotiateError('Enter a target price greater than 0.');
      return;
    }
    if (!negotiateForm.deliveryWindowStart || !negotiateForm.deliveryWindowEnd) {
      setNegotiateError('Enter a delivery window (start and end).');
      return;
    }
    if (new Date(negotiateForm.deliveryWindowEnd) < new Date(negotiateForm.deliveryWindowStart)) {
      setNegotiateError('The delivery window end must be on or after the start.');
      return;
    }
    setBusy(true);
    setNegotiateError('');
    try {
      const res = await negotiateGroupBuy(id, {
        target_price: targetPrice,
        delivery_window_start: negotiateForm.deliveryWindowStart,
        delivery_window_end: negotiateForm.deliveryWindowEnd,
        ...(negotiateForm.quality.trim() ? { quality: negotiateForm.quality.trim() } : {}),
      });
      const requirement = res.requirement || res;
      setCreatedRequirement(requirement);
      setNegotiateForm({ targetPrice: '', deliveryWindowStart: '', deliveryWindowEnd: '', quality: '' });
      await loadDetail();
    } catch (err) {
      setNegotiateError(err.message || 'Could not start the negotiation.');
    } finally {
      setBusy(false);
    }
  };

  const handleCloseNegotiated = async () => {
    setBusy(true);
    setCloseError('');
    setCloseNote('');
    try {
      await closeGroupBuy(id, {});
      setCloseNote('Group closed — the pooled order was placed from the negotiated agreement.');
      await loadDetail();
    } catch (err) {
      setCloseError(err.message || 'Could not close the group.');
    } finally {
      setBusy(false);
    }
  };

  const handleCloseDirect = async (e) => {
    e.preventDefault();
    if (!closeForm.productId) {
      setCloseError('Choose a listing to buy the pooled lot from.');
      return;
    }
    if (!closeForm.deliveryAddress.trim()) {
      setCloseError('Enter a delivery address to close the group.');
      return;
    }
    const unitPrice = closeForm.unitPrice === '' ? null : parseFloat(closeForm.unitPrice);
    if (unitPrice !== null && (!Number.isFinite(unitPrice) || unitPrice <= 0)) {
      setCloseError('Enter a locked price greater than 0, or leave it blank.');
      return;
    }
    setBusy(true);
    setCloseError('');
    setCloseNote('');
    try {
      await closeGroupBuy(id, {
        product_id: closeForm.productId,
        delivery_address: closeForm.deliveryAddress.trim(),
        ...(unitPrice !== null ? { unit_price: unitPrice } : {}),
        ...(closeForm.buyerPhone.trim() ? { buyer_phone: closeForm.buyerPhone.trim() } : {}),
      });
      setCloseNote('Group closed — the pooled order was placed.');
      await loadDetail();
    } catch (err) {
      setCloseError(err.message || 'Could not close the group.');
    } finally {
      setBusy(false);
    }
  };

  const formatDate = (value) => (value ? new Date(value).toLocaleDateString() : '—');
  const formatDateTime = (value) => (value ? new Date(value).toLocaleString() : '—');
  const formatRupees = (paise) => `₹${(Number(paise || 0) / 100).toFixed(2)}`;
  const progressPct = threshold > 0 ? Math.min(100, (Number(totalQuantity) / threshold) * 100) : 0;
  // share is the participant's fraction of the pooled order; fall back to
  // contribution / pooled total when the row carries no share.
  const sharePct = (row) => {
    if (row.share != null) return (Number(row.share) * 100).toFixed(1);
    if (Number(totalQuantity) > 0) return ((Number(row.contribution_quantity) || 0) / Number(totalQuantity) * 100).toFixed(1);
    return '0.0';
  };
  const participantName = (farmerId) => {
    const farmer = passports[farmerId]?.farmer;
    return [farmer?.first_name, farmer?.last_name].filter(Boolean).join(' ') || 'Farmer';
  };

  const settlements = settlement?.settlements || [];
  const totalPaise = settlement?.total_paise;

  return (
    <div className="min-h-screen font-dmsans bg-cream">
      <Navbar />
      <main className="pt-32 pb-20 px-[5%] max-w-[1400px] mx-auto">
        {loading ? (
          <p className="text-center py-20 text-gray-400 italic">Loading group buy...</p>
        ) : forbidden ? (
          <p className="py-20 text-center text-gray-500 font-medium">You don&apos;t have access to this page.</p>
        ) : error ? (
          <p className="py-20 text-center text-red-600">{error}</p>
        ) : (
          <>
            <header className="mb-10">
              <Link to="/group-buys" className="text-sm font-bold text-green-mid hover:text-green-deep">← All group buys</Link>
              <div className="flex items-start justify-between gap-4 mt-2">
                <h1 className="font-playfair text-4xl font-black text-green-deep mb-2">{group.crop || 'Group buy'}</h1>
                {group.status && (
                  <span className={`px-3 py-1 rounded-full text-[10px] font-black uppercase ${group.status === 'open' ? 'bg-green-fresh/10 text-green-fresh' : 'bg-cream-dark text-gray-500'}`}>{group.status}</span>
                )}
              </div>
              <p className="text-[#4a4a4a] text-lg">
                {totalQuantity} / {group.threshold_quantity} {group.unit} pooled
                {' · '}{participants.length} participant{participants.length === 1 ? '' : 's'}
              </p>
              <div className="w-full bg-cream-dark rounded-full h-2 mt-3 mb-2 max-w-xl">
                <div className="bg-green-fresh h-2 rounded-full" style={{ width: `${progressPct}%` }} />
              </div>
              <p className="text-gray-500">
                Deadline: {formatDateTime(group.deadline)}
                {isOwner ? ' · You are the owner of this group.' : ''}
                {group.closed_at ? ` · Closed ${formatDateTime(group.closed_at)}` : ''}
              </p>
              {group.order_id && (
                <p className="text-sm mt-2">
                  Pooled order created:{' '}
                  <Link to={`/checkout?orderId=${encodeURIComponent(group.order_id)}`} className="font-bold text-green-mid hover:text-green-deep">View order →</Link>
                </p>
              )}
            </header>

            {/* Transport slot (Stage 6): the API returns transport: null for
                this stage, so nothing is rendered here. Stage 6 wires the
                shared transport booking into this block. */}
            {detail?.transport != null && null}

            {canJoin && (
              <section className="bg-white rounded-[24px] p-6 shadow-sm mb-10">
                <h2 className="font-playfair text-xl font-bold text-green-deep mb-6">Join this group buy</h2>
                <form onSubmit={handleJoin} className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div>
                    <label className="text-xs font-bold uppercase text-gray-400">Your contribution ({group.unit})</label>
                    <input required type="number" min="0.01" step="0.01" className="w-full bg-cream rounded-xl p-4 mt-1" placeholder="100" value={joinQty} onChange={(e) => setJoinQty(e.target.value)} />
                  </div>
                  <div className="flex items-end">
                    <button type="submit" disabled={busy} className="w-full bg-green-deep text-white font-black py-4 rounded-xl disabled:opacity-50">
                      {busy ? 'Joining...' : 'Join Group Buy'}
                    </button>
                  </div>
                  {joinError && <p className="md:col-span-2 text-sm text-red-600">{joinError}</p>}
                </form>
              </section>
            )}
            {isOpen && !pastDeadline && profile?.role === 'farmer' && isParticipant && (
              <p className="text-sm font-bold text-green-mid mb-10">You have joined this group.</p>
            )}

            {isOwner && isOpen && thresholdMet && !hasRequirement && (
              <section className="bg-white rounded-[24px] p-6 shadow-sm mb-10">
                <h2 className="font-playfair text-xl font-bold text-green-deep mb-2">Negotiate as one buyer</h2>
                <p className="text-sm text-gray-500 mb-6">The threshold is met. Turn the pooled demand into a requirement and negotiate one price for the whole lot.</p>
                <form onSubmit={handleNegotiate} className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div>
                    <label className="text-xs font-bold uppercase text-gray-400">Target price (₹)</label>
                    <input required type="number" min="0.01" step="0.01" className="w-full bg-cream rounded-xl p-4 mt-1" placeholder="2500" value={negotiateForm.targetPrice} onChange={(e) => setNegotiateForm({ ...negotiateForm, targetPrice: e.target.value })} />
                  </div>
                  <div>
                    <label className="text-xs font-bold uppercase text-gray-400">Quality (optional)</label>
                    <input className="w-full bg-cream rounded-xl p-4 mt-1" placeholder="Grade A" value={negotiateForm.quality} onChange={(e) => setNegotiateForm({ ...negotiateForm, quality: e.target.value })} />
                  </div>
                  <div>
                    <label className="text-xs font-bold uppercase text-gray-400">Delivery window start</label>
                    <input required type="date" className="w-full bg-cream rounded-xl p-4 mt-1" value={negotiateForm.deliveryWindowStart} onChange={(e) => setNegotiateForm({ ...negotiateForm, deliveryWindowStart: e.target.value })} />
                  </div>
                  <div>
                    <label className="text-xs font-bold uppercase text-gray-400">Delivery window end</label>
                    <input required type="date" className="w-full bg-cream rounded-xl p-4 mt-1" value={negotiateForm.deliveryWindowEnd} onChange={(e) => setNegotiateForm({ ...negotiateForm, deliveryWindowEnd: e.target.value })} />
                  </div>
                  {negotiateError && <p className="md:col-span-2 text-sm text-red-600">{negotiateError}</p>}
                  <button type="submit" disabled={busy} className="md:col-span-2 bg-green-deep text-white font-black py-4 rounded-xl disabled:opacity-50">
                    {busy ? 'Starting...' : 'Start Negotiation'}
                  </button>
                </form>
              </section>
            )}
            {createdRequirement?.id && (
              <p className="text-sm mb-10">
                Negotiation started:{' '}
                <Link to={`/negotiations/${createdRequirement.id}`} className="font-bold text-green-mid hover:text-green-deep">View negotiation →</Link>
              </p>
            )}
            {isOwner && isOpen && hasRequirement && !negotiatedClose && (
              <p className="text-sm text-gray-500 mb-10">
                Negotiation in progress —{' '}
                <Link to={`/negotiations/${group.requirement_id}`} className="font-bold text-green-mid hover:text-green-deep">view negotiation →</Link>
                {' '}Close below once a price is agreed, or buy directly from a listing.
              </p>
            )}

            {isOwner && isOpen && thresholdMet && negotiatedClose && (
              <section className="bg-green-deep text-white rounded-[24px] p-6 shadow-sm mb-10">
                <h2 className="font-playfair text-xl font-bold mb-2">Ready to close</h2>
                <p className="text-sm opacity-90 mb-6">The negotiation has an accepted agreement. Closing places the pooled order at the negotiated price.</p>
                {closeError && <p className="text-sm text-red-300 mb-4">{closeError}</p>}
                {closeNote && <p className="text-sm mb-4">{closeNote}</p>}
                <button type="button" onClick={() => void handleCloseNegotiated()} disabled={busy} className="bg-white text-green-deep font-black px-8 py-4 rounded-xl disabled:opacity-50">
                  {busy ? 'Closing...' : 'Close Group & Place Pooled Order'}
                </button>
              </section>
            )}

            {isOwner && isOpen && thresholdMet && !negotiatedClose && (
              <section className="bg-white rounded-[24px] p-6 shadow-sm mb-10">
                <h2 className="font-playfair text-xl font-bold text-green-deep mb-2">Close the group & place the pooled order</h2>
                <p className="text-sm text-gray-500 mb-6">Buy the pooled lot from another farmer&apos;s listing. The order is placed as the buyer-representative for the whole group.</p>
                <form onSubmit={handleCloseDirect} className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="md:col-span-2">
                    <label className="text-xs font-bold uppercase text-gray-400">Listing to buy from</label>
                    <select required className="w-full bg-cream rounded-xl p-4 mt-1" value={closeForm.productId} onChange={(e) => setCloseForm({ ...closeForm, productId: e.target.value })}>
                      <option value="">Choose a listing…</option>
                      {buyableProducts.map((p) => (
                        <option key={p.id} value={p.id}>{p.name || p.crop || 'Listing'} — ₹{p.user_price ?? p.price}</option>
                      ))}
                    </select>
                    {!productsLoading && buyableProducts.length === 0 && (
                      <p className="text-sm text-gray-500 mt-2">No listings from other farmers are available to buy from yet.</p>
                    )}
                  </div>
                  <div>
                    <label className="text-xs font-bold uppercase text-gray-400">Delivery address</label>
                    <input required className="w-full bg-cream rounded-xl p-4 mt-1" placeholder="Village, town, district…" value={closeForm.deliveryAddress} onChange={(e) => setCloseForm({ ...closeForm, deliveryAddress: e.target.value })} />
                  </div>
                  <div>
                    <label className="text-xs font-bold uppercase text-gray-400">Phone (optional)</label>
                    <input type="tel" className="w-full bg-cream rounded-xl p-4 mt-1" placeholder="Your phone number" value={closeForm.buyerPhone} onChange={(e) => setCloseForm({ ...closeForm, buyerPhone: e.target.value })} />
                  </div>
                  <div>
                    <label className="text-xs font-bold uppercase text-gray-400">Locked price per unit, ₹ (optional)</label>
                    <input type="number" min="0.01" step="0.01" className="w-full bg-cream rounded-xl p-4 mt-1" placeholder="Leave blank to use the listing price" value={closeForm.unitPrice} onChange={(e) => setCloseForm({ ...closeForm, unitPrice: e.target.value })} />
                  </div>
                  {closeError && <p className="md:col-span-2 text-sm text-red-600">{closeError}</p>}
                  {closeNote && <p className="md:col-span-2 text-sm font-bold text-green-mid">{closeNote}</p>}
                  <button type="submit" disabled={busy} className="md:col-span-2 bg-green-deep text-white font-black py-4 rounded-xl disabled:opacity-50">
                    {busy ? 'Closing...' : 'Close Group & Place Pooled Order'}
                  </button>
                </form>
              </section>
            )}
            {isOwner && isOpen && !thresholdMet && (
              <p className="text-sm text-gray-500 mb-10">The group can be closed once the pooled quantity reaches the threshold ({totalQuantity} / {group.threshold_quantity} {group.unit} so far).</p>
            )}

            <section className="mb-10">
              <h2 className="font-playfair text-2xl font-bold text-green-deep mb-6">Participants</h2>
              {participants.length === 0 ? (
                <p className="text-gray-500 font-medium py-10 text-center border-4 border-dashed border-cream-dark rounded-[48px]">No participants yet.</p>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {participants.map((participant) => (
                    <div key={participant.id} className="bg-white rounded-[24px] p-6 shadow-sm">
                      <Link to={`/farmers/${participant.user_id}`} className="font-playfair text-xl font-bold text-green-deep hover:underline">
                        {participantName(participant.user_id)}
                      </Link>
                      <p className="text-sm text-[#4a4a4a] mt-2">
                        Contribution: {participant.contribution_quantity} {group.unit}
                      </p>
                      {isClosed && (
                        <p className="text-sm text-[#4a4a4a]">Share of the pooled order: {sharePct(participant)}%</p>
                      )}
                      <p className="text-sm text-gray-500">
                        Joined {formatDate(participant.created_at)}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {isClosed && (
              <section className="mb-10">
                <h2 className="font-playfair text-2xl font-bold text-green-deep mb-2">Settlement</h2>
                <p className="text-sm text-gray-500 mb-6">Each participant&apos;s share of the pooled order total — what they owe toward the pooled order.</p>
                {settlementError ? (
                  <p className="text-center py-10 text-red-600">{settlementError}</p>
                ) : !settlement ? (
                  <p className="text-center py-10 text-gray-400 italic">Loading settlement...</p>
                ) : settlements.length === 0 ? (
                  <p className="text-gray-500 font-medium py-10 text-center border-4 border-dashed border-cream-dark rounded-[48px]">No settlement rows yet.</p>
                ) : (
                  <>
                    <div className="overflow-x-auto bg-white rounded-[24px] shadow-sm">
                      <table className="w-full text-left">
                        <thead>
                          <tr className="text-xs font-bold uppercase text-gray-400 border-b border-cream-dark">
                            <th className="p-4">Participant</th>
                            <th className="p-4">Contribution ({group.unit})</th>
                            <th className="p-4">Share</th>
                            <th className="p-4">Share of pooled order total</th>
                            <th className="p-4">Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {settlements.map((row) => (
                            <tr key={row.participant_id} className="border-b border-cream-dark last:border-0">
                              <td className="p-4 font-bold text-green-deep">
                                <Link to={`/farmers/${row.user_id}`} className="hover:underline">{participantName(row.user_id)}</Link>
                              </td>
                              <td className="p-4">{row.contribution_quantity}</td>
                              <td className="p-4">{sharePct(row)}%</td>
                              <td className="p-4 font-bold">{formatRupees(row.amount_paise)}</td>
                              <td className="p-4 text-sm text-gray-500">{row.status || '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {totalPaise != null && (
                      <p className="text-lg font-bold text-green-deep mt-4">Pooled order total: {formatRupees(totalPaise)}</p>
                    )}
                  </>
                )}
              </section>
            )}

            <section>
              <h2 className="font-playfair text-2xl font-bold text-green-deep mb-6">Participant passports</h2>
              {Object.keys(passports).length === 0 ? (
                <p className="text-gray-500 font-medium py-10 text-center">No verified farmer passports to show for these participants.</p>
              ) : (
                Object.entries(passports).map(([farmerId, data]) => {
                  const lots = data?.lots || [];
                  const name = participantName(farmerId);
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

export default GroupBuyDetail;
