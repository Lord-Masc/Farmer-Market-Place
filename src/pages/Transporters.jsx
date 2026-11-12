import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import Navbar from '../components/Navbar';
import Footer from '../components/Footer';
import { listTransporters, getMyTransporter, registerTransporter } from '../services/escrowApi';

// Transporters (Stage 6, module E): the list of verified transporters and
// the registration form. A new registration is verification_status
// 'pending' until an admin approves it in the Stage 1 queue — until then
// the transporter is not listed. Rates are entered in rupees and sent as
// integer paise; at least one rate (per km or flat) is required, same
// validation as the backend. No fake transporters — an empty list renders
// an honest empty state.
const Transporters = () => {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();

  const [transporters, setTransporters] = useState([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [forbidden, setForbidden] = useState(false);

  const [mine, setMine] = useState(null);
  const [mineLoading, setMineLoading] = useState(true);

  const [form, setForm] = useState({
    vehicleType: '', vehicleNumber: '', serviceAreas: '', ratePerKm: '', flatRate: '',
  });
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!user && !authLoading) navigate('/login');
  }, [user, authLoading, navigate]);

  const fetchTransporters = async () => {
    setListLoading(true);
    setListError('');
    try {
      const res = await listTransporters();
      setTransporters(res.transporters || res.data || (Array.isArray(res) ? res : []));
    } catch (err) {
      if (err.status === 403) setForbidden(true);
      else setListError(err.message || 'Could not load transporters.');
    } finally {
      setListLoading(false);
    }
  };

  const fetchMine = async () => {
    setMineLoading(true);
    try {
      const res = await getMyTransporter();
      setMine(res.transporter || res);
    } catch (err) {
      // 404 means no transporter row for this user — the form stays.
      if (err.status !== 404) console.error('Own transporter load failed:', err);
      setMine(null);
    } finally {
      setMineLoading(false);
    }
  };

  useEffect(() => {
    if (user) {
      void fetchTransporters();
      void fetchMine();
    }
  }, [user]);

  const handleRegister = async (e) => {
    e.preventDefault();
    const serviceAreas = form.serviceAreas.split(',').map((a) => a.trim()).filter(Boolean);
    const ratePerKm = form.ratePerKm === '' ? null : parseFloat(form.ratePerKm);
    const flatRate = form.flatRate === '' ? null : parseFloat(form.flatRate);
    if (!form.vehicleType.trim()) {
      setFormError('Enter the vehicle type.');
      return;
    }
    if (!form.vehicleNumber.trim()) {
      setFormError('Enter the vehicle number.');
      return;
    }
    if (serviceAreas.length === 0) {
      setFormError('Enter at least one service area.');
      return;
    }
    if ((ratePerKm === null || !Number.isFinite(ratePerKm) || ratePerKm <= 0)
      && (flatRate === null || !Number.isFinite(flatRate) || flatRate <= 0)) {
      setFormError('Enter a rate per km or a flat rate greater than 0 (or both).');
      return;
    }

    setSaving(true);
    setFormError('');
    try {
      await registerTransporter({
        vehicle_type: form.vehicleType.trim(),
        vehicle_number: form.vehicleNumber.trim(),
        service_areas: serviceAreas,
        ...(ratePerKm !== null ? { rate_paise_per_km: Math.round(ratePerKm * 100) } : {}),
        ...(flatRate !== null ? { flat_rate_paise: Math.round(flatRate * 100) } : {}),
      });
      setForm({ vehicleType: '', vehicleNumber: '', serviceAreas: '', ratePerKm: '', flatRate: '' });
      await fetchMine();
    } catch (err) {
      setFormError(err.message || 'Could not register as a transporter.');
    } finally {
      setSaving(false);
    }
  };

  const formatRupees = (paise) => `₹${(Number(paise || 0) / 100).toFixed(2)}`;
  const verificationStatus = mine?.verification_status;

  return (
    <div className="min-h-screen font-dmsans bg-cream">
      <Navbar />
      <main className="pt-32 pb-20 px-[5%] max-w-[1400px] mx-auto">
        <header className="mb-10">
          <h1 className="font-playfair text-4xl font-black text-green-deep mb-2">Transporters</h1>
          <p className="text-[#4a4a4a] text-lg">Verified transporters who can deliver orders — and where to register as one.</p>
        </header>

        {forbidden ? (
          <p className="py-20 text-center text-gray-500 font-medium">You don&apos;t have access to this page.</p>
        ) : (
          <>
            {!mineLoading && mine && (
              <section className="bg-white rounded-[24px] p-6 shadow-sm mb-10">
                <h2 className="font-playfair text-xl font-bold text-green-deep mb-2">Your transporter registration</h2>
                {verificationStatus === 'pending' ? (
                  <p className="text-sm text-gray-500">Verification pending — an admin reviews it. Your listing appears here once approved.</p>
                ) : verificationStatus === 'verified' ? (
                  <p className="text-sm font-bold text-green-mid">You are a verified transporter.</p>
                ) : verificationStatus === 'rejected' ? (
                  <p aria-live="polite" className="text-sm text-red-600">Your transporter registration was rejected.</p>
                ) : (
                  <p className="text-sm text-gray-500">Status: {verificationStatus || '—'}</p>
                )}
                <p className="text-sm text-[#4a4a4a] mt-2">
                  {mine.vehicle_type} · {mine.vehicle_number}
                  {mine.service_areas?.length ? ` · Serves: ${mine.service_areas.join(', ')}` : ''}
                </p>
                <p className="text-sm text-[#4a4a4a]">
                  {mine.rate_paise_per_km != null ? `${formatRupees(mine.rate_paise_per_km)}/km` : ''}
                  {mine.rate_paise_per_km != null && mine.flat_rate_paise != null ? ' · ' : ''}
                  {mine.flat_rate_paise != null ? `${formatRupees(mine.flat_rate_paise)} flat` : ''}
                </p>
              </section>
            )}

            {!mineLoading && !mine && (
              <section className="bg-white rounded-[24px] p-6 shadow-sm mb-10">
                <h2 className="font-playfair text-xl font-bold text-green-deep mb-6">Register as a transporter</h2>
                <form onSubmit={handleRegister} className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div>
                    <label className="text-xs font-bold uppercase text-gray-600" htmlFor="vehicle-type">Vehicle type</label>
                    <input id="vehicle-type" required className="w-full bg-cream rounded-xl p-4 mt-1" placeholder="Truck, tempo, tractor..." value={form.vehicleType} onChange={(e) => setForm({ ...form, vehicleType: e.target.value })} />
                  </div>
                  <div>
                    <label className="text-xs font-bold uppercase text-gray-600" htmlFor="vehicle-number">Vehicle number</label>
                    <input id="vehicle-number" required className="w-full bg-cream rounded-xl p-4 mt-1" placeholder="UP81 AB 1234" value={form.vehicleNumber} onChange={(e) => setForm({ ...form, vehicleNumber: e.target.value })} />
                  </div>
                  <div className="md:col-span-2">
                    <label className="text-xs font-bold uppercase text-gray-600" htmlFor="service-areas">Service areas (comma-separated)</label>
                    <input id="service-areas" required className="w-full bg-cream rounded-xl p-4 mt-1" placeholder="Mathura, Agra, Bulandshahr" value={form.serviceAreas} onChange={(e) => setForm({ ...form, serviceAreas: e.target.value })} />
                  </div>
                  <div>
                    <label className="text-xs font-bold uppercase text-gray-600" htmlFor="rate-per-km">Rate per km (₹, optional if flat rate given)</label>
                    <input id="rate-per-km" type="number" min="0.01" step="0.01" className="w-full bg-cream rounded-xl p-4 mt-1" placeholder="12" value={form.ratePerKm} onChange={(e) => setForm({ ...form, ratePerKm: e.target.value })} />
                  </div>
                  <div>
                    <label className="text-xs font-bold uppercase text-gray-600" htmlFor="flat-rate">Flat rate (₹, optional if per-km rate given)</label>
                    <input id="flat-rate" type="number" min="0.01" step="0.01" className="w-full bg-cream rounded-xl p-4 mt-1" placeholder="500" value={form.flatRate} onChange={(e) => setForm({ ...form, flatRate: e.target.value })} />
                  </div>
                  {formError && <p aria-live="polite" className="md:col-span-2 text-sm text-red-600">{formError}</p>}
                  <button type="submit" disabled={saving} className="md:col-span-2 bg-green-deep text-white font-black py-4 rounded-xl disabled:opacity-50">
                    {saving ? 'Registering...' : 'Register as Transporter'}
                  </button>
                </form>
              </section>
            )}

            <section>
              <h2 className="font-playfair text-2xl font-bold text-green-deep mb-6">Verified transporters</h2>
              {listLoading ? (
                <p className="text-center py-10 text-gray-600 italic">Loading transporters...</p>
              ) : listError ? (
                <p aria-live="polite" className="text-center py-10 text-red-600">{listError}</p>
              ) : transporters.length === 0 ? (
                <div className="py-20 text-center border-4 border-dashed border-cream-dark rounded-[48px]">
                  <p className="text-gray-600 font-bold italic text-xl">No verified transporters yet.</p>
                  <p className="text-gray-600 text-sm mt-2">Register above — listings appear here once an admin approves them.</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {transporters.map((t) => (
                    <div key={t.id} className="bg-white rounded-[24px] p-6 shadow-sm border border-transparent hover:border-green-fresh transition-all">
                      <h3 className="font-playfair text-xl font-bold text-green-deep mb-1">{t.vehicle_type}</h3>
                      <p className="text-sm text-[#4a4a4a] mb-1">{t.vehicle_number}</p>
                      <p className="text-sm text-[#4a4a4a] mb-1">
                        Serves: {(t.service_areas || []).join(', ') || '—'}
                      </p>
                      <p className="text-sm font-bold text-green-mid">
                        {t.rate_paise_per_km != null ? `${formatRupees(t.rate_paise_per_km)}/km` : ''}
                        {t.rate_paise_per_km != null && t.flat_rate_paise != null ? ' · ' : ''}
                        {t.flat_rate_paise != null ? `${formatRupees(t.flat_rate_paise)} flat` : ''}
                      </p>
                    </div>
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

export default Transporters;
