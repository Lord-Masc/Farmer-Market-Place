import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import Navbar from '../components/Navbar';
import Footer from '../components/Footer';
import CropPassportCard from '../components/CropPassportCard';
import { publicPassportFetch } from '../services/escrowApi';

// Public farmer passport page. The backend only returns a passport for a
// verified farmer; a 404 (farmer missing or unverified) is shown as the same
// honest empty state — verification status is never distinguished here.
const FarmerProfile = () => {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setNotFound(false);
      setError('');
      try {
        setData(await publicPassportFetch(`/farmers/${id}/passport`));
      } catch (err) {
        if (err.status === 404) setNotFound(true);
        else setError(err.message || 'Unable to load this farmer passport.');
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, [id]);

  const farmer = data?.farmer;
  const stats = data?.stats;
  const lots = data?.lots || [];
  const location = [farmer?.city, farmer?.state].filter(Boolean).join(', ');

  // Rates arrive as fractions (0–1); tolerate a backend that already sends
  // a percent so a value can never render as e.g. 8500%.
  const formatRate = (rate) => (rate == null ? 'Not enough data yet' : `${Math.round(rate > 1 ? rate : rate * 100)}%`);

  // Real disputes (Stage 7): the view renames the refund-flow proxy to
  // refund_rate and adds real dispute_count + dispute_rate. The "Refund
  // rate" line below reads refund_rate (falling back to dispute_rate for
  // the pre-Stage-7 shape, where dispute_rate WAS the proxy). The real-
  // dispute line renders only when at least one real dispute exists.
  const realDisputeCount = stats?.dispute_count ?? null;
  const realDisputeRate = stats?.dispute_rate ?? null;

  return (
    <div className="min-h-screen font-dmsans bg-cream">
      <Navbar />
      <main className="wayfind pt-32 pb-20 px-[5%] max-w-[1400px] mx-auto">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-20">
            <div className="w-12 h-12 border-4 border-green-mid border-t-transparent rounded-full animate-spin mb-4"></div>
            <p className="text-green-mid font-medium italic">Loading farmer passport...</p>
          </div>
        ) : notFound ? (
          <div className="py-20 text-center">
            <span className="text-6xl mb-6 block">🌾</span>
            <p className="text-gray-500 font-medium">This farmer has not published a verified passport yet.</p>
          </div>
        ) : error ? (
          <div className="py-20 text-center">
            <p className="text-red-600 font-medium">{error}</p>
          </div>
        ) : (
          <>
            <header className="mb-10">
              <div className="mb-4 inline-flex items-center gap-2 bg-green-fresh/10 text-green-deep text-xs font-black px-4 py-2 rounded-full border border-green-fresh/20">✓ Verified farmer</div>
              <h1 className="font-playfair text-4xl font-black text-green-deep mb-2">
                {[farmer?.first_name, farmer?.last_name].filter(Boolean).join(' ') || 'Farmer'}
              </h1>
              {location && <p className="text-[#4a4a4a] text-lg">📍 {location}</p>}
            </header>

            <section className="bg-white rounded-[24px] p-6 shadow-sm mb-10">
              <h2 className="font-playfair text-xl font-bold text-green-deep mb-4">Track record</h2>
              {!stats ? (
                <p className="text-gray-500 font-medium">No orders yet</p>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
                  <div>
                    <p className="text-xs text-gray-600 font-bold uppercase tracking-wider mb-1">Deliveries</p>
                    <p className="text-2xl font-black text-green-deep">{stats.deliveries ?? 0}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-600 font-bold uppercase tracking-wider mb-1">On-time rate</p>
                    <p className="text-2xl font-black text-green-deep">{formatRate(stats.on_time_rate)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-600 font-bold uppercase tracking-wider mb-1">Refund rate (share of paid orders refunded)</p>
                    <p className="text-2xl font-black text-green-deep">{formatRate(stats.refund_rate ?? stats.dispute_rate)}</p>
                  </div>
                  {realDisputeCount > 0 && (
                    <div>
                      <p className="text-xs text-gray-600 font-bold uppercase tracking-wider mb-1">Dispute rate (real disputes)</p>
                      <p className="text-2xl font-black text-green-deep">{formatRate(realDisputeRate)}</p>
                      <p className="text-xs text-gray-500 mt-1">{realDisputeCount} dispute{realDisputeCount === 1 ? '' : 's'}</p>
                    </div>
                  )}
                </div>
              )}
            </section>

            <section>
              <h2 className="font-playfair text-2xl font-bold text-green-deep mb-6">Crop passports</h2>
              {lots.length === 0 ? (
                <p className="text-gray-500 font-medium py-10 text-center">No crop lots published yet.</p>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
                  {lots.map((lot) => (
                    <CropPassportCard key={lot.id || lot.product_id || lot.crop} lot={lot} />
                  ))}
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

export default FarmerProfile;
