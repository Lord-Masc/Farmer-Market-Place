import React, { useEffect, useState } from 'react';
import Navbar from '../components/Navbar';
import Footer from '../components/Footer';
import PlatformMetrics from '../components/PlatformMetrics';
import { transparencyFetch } from '../services/escrowApi';

// Public transparency dashboard (Stage 10, module I): the same
// aggregated platform metrics as the admin page, no login required.
// Aggregated only — no names, emails, phones, addresses, or per-user
// rows anywhere on this page. Nulls render as "No data yet", never an
// invented 0.
const Transparency = () => {
  const [metrics, setMetrics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setError('');
      try {
        const res = await transparencyFetch();
        setMetrics(res.metrics || null);
      } catch (err) {
        setError(err.message || 'Could not load transparency metrics.');
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, []);

  return (
    <div className="min-h-screen font-dmsans bg-cream">
      <Navbar />
      <main className="pt-32 pb-20 px-[5%] max-w-[1400px] mx-auto">
        <header className="mb-10">
          <h1 className="font-playfair text-4xl font-black text-green-deep mb-2">Transparency</h1>
          <p className="text-[#4a4a4a] text-lg">Aggregated platform metrics — how the marketplace is doing for farmers. No personal data is shown here.</p>
        </header>

        {loading ? (
          <p className="text-center py-20 text-gray-400 italic">Loading transparency metrics...</p>
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

export default Transparency;
