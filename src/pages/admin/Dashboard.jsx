import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import Navbar from '../../components/Navbar';
import Footer from '../../components/Footer';
import { adminFetch, adminMetricsFetch, adminReconciliationFetch, getDisputeStats } from '../../services/escrowApi';

// Admin dashboard (Stage 10, module I): verification queue + dispute
// queue links with counts, stuck-money summary, and key metric cards.
// The server enforces admin-only access; a 403 here only changes the
// message. Amounts arrive in paise and render as rupees; a null metric
// renders "No data yet", never an invented 0.
const formatRupees = (paise) =>
  paise == null ? 'No data yet' : `₹${(Number(paise) / 100).toFixed(2)}`;

const AdminDashboard = () => {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();

  const [metrics, setMetrics] = useState(null);
  const [stuck, setStuck] = useState([]);
  const [pendingVerifications, setPendingVerifications] = useState(null);
  const [openDisputes, setOpenDisputes] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [forbidden, setForbidden] = useState(false);

  useEffect(() => {
    if (!user && !authLoading) navigate('/login');
  }, [user, authLoading, navigate]);

  useEffect(() => {
    if (!user) return;
    const load = async () => {
      setLoading(true);
      setError('');
      try {
        const [metricsRes, reconRes, verificationsRes, disputeStats] = await Promise.all([
          adminMetricsFetch(),
          adminReconciliationFetch(),
          adminFetch('/verifications?status=pending&page=1&pageSize=1'),
          getDisputeStats().catch(() => null),
        ]);
        setMetrics(metricsRes.metrics || null);
        setStuck(reconRes.stuck || []);
        setPendingVerifications(
          verificationsRes.pagination?.total ?? (verificationsRes.data || []).length,
        );
        setOpenDisputes(disputeStats?.open ?? null);
      } catch (err) {
        if (err.status === 403) setForbidden(true);
        else setError(err.message || 'Could not load the admin dashboard.');
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, [user]);

  const stuckTotalPaise = stuck.reduce((sum, row) => sum + Number(row.amount_paise || 0), 0);

  return (
    <div className="min-h-screen font-dmsans bg-cream">
      <Navbar />
      <main className="wayfind pt-32 pb-20 px-[5%] max-w-[1400px] mx-auto">
        <header className="mb-10">
          <h1 className="font-playfair text-4xl font-black text-green-deep mb-2">Admin dashboard</h1>
          <p className="text-[#4a4a4a] text-lg">Verification and dispute queues, stuck money, and platform metrics.</p>
        </header>

        {forbidden ? (
          <p className="py-20 text-center text-gray-500 font-medium">You don&apos;t have access to this page.</p>
        ) : loading ? (
          <p className="text-center py-20 text-gray-600 italic">Loading admin dashboard...</p>
        ) : error ? (
          <p className="py-20 text-center text-red-600">{error}</p>
        ) : (
          <div>
            <section className="grid grid-cols-2 sm:grid-cols-4 gap-6 mb-10">
              <div className="bg-white rounded-[24px] p-6 shadow-sm">
                <p className="text-xs text-gray-600 font-bold uppercase tracking-wider mb-1">Total orders</p>
                <p className="text-2xl font-black text-green-deep">{metrics?.total_orders ?? 'No data yet'}</p>
              </div>
              <div className="bg-white rounded-[24px] p-6 shadow-sm">
                <p className="text-xs text-gray-600 font-bold uppercase tracking-wider mb-1">GMV</p>
                <p className="text-2xl font-black text-green-deep">{formatRupees(metrics?.gmv_paise)}</p>
              </div>
              <div className="bg-white rounded-[24px] p-6 shadow-sm">
                <p className="text-xs text-gray-600 font-bold uppercase tracking-wider mb-1">Disputes</p>
                <p className="text-2xl font-black text-green-deep">{metrics?.dispute_count ?? 'No data yet'}</p>
              </div>
              <div className="bg-white rounded-[24px] p-6 shadow-sm">
                <p className="text-xs text-gray-600 font-bold uppercase tracking-wider mb-1">Stuck money</p>
                <p className="text-2xl font-black text-green-deep">
                  {stuck.length === 0 ? '₹0.00' : formatRupees(stuckTotalPaise)}
                </p>
                <p className="text-sm font-bold text-gray-500 mt-1">
                  {stuck.length === 0 ? 'Nothing needs reconciling.' : `${stuck.length} stuck ${stuck.length === 1 ? 'order' : 'orders'}`}
                </p>
              </div>
            </section>

            <section className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <Link to="/admin/verifications" className="block bg-white rounded-[24px] p-6 shadow-sm hover:border-green-fresh border border-transparent transition-all">
                <h2 className="font-playfair text-xl font-bold text-green-deep mb-2">Verification queue</h2>
                <p className="font-bold text-gray-500">
                  {pendingVerifications == null ? 'Pending count unavailable.' : `${pendingVerifications} pending ${pendingVerifications === 1 ? 'submission' : 'submissions'}`}
                </p>
              </Link>
              <Link to="/disputes" className="block bg-white rounded-[24px] p-6 shadow-sm hover:border-green-fresh border border-transparent transition-all">
                <h2 className="font-playfair text-xl font-bold text-green-deep mb-2">Dispute queue</h2>
                <p className="font-bold text-gray-500">
                  {openDisputes == null ? 'Open count unavailable.' : `${openDisputes} open ${openDisputes === 1 ? 'dispute' : 'disputes'}`}
                </p>
              </Link>
              <Link to="/admin/reconciliation" className="block bg-white rounded-[24px] p-6 shadow-sm hover:border-green-fresh border border-transparent transition-all">
                <h2 className="font-playfair text-xl font-bold text-green-deep mb-2">Stuck money</h2>
                <p className="font-bold text-gray-500">
                  {stuck.length === 0 ? 'No stuck money — nothing needs reconciling.' : `${stuck.length} stuck ${stuck.length === 1 ? 'order' : 'orders'} · ${formatRupees(stuckTotalPaise)}`}
                </p>
              </Link>
              <Link to="/admin/metrics" className="block bg-white rounded-[24px] p-6 shadow-sm hover:border-green-fresh border border-transparent transition-all">
                <h2 className="font-playfair text-xl font-bold text-green-deep mb-2">Platform metrics</h2>
                <p className="font-bold text-gray-500">Orders, GMV, realisation vs mandi, group selling, notifications.</p>
              </Link>
            </section>
          </div>
        )}
      </main>
      <Footer />
    </div>
  );
};

export default AdminDashboard;
