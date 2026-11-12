import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import Navbar from '../components/Navbar';
import Footer from '../components/Footer';
import { getDispute, postDisputeMessage, resolveDispute, setDisputeStatus, uploadDisputeEvidence } from '../services/escrowApi';

// One dispute (Stage 7, module F): status timeline, order summary,
// shipment reference, evidence (image upload + signed-URL thumbnails),
// message thread, and the admin review/resolve section. A 404 (missing
// or not-your-dispute) renders the same honest message — access is never
// distinguished. Evidence thumbnails use the signed url from the API;
// no storage URL is ever constructed here.
const STEPS = ['filed', 'under_review', 'evidence_requested', 'resolved'];
const STEP_LABELS = {
  filed: 'Filed',
  under_review: 'Under review',
  evidence_requested: 'Evidence requested',
  resolved: 'Resolved',
};
const OUTCOMES = ['refund', 'partial_refund', 'replacement', 'rejected'];

const DisputeDetail = () => {
  const { id } = useParams();
  const { user, profile, loading: authLoading } = useAuth();
  const navigate = useNavigate();

  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState('');

  const [evidenceFile, setEvidenceFile] = useState(null);
  const [evidenceError, setEvidenceError] = useState('');
  const [evidenceBusy, setEvidenceBusy] = useState(false);

  const [message, setMessage] = useState('');
  const [messageError, setMessageError] = useState('');
  const [messageBusy, setMessageBusy] = useState(false);

  const [adminError, setAdminError] = useState('');
  const [adminBusy, setAdminBusy] = useState(false);
  const [resolveForm, setResolveForm] = useState({ outcome: '', amountRupees: '', note: '' });

  useEffect(() => {
    if (!user && !authLoading) navigate('/login');
  }, [user, authLoading, navigate]);

  const loadDetail = async () => {
    setLoading(true);
    setError('');
    setNotFound(false);
    try {
      setDetail(await getDispute(id));
    } catch (err) {
      if (err.status === 404 || err.status === 403) setNotFound(true);
      else setError(err.message || 'Could not load this dispute.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (user) void loadDetail();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, id]);

  const dispute = detail?.dispute || {};
  const evidence = detail?.evidence || [];
  const messages = detail?.messages || [];
  const shipment = detail?.shipment || null;
  const isResolved = dispute.status === 'resolved';
  const isAdmin = profile?.role === 'admin';
  const currentStep = STEPS.indexOf(dispute.status);
  // Forward-only: from filed either next step is open; from under_review
  // only evidence_requested; resolved is terminal (no admin actions).
  const nextStatuses = dispute.status === 'filed'
    ? ['under_review', 'evidence_requested']
    : dispute.status === 'under_review' ? ['evidence_requested'] : [];

  const handleEvidence = async (e) => {
    e.preventDefault();
    if (!evidenceFile) { setEvidenceError('Choose an image to upload.'); return; }
    if (!evidenceFile.type.startsWith('image/')) {
      setEvidenceError('Only images can be uploaded as evidence.');
      return;
    }
    setEvidenceBusy(true);
    setEvidenceError('');
    try {
      await uploadDisputeEvidence(id, evidenceFile);
      setEvidenceFile(null);
      e.target.reset();
      await loadDetail();
    } catch (err) {
      setEvidenceError(err.message || 'Could not upload the evidence.');
    } finally {
      setEvidenceBusy(false);
    }
  };

  const handleMessage = async (e) => {
    e.preventDefault();
    if (!message.trim()) { setMessageError('Write a message first.'); return; }
    setMessageBusy(true);
    setMessageError('');
    try {
      await postDisputeMessage(id, { body: message.trim() });
      setMessage('');
      await loadDetail();
    } catch (err) {
      // A resolved dispute 409s — surfaced as-is, never silently dropped.
      setMessageError(err.message || 'Could not send the message.');
    } finally {
      setMessageBusy(false);
    }
  };

  const handleStatus = async (status) => {
    setAdminBusy(true);
    setAdminError('');
    try {
      await setDisputeStatus(id, { status });
      await loadDetail();
    } catch (err) {
      setAdminError(err.message || 'Could not update the status.');
    } finally {
      setAdminBusy(false);
    }
  };

  const handleResolve = async (e) => {
    e.preventDefault();
    if (!resolveForm.outcome) { setAdminError('Choose a resolution outcome.'); return; }
    if (resolveForm.outcome === 'rejected' && !resolveForm.note.trim()) {
      setAdminError('A note is required when rejecting a dispute.');
      return;
    }
    if (resolveForm.outcome === 'partial_refund') {
      const amount = parseFloat(resolveForm.amountRupees);
      if (!Number.isFinite(amount) || amount <= 0) {
        setAdminError('Enter a partial refund amount greater than 0.');
        return;
      }
    }
    setAdminBusy(true);
    setAdminError('');
    try {
      await resolveDispute(id, {
        outcome: resolveForm.outcome,
        ...(resolveForm.outcome === 'partial_refund'
          ? { amount_paise: Math.round(parseFloat(resolveForm.amountRupees) * 100) }
          : {}),
        ...(resolveForm.note.trim() ? { note: resolveForm.note.trim() } : {}),
      });
      setResolveForm({ outcome: '', amountRupees: '', note: '' });
      await loadDetail();
    } catch (err) {
      setAdminError(err.message || 'Could not resolve the dispute.');
    } finally {
      setAdminBusy(false);
    }
  };

  const formatRupees = (paise) => `₹${(Number(paise || 0) / 100).toFixed(2)}`;
  const formatDateTime = (value) => (value ? new Date(value).toLocaleString() : '—');

  return (
    <div className="min-h-screen font-dmsans bg-cream">
      <Navbar />
      <main className="wayfind pt-32 pb-20 px-[5%] max-w-[1400px] mx-auto">
        {loading ? (
          <p className="text-center py-20 text-gray-600 italic">Loading dispute...</p>
        ) : notFound ? (
          <p className="py-20 text-center text-gray-500 font-medium">Dispute not found or you don&apos;t have access.</p>
        ) : error ? (
          <p aria-live="polite" className="py-20 text-center text-red-600">{error}</p>
        ) : (
          <>
            <header className="mb-10">
              <Link to="/disputes" className="text-sm font-bold text-green-mid hover:text-green-deep">← All disputes</Link>
              <h1 className="font-playfair text-4xl font-black text-green-deep mt-2 mb-2">
                {(dispute.category || '').replace('_', ' ') || 'Dispute'}
              </h1>
              <div className="flex flex-wrap items-center gap-2">
                <span className="px-3 py-1 rounded-full text-[10px] font-black uppercase bg-green-fresh/10 text-green-fresh">{STEP_LABELS[dispute.status] || dispute.status}</span>
                {dispute.is_overdue && <span className="px-3 py-1 rounded-full text-[10px] font-black uppercase bg-red-500 text-white">Overdue</span>}
                {dispute.escalated && <span className="px-3 py-1 rounded-full text-[10px] font-black uppercase bg-amber text-white">Escalated</span>}
                <span className="text-sm text-gray-500">SLA: {formatDateTime(dispute.sla_deadline)}</span>
              </div>
            </header>

            <section className="bg-white rounded-[24px] p-6 shadow-sm mb-10">
              <h2 className="font-playfair text-xl font-bold text-green-deep mb-6">Status</h2>
              <div className="flex flex-wrap items-center gap-2">
                {STEPS.map((step, i) => (
                  <React.Fragment key={step}>
                    <span className={`px-4 py-2 rounded-full text-[10px] font-black uppercase ${i < currentStep ? 'bg-green-fresh text-white' : i === currentStep ? 'bg-green-deep text-white shadow-lg' : 'bg-cream text-gray-600'}`}>
                      {i < currentStep ? '✓ ' : ''}{STEP_LABELS[step]}
                    </span>
                    {i < STEPS.length - 1 && <span className="text-gray-300">→</span>}
                  </React.Fragment>
                ))}
              </div>
              {dispute.resolution && (
                <p className="text-sm text-[#4a4a4a] mt-4">Resolution: <span className="font-bold">{dispute.resolution}</span></p>
              )}
              {dispute.resolution_note && (
                <p className="text-sm text-[#4a4a4a] mt-1">{dispute.resolution_note}</p>
              )}
              {dispute.resolution_amount_paise != null && (
                <p className="text-sm text-[#4a4a4a] mt-1">Resolution amount: <span className="font-bold">{formatRupees(dispute.resolution_amount_paise)}</span></p>
              )}
            </section>

            <section className="bg-white rounded-[24px] p-6 shadow-sm mb-10">
              <h2 className="font-playfair text-xl font-bold text-green-deep mb-4">Order</h2>
              <p className="text-sm text-[#4a4a4a]">{dispute.order?.product_title || 'Order'}</p>
              {dispute.order?.total_price_paise != null && (
                <p className="text-sm text-[#4a4a4a]">Total: <span className="font-bold">{formatRupees(dispute.order.total_price_paise)}</span></p>
              )}
              {dispute.description && <p className="text-sm text-[#4a4a4a] mt-2">{dispute.description}</p>}
              {dispute.order_id && (
                <p className="text-sm mt-2">
                  <Link to={`/checkout?orderId=${encodeURIComponent(dispute.order_id)}`} className="font-bold text-green-mid hover:text-green-deep">View order →</Link>
                </p>
              )}
              {shipment && (
                <p className="text-sm mt-2">
                  Shipment: {shipment.status || ''}{' '}
                  <Link to={`/shipments/${shipment.id}/track`} className="font-bold text-green-mid hover:text-green-deep">Track shipment →</Link>
                </p>
              )}
            </section>

            <section className="bg-white rounded-[24px] p-6 shadow-sm mb-10">
              <h2 className="font-playfair text-xl font-bold text-green-deep mb-6">Evidence</h2>
              {evidence.length === 0 ? (
                <p className="text-gray-500 font-medium py-6 text-center">No evidence uploaded yet.</p>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-6 mb-6">
                  {evidence.map((item) => (
                    <div key={item.id}>
                      {item.url && (
                        <img src={item.url} alt="Dispute evidence" className="w-full h-48 object-cover rounded-[20px] shadow-sm" />
                      )}
                      <p className="text-xs text-gray-500 mt-2">{formatDateTime(item.created_at)}</p>
                    </div>
                  ))}
                </div>
              )}
              {!isResolved && (
                <form onSubmit={handleEvidence} className="flex flex-col sm:flex-row gap-3">
                  <input
                    type="file" accept="image/*"
                    aria-label="Dispute evidence file"
                    className="flex-1 bg-cream rounded-xl p-4"
                    onChange={(e) => setEvidenceFile(e.target.files?.[0] || null)}
                  />
                  <button type="submit" disabled={evidenceBusy} className="bg-green-deep text-white font-black px-6 py-4 rounded-xl disabled:opacity-50">
                    {evidenceBusy ? 'Uploading...' : 'Upload Evidence'}
                  </button>
                </form>
              )}
              {evidenceError && <p aria-live="polite" className="text-sm text-red-600 mt-3">{evidenceError}</p>}
            </section>

            <section className="bg-white rounded-[24px] p-6 shadow-sm mb-10">
              <h2 className="font-playfair text-xl font-bold text-green-deep mb-6">Messages</h2>
              {messages.length === 0 ? (
                <p className="text-gray-500 font-medium py-6 text-center">No messages yet.</p>
              ) : (
                <div className="space-y-4 mb-6">
                  {messages.map((m) => (
                    <div key={m.id} className="bg-cream/50 rounded-[20px] p-4">
                      <p className="text-xs font-black uppercase text-gray-600 mb-1">
                        {m.author_role || 'User'} · {formatDateTime(m.created_at)}
                      </p>
                      <p className="text-sm text-[#4a4a4a]">{m.body}</p>
                    </div>
                  ))}
                </div>
              )}
              {!isResolved && (
                <form onSubmit={handleMessage} className="flex flex-col sm:flex-row gap-3">
                  <input
                    className="flex-1 bg-cream rounded-xl p-4"
                    aria-label="Write a message to the dispute thread"
                    placeholder="Write a message…"
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                  />
                  <button type="submit" disabled={messageBusy} className="bg-green-deep text-white font-black px-6 py-4 rounded-xl disabled:opacity-50">
                    {messageBusy ? 'Sending...' : 'Send'}
                  </button>
                </form>
              )}
              {messageError && <p aria-live="polite" className="text-sm text-red-600 mt-3">{messageError}</p>}
              {isResolved && <p className="text-sm text-gray-500 mt-3">This dispute is resolved — the thread is closed.</p>}
            </section>

            {isAdmin && !isResolved && (
              <section className="bg-white rounded-[24px] p-6 shadow-sm mb-10">
                <h2 className="font-playfair text-xl font-bold text-green-deep mb-6">Admin review</h2>
                {nextStatuses.length > 0 && (
                  <div className="flex flex-wrap gap-3 mb-6">
                    {nextStatuses.map((s) => (
                      <button key={s} onClick={() => void handleStatus(s)} disabled={adminBusy} className="bg-cream text-green-deep font-black px-6 py-3 rounded-xl border border-cream-dark disabled:opacity-50">
                        Mark as {STEP_LABELS[s]}
                      </button>
                    ))}
                  </div>
                )}
                <form onSubmit={handleResolve} className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div>
                    <label className="text-xs font-bold uppercase text-gray-600" htmlFor="outcome">Outcome</label>
                    <select id="outcome" required className="w-full bg-cream rounded-xl p-4 mt-1" value={resolveForm.outcome} onChange={(e) => setResolveForm({ ...resolveForm, outcome: e.target.value })}>
                      <option value="">Choose an outcome…</option>
                      {OUTCOMES.map((o) => (
                        <option key={o} value={o}>{o.replace('_', ' ')}</option>
                      ))}
                    </select>
                  </div>
                  {resolveForm.outcome === 'partial_refund' && (
                    <div>
                      <label className="text-xs font-bold uppercase text-gray-600" htmlFor="refund-amount">Refund amount (₹)</label>
                      <input id="refund-amount" required type="number" min="0.01" step="0.01" className="w-full bg-cream rounded-xl p-4 mt-1" placeholder="e.g. 250" value={resolveForm.amountRupees} onChange={(e) => setResolveForm({ ...resolveForm, amountRupees: e.target.value })} />
                    </div>
                  )}
                  <div className="md:col-span-2">
                    <label className="text-xs font-bold uppercase text-gray-600" htmlFor="resolve-note">
                      Note{resolveForm.outcome === 'rejected' ? ' (required for a rejection)' : ''}
                    </label>
                    <textarea id="resolve-note" rows={3} className="w-full bg-cream rounded-xl p-4 mt-1" placeholder="Why this outcome…" value={resolveForm.note} onChange={(e) => setResolveForm({ ...resolveForm, note: e.target.value })} />
                  </div>
                  {adminError && <p aria-live="polite" className="md:col-span-2 text-sm text-red-600">{adminError}</p>}
                  <button type="submit" disabled={adminBusy} className="md:col-span-2 bg-green-deep text-white font-black py-4 rounded-xl disabled:opacity-50">
                    {adminBusy ? 'Resolving...' : 'Resolve Dispute'}
                  </button>
                </form>
              </section>
            )}
          </>
        )}
      </main>
      <Footer />
    </div>
  );
};

export default DisputeDetail;
