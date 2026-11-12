import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import Navbar from '../../components/Navbar';
import Footer from '../../components/Footer';
import PlatformMetrics from '../../components/PlatformMetrics';
import { adminMetricsFetch } from '../../services/escrowApi';

// Platform metrics (Stage 10, module I): the full admin metrics table.
// The server enforces admin-only access; a 403 here only changes the
// message. Every metric renders with its unit; nulls render as
// "No data yet", never an invented 0.
const Metrics = () => {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();

  const [metrics, setMetrics] = useState(null);
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
        const res = await adminMetricsFetch();
        setMetrics(res.metrics || null);
      } catch (err) {
        if (err.status === 403) setForbidden(true);
        else setError(err.message || 'Could not load platform metrics.');
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, [user]);

  return (
    <div className="min-h-screen font-dmsans bg-cream">
      <Navbar />
      <main className="wayfind pt-32 pb-20 px-[5%] max-w-[1400px] mx-auto">
        <header className="mb-10">
          <h1 className="font-playfair text-4xl font-black text-green-deep mb-2">Platform metrics</h1>
          <p className="text-[#4a4a4a] text-lg">Orders, GMV, farmer realisation vs mandi, disputes, delivery, group selling, and notifications.</p>
        </header>

        {forbidden ? (
          <p className="py-20 text-center text-gray-500 font-medium">You don&apos;t have access to this page.</p>
        ) : loading ? (
          <p className="text-center py-20 text-gray-600 italic">Loading metrics...</p>
        ) : error ? (
          <p className="py-20 text-center text-red-600">{error}</p>
        ) : (
          <PlatformMetrics metrics={metrics} />
        )}
      </main>
      <Footer />
    </div>
  );
};

export default Metrics;
