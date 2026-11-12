import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import Navbar from '../components/Navbar';
import Footer from '../components/Footer';
import { requirementsFetch } from '../services/escrowApi';

// Buyer requirements (Stage 4, module C). The buyer posts what they need;
// farmers quote on it from the negotiation thread. The list is the buyer's
// own requirements only — the backend enforces that.
// NOTE: the list reads GET /api/requirements (the REST collection GET
// for the POST /api/requirements resource); each row carries offer_count.
const Requirements = () => {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();

  const [requirements, setRequirements] = useState([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [forbidden, setForbidden] = useState(false);

  const [form, setForm] = useState({
    crop: '', quantity: '', quality: '',
    deliveryWindowStart: '', deliveryWindowEnd: '', targetPrice: '',
  });
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!user && !authLoading) navigate('/login');
  }, [user, authLoading, navigate]);

  const fetchRequirements = async () => {
    setListLoading(true);
    setListError('');
    try {
      const res = await requirementsFetch('/');
      setRequirements(res.requirements || res.data || (Array.isArray(res) ? res : []));
    } catch (err) {
      if (err.status === 403) setForbidden(true);
      else setListError(err.message || 'Could not load your requirements.');
    } finally {
      setListLoading(false);
    }
  };

  useEffect(() => {
    if (user) void fetchRequirements();
  }, [user]);

  const handleCreate = async (e) => {
    e.preventDefault();
    const quantity = parseFloat(form.quantity);
    const targetPrice = parseFloat(form.targetPrice);
    if (!form.crop.trim()) {
      setFormError('Enter the crop name.');
      return;
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      setFormError('Enter a quantity greater than 0.');
      return;
    }
    if (!form.quality.trim()) {
      setFormError('Enter the quality you need.');
      return;
    }
    if (!form.deliveryWindowStart || !form.deliveryWindowEnd) {
      setFormError('Enter a delivery window (start and end).');
      return;
    }
    if (new Date(form.deliveryWindowEnd) < new Date(form.deliveryWindowStart)) {
      setFormError('The delivery window end must be on or after the start.');
      return;
    }
    if (!Number.isFinite(targetPrice) || targetPrice <= 0) {
      setFormError('Enter a target price greater than 0.');
      return;
    }

    setSaving(true);
    setFormError('');
    try {
      // House style (snake_case) — contract names mapped in escrowApi.js.
      await requirementsFetch('/', {
        method: 'POST',
        body: {
          crop: form.crop.trim(),
          quantity,
          quality: form.quality.trim(),
          delivery_window_start: form.deliveryWindowStart,
          delivery_window_end: form.deliveryWindowEnd,
          target_price: targetPrice,
        },
      });
      setForm({ crop: '', quantity: '', quality: '', deliveryWindowStart: '', deliveryWindowEnd: '', targetPrice: '' });
      await fetchRequirements();
    } catch (err) {
      setFormError(err.message || 'Could not post the requirement.');
    } finally {
      setSaving(false);
    }
  };

  const formatDate = (value) => (value ? new Date(value).toLocaleDateString() : '—');

  return (
    <div className="min-h-screen font-dmsans bg-cream">
      <Navbar />
      <main className="wayfind pt-32 pb-20 px-[5%] max-w-[1400px] mx-auto">
        <header className="mb-10">
          <h1 className="font-playfair text-4xl font-black text-green-deep mb-2">Requirements</h1>
          <p className="text-[#4a4a4a] text-lg">Post what you need — farmers quote on it, and you lock the price when you accept.</p>
        </header>

        {forbidden ? (
          <p className="py-20 text-center text-gray-500 font-medium">You don&apos;t have access to this page.</p>
        ) : (
          <>
            <section className="bg-white rounded-[24px] p-6 shadow-sm mb-10">
              <h2 className="font-playfair text-xl font-bold text-green-deep mb-6">Post a requirement</h2>
              <form onSubmit={handleCreate} className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <label className="text-xs font-bold uppercase text-gray-600" htmlFor="crop">Crop</label>
                  <input id="crop" required className="w-full bg-cream rounded-xl p-4 mt-1" placeholder="Wheat..." value={form.crop} onChange={(e) => setForm({ ...form, crop: e.target.value })} />
                </div>
                <div>
                  <label className="text-xs font-bold uppercase text-gray-600" htmlFor="quantity">Quantity</label>
                  <input id="quantity" required type="number" min="0.01" step="0.01" className="w-full bg-cream rounded-xl p-4 mt-1" placeholder="100" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} />
                </div>
                <div>
                  <label className="text-xs font-bold uppercase text-gray-600" htmlFor="quality">Quality</label>
                  <input id="quality" required className="w-full bg-cream rounded-xl p-4 mt-1" placeholder="Grade A" value={form.quality} onChange={(e) => setForm({ ...form, quality: e.target.value })} />
                </div>
                <div>
                  <label className="text-xs font-bold uppercase text-gray-600" htmlFor="target-price">Target price (₹)</label>
                  <input id="target-price" required type="number" min="0.01" step="0.01" className="w-full bg-cream rounded-xl p-4 mt-1" placeholder="2500" value={form.targetPrice} onChange={(e) => setForm({ ...form, targetPrice: e.target.value })} />
                </div>
                <div>
                  <label className="text-xs font-bold uppercase text-gray-600" htmlFor="delivery-window-start">Delivery window start</label>
                  <input id="delivery-window-start" required type="date" className="w-full bg-cream rounded-xl p-4 mt-1" value={form.deliveryWindowStart} onChange={(e) => setForm({ ...form, deliveryWindowStart: e.target.value })} />
                </div>
                <div>
                  <label className="text-xs font-bold uppercase text-gray-600" htmlFor="delivery-window-end">Delivery window end</label>
                  <input id="delivery-window-end" required type="date" className="w-full bg-cream rounded-xl p-4 mt-1" value={form.deliveryWindowEnd} onChange={(e) => setForm({ ...form, deliveryWindowEnd: e.target.value })} />
                </div>
                {formError && <p aria-live="polite" className="md:col-span-2 text-sm text-red-600">{formError}</p>}
                <button type="submit" disabled={saving} className="md:col-span-2 bg-green-deep text-white font-black py-4 rounded-xl disabled:opacity-50">
                  {saving ? 'Posting...' : 'Post Requirement'}
                </button>
              </form>
            </section>

            <section>
              <h2 className="font-playfair text-2xl font-bold text-green-deep mb-6">Your requirements</h2>
              {listLoading ? (
                <p className="text-center py-10 text-gray-600 italic">Loading your requirements...</p>
              ) : listError ? (
                <p aria-live="polite" className="text-center py-10 text-red-600">{listError}</p>
              ) : requirements.length === 0 ? (
                <div className="py-20 text-center border-4 border-dashed border-cream-dark rounded-[48px]">
                  <p className="text-gray-600 font-bold italic text-xl">No requirements yet.</p>
                  <p className="text-gray-600 text-sm mt-2">Post one above and farmers will quote on it.</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {requirements.map((req) => {
                    const offerCount = req.offer_count ?? req.offers?.length ?? 0;
                    return (
                      <Link key={req.id} to={`/negotiations/${req.id}`} className="bg-white rounded-[24px] p-6 shadow-sm border border-transparent hover:border-green-fresh transition-all">
                        <div className="flex items-start justify-between gap-4 mb-2">
                          <h3 className="font-playfair text-xl font-bold text-green-deep">{req.crop}</h3>
                          {req.status && (
                            <span className="px-3 py-1 rounded-full text-[10px] font-black uppercase bg-green-fresh/10 text-green-fresh">{req.status}</span>
                          )}
                        </div>
                        <p className="text-sm text-[#4a4a4a] mb-1">{req.quantity} — {req.quality}</p>
                        <p className="text-sm text-[#4a4a4a] mb-1">Target: ₹{req.target_price ?? req.targetPrice}</p>
                        <p className="text-sm text-gray-500 mb-3">
                          Delivery: {formatDate(req.delivery_window_start ?? req.deliveryWindowStart)} – {formatDate(req.delivery_window_end ?? req.deliveryWindowEnd)}
                        </p>
                        <p className="text-sm font-bold text-green-mid">
                          {offerCount} offer{offerCount === 1 ? '' : 's'}
                        </p>
                      </Link>
                    );
                  })}
                </div>
              )}
            </section>
          </>
        )}
      </main>
      <Footer />
    </div>
  );
};

export default Requirements;
