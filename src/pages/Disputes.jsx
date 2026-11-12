import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import Navbar from '../components/Navbar';
import Footer from '../components/Footer';
import { supabase } from '../services/supabase';
import { createDispute, getDisputeStats, listDisputes } from '../services/escrowApi';

// Disputes (Stage 7, module F): the caller's own disputes as buyer or
// farmer (admin sees all, with a status filter), public aggregates, and
// the file-a-dispute form (own order + category + description). Amounts
// arrive in paise and render as rupees; resolution_rate /
// avg_resolution_hours are NULL until something is resolved — rendered
// as "No disputes yet", never an invented 0.
const CATEGORIES = ['quality', 'quantity', 'non_delivery', 'payment'];
const STATUSES = ['filed', 'under_review', 'evidence_requested', 'resolved'];
const STATUS_LABELS = {
  filed: 'Filed',
  under_review: 'Under review',
  evidence_requested: 'Evidence requested',
  resolved: 'Resolved',
};

const Disputes = () => {
  const { user, profile, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const preselectedOrder = searchParams.get('order') || '';

  const [disputes, setDisputes] = useState([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [forbidden, setForbidden] = useState(false);
  const [stats, setStats] = useState(null);
  const [statusFilter, setStatusFilter] = useState('all');

  const [orders, setOrders] = useState([]);
  const [form, setForm] = useState({ orderId: preselectedOrder, category: '', description: '' });
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  const isAdmin = profile?.role === 'admin';
  const canFile = profile?.role === 'buyer' || profile?.role === 'farmer';

  useEffect(() => {
    if (!user && !authLoading) navigate('/login');
  }, [user, authLoading, navigate]);

  useEffect(() => {
    setForm((prev) => ({ ...prev, orderId: preselectedOrder }));
  }, [preselectedOrder]);

  const fetchDisputes = async (status) => {
    setListLoading(true);
    setListError('');
    try {
      const res = await listDisputes(status && status !== 'all' ? status : null);
      setDisputes(res.disputes || (Array.isArray(res) ? res : []));
    } catch (err) {
      if (err.status === 403) setForbidden(true);
      else setListError(err.message || 'Could not load your disputes.');
    } finally {
      setListLoading(false);
    }
  };

  useEffect(() => {
    if (user) void fetchDisputes(isAdmin ? statusFilter : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, statusFilter]);

  // Public aggregates are best-effort: a failed stats read hides the
  // row instead of rendering invented numbers.
  useEffect(() => {
    getDisputeStats().then(setStats).catch(() => setStats(null));
  }, []);

  // The order picker lists the caller's own orders (BuyerDashboard
  // enrichment pattern: orders + a manual products lookup for names).
  useEffect(() => {
    if (!user || !canFile) return;
    let cancelled = false;
    const loadOrders = async () => {
      const field = profile?.role === 'farmer' ? 'farmer_id' : 'buyer_id';
      const { data: rawOrders, error } = await supabase.from('orders').select('*').eq(field, user.id).order('created_at', { ascending: false });
      if (cancelled || error || !rawOrders) return;
      const productIds = [...new Set(rawOrders.map((o) => o.product_id).filter(Boolean))];
      const { data: products } = await supabase.from('products').select('*').in('id', productIds);
      const productsMap = {};
      if (products) products.forEach((p) => { productsMap[p.id] = p; });
      setOrders(rawOrders.map((o) => ({ ...o, product: productsMap[o.product_id] || {} })));
      // A preselected order from the URL must be one of the caller's own
      // orders — otherwise drop it instead of filing against someone
      // else's order (the backend would 403, but never offer it).
      if (preselectedOrder && !rawOrders.some((o) => o.id === preselectedOrder)) {
        setForm((prev) => ({ ...prev, orderId: '' }));
      }
    };
    void loadOrders();
    return () => { cancelled = true; };
  }, [user, profile?.role, canFile, preselectedOrder]);

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!form.orderId) { setFormError('Choose the order this dispute is about.'); return; }
    if (!form.category) { setFormError('Choose a category.'); return; }
    if (!form.description.trim()) { setFormError('Describe what went wrong.'); return; }
    setSaving(true);
    setFormError('');
    try {
      const res = await createDispute({
        order_id: form.orderId,
        category: form.category,
        description: form.description.trim(),
      });
      const id = res?.dispute?.id;
      if (id) navigate(`/disputes/${id}`);
      else await fetchDisputes(isAdmin ? statusFilter : null);
    } catch (err) {
      setFormError(err.message || 'Could not file the dispute.');
    } finally {
      setSaving(false);
    }
  };

  const formatRupees = (paise) => `₹${(Number(paise || 0) / 100).toFixed(2)}`;
  const formatDateTime = (value) => (value ? new Date(value).toLocaleString() : '—');

  return (
    <div className="min-h-screen font-dmsans bg-cream">
      <Navbar />
      <main className="wayfind pt-32 pb-20 px-[5%] max-w-[1400px] mx-auto">
        <header className="mb-10">
          <h1 className="font-playfair text-4xl font-black text-green-deep mb-2">Disputes</h1>
          <p className="text-[#4a4a4a] text-lg">
            {isAdmin ? 'All disputes, newest first — review, ask for evidence, or resolve them.' : 'Your disputes as buyer or farmer — file one, add evidence, and follow the thread.'}
          </p>
        </header>

        {stats && (
          <section className="grid grid-cols-2 sm:grid-cols-5 gap-6 mb-10">
            <div className="bg-white rounded-[24px] p-6 shadow-sm">
              <p className="text-xs text-gray-600 font-bold uppercase tracking-wider mb-1">Total</p>
              <p className="text-2xl font-black text-green-deep">{stats.total ?? 0}</p>
            </div>
            <div className="bg-white rounded-[24px] p-6 shadow-sm">
              <p className="text-xs text-gray-600 font-bold uppercase tracking-wider mb-1">Open</p>
              <p className="text-2xl font-black text-green-deep">{stats.open ?? 0}</p>
            </div>
            <div className="bg-white rounded-[24px] p-6 shadow-sm">
              <p className="text-xs text-gray-600 font-bold uppercase tracking-wider mb-1">Resolved</p>
              <p className="text-2xl font-black text-green-deep">{stats.resolved ?? 0}</p>
            </div>
            <div className="bg-white rounded-[24px] p-6 shadow-sm">
              <p className="text-xs text-gray-600 font-bold uppercase tracking-wider mb-1">Resolution rate</p>
              <p className="text-2xl font-black text-green-deep">
                {stats.resolution_rate == null ? 'No disputes yet' : `${Math.round(stats.resolution_rate > 1 ? stats.resolution_rate : stats.resolution_rate * 100)}%`}
              </p>
            </div>
            <div className="bg-white rounded-[24px] p-6 shadow-sm">
              <p className="text-xs text-gray-600 font-bold uppercase tracking-wider mb-1">Avg. resolution time</p>
              <p className="text-2xl font-black text-green-deep">
                {stats.avg_resolution_hours == null ? 'No disputes yet' : `${Math.round(stats.avg_resolution_hours)}h`}
              </p>
            </div>
          </section>
        )}

        {canFile && (
          <section className="bg-white rounded-[24px] p-6 shadow-sm mb-10">
            <h2 className="font-playfair text-xl font-bold text-green-deep mb-6">File a dispute</h2>
            <form onSubmit={handleCreate} className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label className="text-xs font-bold uppercase text-gray-600" htmlFor="order">Order</label>
                <select id="order" required className="w-full bg-cream rounded-xl p-4 mt-1" value={form.orderId} onChange={(e) => setForm({ ...form, orderId: e.target.value })}>
                  <option value="">Choose one of your orders…</option>
                  {orders.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.product?.name || 'Order'} — ₹{o.total_price} · {o.status}
                    </option>
                  ))}
                </select>
                {orders.length === 0 && (
                  <p className="text-sm text-gray-500 mt-2">You have no orders yet.</p>
                )}
              </div>
              <div>
                <label className="text-xs font-bold uppercase text-gray-600" htmlFor="category">Category</label>
                <select id="category" required className="w-full bg-cream rounded-xl p-4 mt-1" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                  <option value="">Choose a category…</option>
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>{c.replace('_', ' ')}</option>
                  ))}
                </select>
              </div>
              <div className="md:col-span-2">
                <label className="text-xs font-bold uppercase text-gray-600" htmlFor="what-went-wrong">What went wrong?</label>
                <textarea id="what-went-wrong" required rows={4} className="w-full bg-cream rounded-xl p-4 mt-1" placeholder="Describe the problem with this order…" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
              </div>
              {formError && <p aria-live="polite" className="md:col-span-2 text-sm text-red-600">{formError}</p>}
              <button type="submit" disabled={saving} className="md:col-span-2 bg-green-deep text-white font-black py-4 rounded-xl disabled:opacity-50">
                {saving ? 'Filing...' : 'File Dispute'}
              </button>
            </form>
          </section>
        )}

        {isAdmin && (
          <div className="flex flex-wrap gap-2 mb-6">
            {['all', ...STATUSES].map((s) => (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className={`px-4 py-1.5 rounded-lg text-[10px] font-black uppercase transition-all ${statusFilter === s ? 'bg-green-deep text-white shadow-lg' : 'bg-white text-gray-600 hover:bg-amber/10 hover:text-amber'}`}
              >
                {s === 'all' ? 'All' : STATUS_LABELS[s]}
              </button>
            ))}
          </div>
        )}

        {forbidden ? (
          <p className="py-20 text-center text-gray-500 font-medium">You don&apos;t have access to this page.</p>
        ) : listLoading ? (
          <p className="text-center py-20 text-gray-600 italic">Loading disputes...</p>
        ) : listError ? (
          <p aria-live="polite" className="py-20 text-center text-red-600">{listError}</p>
        ) : disputes.length === 0 ? (
          <p className="text-gray-500 font-medium py-10 text-center border-4 border-dashed border-cream-dark rounded-[48px]">No disputes yet.</p>
        ) : (
          <div className="space-y-4">
            {disputes.map((d) => (
              <Link key={d.id} to={`/disputes/${d.id}`} className="block bg-white rounded-[24px] p-6 shadow-sm hover:border-green-fresh border border-transparent transition-all">
                <div className="flex flex-wrap items-center gap-2 mb-2">
                  <span className="px-3 py-1 rounded-full text-[10px] font-black uppercase bg-green-fresh/10 text-green-fresh">{STATUS_LABELS[d.status] || d.status}</span>
                  <span className="px-3 py-1 rounded-full text-[10px] font-black uppercase bg-cream text-gray-500">{(d.category || '').replace('_', ' ')}</span>
                  {d.is_overdue && <span className="px-3 py-1 rounded-full text-[10px] font-black uppercase bg-red-500 text-white">Overdue</span>}
                  {d.escalated && <span className="px-3 py-1 rounded-full text-[10px] font-black uppercase bg-amber text-white">Escalated</span>}
                </div>
                <p className="font-bold text-green-deep">{d.order?.product_title || 'Order'}</p>
                <p className="text-sm text-gray-500">
                  {d.order?.total_price_paise != null ? `${formatRupees(d.order.total_price_paise)} · ` : ''}
                  SLA: {formatDateTime(d.sla_deadline)}
                  {d.created_at ? ` · Filed ${new Date(d.created_at).toLocaleDateString()}` : ''}
                </p>
              </Link>
            ))}
          </div>
        )}
      </main>
      <Footer />
    </div>
  );
};

export default Disputes;
