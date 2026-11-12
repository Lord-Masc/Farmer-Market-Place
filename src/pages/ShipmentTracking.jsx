import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import Navbar from '../components/Navbar';
import Footer from '../components/Footer';
import DeliveryProof from '../components/DeliveryProof';
import { getShipmentTrack, getMyTransporter, updateShipmentStatus } from '../services/escrowApi';

// Shipment tracking (Stage 6, module E): summary, status history, GPS
// trail, and proof photos from GET /api/shipments/:id/track. The OTP is
// rendered ONLY when the track response carries it — the backend includes
// it for the buyer only, so its presence is the buyer signal; no
// placeholder OTP is ever rendered. The GPS trail is a list of recorded
// points; an empty trail is an honest empty state, never a fake route.
// No map is rendered — there is no maps key in the repo. The transporter
// (own shipment only) updates the status here; 'delivered' is not an
// option — delivery happens only through the OTP + proof flow.
const ShipmentTracking = () => {
  const { id } = useParams();
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();

  const [track, setTrack] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [forbidden, setForbidden] = useState(false);
  const [isTransporter, setIsTransporter] = useState(false);

  const [status, setStatus] = useState('picked_up');
  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');
  const [statusError, setStatusError] = useState('');
  const [statusBusy, setStatusBusy] = useState(false);

  useEffect(() => {
    if (!user && !authLoading) navigate('/login');
  }, [user, authLoading, navigate]);

  const loadTrack = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await getShipmentTrack(id);
      setTrack(data);
      // Own-shipment check: the caller's transporter row (404 → not a
      // transporter) against the shipment's transporter_id.
      try {
        const mine = await getMyTransporter();
        const myId = mine?.transporter?.id || mine?.id;
        setIsTransporter(!!myId && !!data?.shipment?.transporter_id && myId === data.shipment.transporter_id);
      } catch (err) {
        if (err.status !== 404) console.error('Own transporter load failed:', err);
        setIsTransporter(false);
      }
    } catch (err) {
      if (err.status === 403) setForbidden(true);
      else if (err.status === 404) setError('This shipment does not exist.');
      else setError(err.message || 'Could not load this shipment.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (user) void loadTrack();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, id]);

  const handleStatusUpdate = async (e) => {
    e.preventDefault();
    const parsedLat = lat === '' ? null : parseFloat(lat);
    const parsedLng = lng === '' ? null : parseFloat(lng);
    if ((parsedLat !== null && !Number.isFinite(parsedLat)) || (parsedLng !== null && !Number.isFinite(parsedLng))) {
      setStatusError('Enter valid coordinates, or leave them blank.');
      return;
    }
    if ((parsedLat === null) !== (parsedLng === null)) {
      setStatusError('Enter both latitude and longitude, or neither.');
      return;
    }
    setStatusBusy(true);
    setStatusError('');
    try {
      await updateShipmentStatus(id, {
        status,
        ...(parsedLat !== null ? { lat: parsedLat, lng: parsedLng } : {}),
      });
      setLat('');
      setLng('');
      await loadTrack();
    } catch (err) {
      setStatusError(err.message || 'Could not update the status.');
    } finally {
      setStatusBusy(false);
    }
  };

  const shipment = track?.shipment || {};
  const events = track?.events || [];
  const gpsTrail = track?.gps_trail || [];
  const proofPhotos = track?.proof_photos || [];
  // The buyer-only OTP: render it only when the response carries it.
  const buyerOtp = track?.otp ?? null;
  const isDelivered = shipment.status === 'delivered';
  const isCancelled = shipment.status === 'cancelled';
  const formatDateTime = (value) => (value ? new Date(value).toLocaleString() : '—');
  const formatRupees = (paise) => `₹${(Number(paise || 0) / 100).toFixed(2)}`;
  const statusOptions = ['picked_up', 'in_transit', 'out_for_delivery', 'cancelled'];

  return (
    <div className="min-h-screen font-dmsans bg-cream">
      <Navbar />
      <main className="pt-32 pb-20 px-[5%] max-w-[1400px] mx-auto">
        {loading ? (
          <p className="text-center py-20 text-gray-600 italic">Loading shipment...</p>
        ) : forbidden ? (
          <p className="py-20 text-center text-gray-500 font-medium">You don&apos;t have access to this page.</p>
        ) : error ? (
          <p aria-live="polite" className="py-20 text-center text-red-600">{error}</p>
        ) : (
          <>
            <header className="mb-10">
              <h1 className="font-playfair text-4xl font-black text-green-deep mb-2">Shipment</h1>
              {shipment.status && (
                <span className="px-3 py-1 rounded-full text-[10px] font-black uppercase bg-green-fresh/10 text-green-fresh">{shipment.status}</span>
              )}
            </header>

            <section className="bg-white rounded-[24px] p-6 shadow-sm mb-10">
              <h2 className="font-playfair text-xl font-bold text-green-deep mb-4">Summary</h2>
              <p className="text-sm text-[#4a4a4a]">Price: <span className="font-bold">{formatRupees(shipment.price_paise)}</span></p>
              <p className="text-sm text-[#4a4a4a]">Transporter: {shipment.transporter_id ? shipment.transporter_id.slice(0, 8) : '—'}</p>
              <p className="text-sm text-[#4a4a4a]">
                Delivery window: {formatDateTime(shipment.delivery_window_start)} – {formatDateTime(shipment.delivery_window_end)}
              </p>
              {shipment.order_id && (
                <p className="text-sm mt-2">
                  Order:{' '}
                  <Link to={`/checkout?orderId=${encodeURIComponent(shipment.order_id)}`} className="font-bold text-green-mid hover:text-green-deep">View order →</Link>
                </p>
              )}
              {/* Delivery disputes are for the buyer/farmer of the order —
                  never the transporter. The link preselects the order on
                  the disputes page; filing itself is backend-enforced. */}
              {shipment.order_id && !isTransporter && (
                <p className="text-sm mt-2">
                  <Link to={`/disputes?order=${encodeURIComponent(shipment.order_id)}`} className="font-bold text-amber hover:underline">File a delivery dispute →</Link>
                </p>
              )}
            </section>

            {buyerOtp != null && (
              <section className="bg-green-deep text-white rounded-[24px] p-6 shadow-sm mb-10">
                <h2 className="font-playfair text-xl font-bold mb-2">Delivery OTP</h2>
                <p className="text-sm opacity-90 mb-4">Show this OTP to the transporter at handover. Delivery completes only with this OTP and a proof photo.</p>
                <p className="text-3xl font-black tracking-[0.3em]">{buyerOtp}</p>
              </section>
            )}

            {isTransporter && !isDelivered && !isCancelled && (
              <section className="bg-white rounded-[24px] p-6 shadow-sm mb-10">
                <h2 className="font-playfair text-xl font-bold text-green-deep mb-6">Update status</h2>
                <form onSubmit={handleStatusUpdate} className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div>
                    <label className="text-xs font-bold uppercase text-gray-600" htmlFor="status">Status</label>
                    <select id="status" className="w-full bg-cream rounded-xl p-4 mt-1 font-bold" value={status} onChange={(e) => setStatus(e.target.value)}>
                      {statusOptions.map((s) => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs font-bold uppercase text-gray-600" htmlFor="latitude">Latitude (optional — your current coordinates)</label>
                    <input id="latitude" type="number" step="any" className="w-full bg-cream rounded-xl p-4 mt-1" placeholder="e.g. 27.58" value={lat} onChange={(e) => setLat(e.target.value)} />
                  </div>
                  <div>
                    <label className="text-xs font-bold uppercase text-gray-600" htmlFor="longitude">Longitude (optional — your current coordinates)</label>
                    <input id="longitude" type="number" step="any" className="w-full bg-cream rounded-xl p-4 mt-1" placeholder="e.g. 77.70" value={lng} onChange={(e) => setLng(e.target.value)} />
                  </div>
                  {statusError && <p aria-live="polite" className="md:col-span-2 text-sm text-red-600">{statusError}</p>}
                  <button type="submit" disabled={statusBusy} className="md:col-span-2 bg-green-deep text-white font-black py-4 rounded-xl disabled:opacity-50">
                    {statusBusy ? 'Updating...' : 'Update Status'}
                  </button>
                </form>
              </section>
            )}

            {isTransporter && !isDelivered && !isCancelled && (
              <DeliveryProof shipmentId={id} orderId={shipment.order_id} onDelivered={() => void loadTrack()} />
            )}

            <section className="mb-10">
              <h2 className="font-playfair text-2xl font-bold text-green-deep mb-6">Status history</h2>
              {events.length === 0 ? (
                <p className="text-gray-500 font-medium py-10 text-center border-4 border-dashed border-cream-dark rounded-[48px]">No status updates yet.</p>
              ) : (
                <div className="space-y-4">
                  {events.map((event, i) => (
                    <div key={event.id || i} className="bg-white rounded-[24px] p-6 shadow-sm">
                      <p className="font-bold text-green-deep">{event.status}</p>
                      <p className="text-sm text-gray-500">{formatDateTime(event.created_at)}</p>
                      {event.note && <p className="text-sm text-[#4a4a4a] mt-1">{event.note}</p>}
                      {event.lat != null && event.lng != null && (
                        <p className="text-sm text-gray-500 mt-1">Location: {event.lat}, {event.lng}</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="mb-10">
              <h2 className="font-playfair text-2xl font-bold text-green-deep mb-6">GPS trail</h2>
              {gpsTrail.length === 0 ? (
                <p className="text-gray-500 font-medium py-10 text-center border-4 border-dashed border-cream-dark rounded-[48px]">No GPS points recorded yet.</p>
              ) : (
                <div className="overflow-x-auto bg-white rounded-[24px] shadow-sm">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="text-xs font-bold uppercase text-gray-600 border-b border-cream-dark">
                        <th className="p-4">Latitude</th>
                        <th className="p-4">Longitude</th>
                        <th className="p-4">Recorded at</th>
                      </tr>
                    </thead>
                    <tbody>
                      {gpsTrail.map((point, i) => (
                        <tr key={i} className="border-b border-cream-dark last:border-0">
                          <td className="p-4">{point.lat}</td>
                          <td className="p-4">{point.lng}</td>
                          <td className="p-4 text-sm text-gray-500">{formatDateTime(point.at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section>
              <h2 className="font-playfair text-2xl font-bold text-green-deep mb-6">Proof photos</h2>
              {proofPhotos.length === 0 ? (
                <p className="text-gray-500 font-medium py-10 text-center border-4 border-dashed border-cream-dark rounded-[48px]">No proof photos yet.</p>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-6">
                  {proofPhotos.map((url, i) => (
                    <img key={i} src={url} alt={`Delivery proof ${i + 1}`} className="w-full h-64 object-cover rounded-[24px] shadow-sm" />
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

export default ShipmentTracking;
