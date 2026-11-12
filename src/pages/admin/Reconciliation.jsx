import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import Navbar from '../../components/Navbar';
import Footer from '../../components/Footer';
import { adminReconciliationFetch } from '../../services/escrowApi';

// Stuck-money reconciliation (Stage 10, module I): orders whose money
// needs reconciling — confirmed-but-unpaid, completed-with-held, or
// refund-reconcile. The server enforces admin-only access; a 403 here
// only changes the message. Amounts arrive in paise and render as
// rupees. Order links go to the dispute form for that order
// (/disputes?order=…) — the app has no standalone order page.
const CATEGORIES = ['confirmed_unpaid', 'completed_held', 'refund_reconcile'];
const CATEGORY_LABELS = {
  confirmed_unpaid: 'Confirmed, unpaid',
  completed_held: 'Completed, payment held',
  refund_reconcile: 'Refund to reconcile',
};

const formatRupees = (paise) => `₹${(Number(paise || 0) / 100).toFixed(2)}`;

const Reconciliation = () => {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();

  const [stuck, setStuck] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [forbidden, setForbidden] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState('all');

  useEffect(() => {
    if (!user && !authLoading) navigate('/login');
  }, [user, authLoading, navigate]);

  useEffect(() => {
    if (!user) return;
    const load = async () => {
      setLoading(true);
      setError('');
      try {
        const res = await adminReconciliationFetch();
        setStuck(res.stuck || []);
      } catch (err) {
        if (err.status === 403) setForbidden(true);
        else setError(err.message || 'Could not load stuck money.');
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, [user]);

  const visible = categoryFilter === 'all'
    ? stuck
    : stuck.filter((row) => row.category === categoryFilter);
  const totalPaise = visible.reduce((sum, row) => sum + Number(row.amount_paise || 0), 0);

  return (
    <div className="min-h-screen font-dmsans bg-cream">
      <Navbar />
      <main className="pt-32 pb-20 px-[5%] max-w-[1400px] mx-auto">
        <header className="mb-10">
          <h1 className="font-playfair text-4xl font-black text-green-deep mb-2">Reconciliation</h1>
          <p className="text-[#4a4a4a] text-lg">Stuck money — orders whose payment needs reconciling.</p>
        </header>

        {forbidden ? (
          <p className="py-20 text-center text-gray-500 font-medium">You don&apos;t have access to this page.</p>
        ) : loading ? (
          <p className="text-center py-20 text-gray-600 italic">Loading stuck money...</p>
        ) : error ? (
          <p className="py-20 text-center text-red-600">{error}</p>
        ) : stuck.length === 0 ? (
          <p className="text-gray-500 font-medium py-10 text-center border-4 border-dashed border-cream-dark rounded-[48px]">No stuck money — nothing needs reconciling.</p>
        ) : (
          <div>
            <div className="flex flex-wrap gap-2 mb-6">
              {['all', ...CATEGORIES].map((c) => (
                <button
                  key={c}
                  onClick={() => setCategoryFilter(c)}
                  className={`px-4 py-1.5 rounded-lg text-[10px] font-black uppercase transition-all ${categoryFilter === c ? 'bg-green-deep text-white shadow-lg' : 'bg-white text-gray-600 hover:bg-amber/10 hover:text-amber'}`}
                >
                  {c === 'all' ? 'All' : CATEGORY_LABELS[c]}
                </button>
              ))}
            </div>

            <p className="font-bold text-green-deep mb-4">
              {visible.length} {visible.length === 1 ? 'order' : 'orders'} · {formatRupees(totalPaise)}
            </p>

            {visible.length === 0 ? (
              <p className="text-gray-500 font-medium py-10 text-center border-4 border-dashed border-cream-dark rounded-[48px]">No stuck money in this category.</p>
            ) : (
              <div className="bg-white rounded-[24px] p-6 shadow-sm overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="text-[10px] font-black uppercase text-gray-600 tracking-widest">
                      <th className="py-3 pr-4">Order</th>
                      <th className="py-3 pr-4">Category</th>
                      <th className="py-3 pr-4">Amount</th>
                      <th className="py-3 pr-4">Order status</th>
                      <th className="py-3 pr-4">Payment status</th>
                      <th className="py-3 pr-4">Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((row) => (
                      <tr key={row.order_id} className="border-t border-cream-dark font-bold text-green-deep">
                        <td className="py-3 pr-4">
                          <Link to={`/disputes?order=${row.order_id}`} className="text-green-fresh underline hover:text-amber">
                            {row.order_id}
                          </Link>
                        </td>
                        <td className="py-3 pr-4">{CATEGORY_LABELS[row.category] || row.category}</td>
                        <td className="py-3 pr-4">{formatRupees(row.amount_paise)}</td>
                        <td className="py-3 pr-4">{row.order_status || '—'}</td>
                        <td className="py-3 pr-4">{row.payment_status || '—'}</td>
                        <td className="py-3 pr-4 text-gray-500">
                          {row.created_at ? new Date(row.created_at).toLocaleDateString() : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </main>
      <Footer />
    </div>
  );
};

export default Reconciliation;
