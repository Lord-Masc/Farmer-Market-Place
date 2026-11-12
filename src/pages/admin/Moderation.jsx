import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import Navbar from '../../components/Navbar';
import Footer from '../../components/Footer';
import { getModerationUser, reinstateUser, suspendUser } from '../../services/escrowApi';

// Moderation (Stage 10, module I): look a user up by UUID or email,
// then suspend or reinstate them. Lookup only — there is no user
// directory here. The server enforces admin-only access; a 403 here
// only changes the message. After an action, the returned suspended_at
// and listings_hidden / listings_restored counts are shown verbatim.
const Moderation = () => {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();

  const [query, setQuery] = useState('');
  const [lookedUp, setLookedUp] = useState(null);
  const [lookupError, setLookupError] = useState('');
  const [lookingUp, setLookingUp] = useState(false);
  const [actionResult, setActionResult] = useState(null);
  const [actionError, setActionError] = useState('');
  const [actionBusy, setActionBusy] = useState(false);
  const [forbidden, setForbidden] = useState(false);

  useEffect(() => {
    if (!user && !authLoading) navigate('/login');
  }, [user, authLoading, navigate]);

  const handleLookup = async (e) => {
    e.preventDefault();
    if (!query.trim()) return;
    setLookingUp(true);
    setLookupError('');
    setActionResult(null);
    setActionError('');
    try {
      const res = await getModerationUser(query.trim());
      setLookedUp(res.user || null);
      if (!res.user) setLookupError('No user found for that id or email.');
    } catch (err) {
      if (err.status === 403) setForbidden(true);
      else {
        // The lookup GET is not in the brief's contract — if Unit A did
        // not ship it, say so and keep the action buttons usable from
        // the entered id (the POSTs return the user themselves).
        setLookedUp(null);
        setLookupError(err.status === 404
          ? 'No user found for that id or email.'
          : err.message || 'Could not look up that user.');
      }
    } finally {
      setLookingUp(false);
    }
  };

  const handleAction = async (action) => {
    const targetId = lookedUp?.id || query.trim();
    if (!targetId) return;
    const verb = action === 'suspend' ? 'Suspend' : 'Reinstate';
    if (!window.confirm(`${verb} this user?`)) return;
    setActionBusy(true);
    setActionResult(null);
    setActionError('');
    try {
      const res = action === 'suspend' ? await suspendUser(targetId) : await reinstateUser(targetId);
      setLookedUp(res.user || lookedUp);
      setActionResult({
        action,
        suspendedAt: res.user?.suspended_at ?? null,
        listingsHidden: res.listings_hidden ?? null,
        listingsRestored: res.listings_restored ?? null,
      });
    } catch (err) {
      if (err.status === 403) setForbidden(true);
      else setActionError(err.message || `Could not ${action} this user.`);
    } finally {
      setActionBusy(false);
    }
  };

  const isSuspended = lookedUp?.suspended_at != null;
  // If the lookup GET is missing on the backend (not in the brief's
  // contract), a UUID-shaped query still offers the actions directly —
  // the POSTs return the user, so the result shows role + suspended
  // state either way. An email-shaped query cannot act without a
  // lookup (there is no id to post to).
  const fallbackId = !lookedUp && /^[0-9a-f-]{36}$/i.test(query.trim())
    ? query.trim()
    : null;

  return (
    <div className="min-h-screen font-dmsans bg-cream">
      <Navbar />
      <main className="pt-32 pb-20 px-[5%] max-w-[1400px] mx-auto">
        <header className="mb-10">
          <h1 className="font-playfair text-4xl font-black text-green-deep mb-2">Moderation</h1>
          <p className="text-[#4a4a4a] text-lg">Look up a user by id or email, then suspend or reinstate them.</p>
        </header>

        {forbidden ? (
          <p className="py-20 text-center text-gray-500 font-medium">You don&apos;t have access to this page.</p>
        ) : (
          <div>
            <section className="bg-white rounded-[24px] p-6 shadow-sm mb-10">
              <form onSubmit={handleLookup} className="flex flex-col md:flex-row gap-2">
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  aria-label="User UUID or email"
                  placeholder="User UUID or email"
                  className="flex-1 bg-cream rounded-xl p-4 outline-none font-bold text-green-deep text-sm"
                />
                <button
                  type="submit"
                  disabled={!query.trim() || lookingUp}
                  className="bg-green-deep text-white font-black px-6 py-4 rounded-xl disabled:opacity-50"
                >
                  {lookingUp ? 'Looking up...' : 'Look up'}
                </button>
              </form>
              {lookupError && <p aria-live="polite" className="text-sm text-red-600 mt-4">{lookupError}</p>}
            </section>

            {(lookedUp || fallbackId) && (
              <section className="bg-white rounded-[24px] p-6 shadow-sm mb-10">
                <p className="font-black text-green-deep">{lookedUp?.id || fallbackId}</p>
                {lookedUp ? (
                  <p className="text-sm font-bold text-gray-500 mt-1">
                    Role: {lookedUp.role || '—'}
                    {' · '}
                    {isSuspended
                      ? `Suspended at ${new Date(lookedUp.suspended_at).toLocaleString()}`
                      : 'Not suspended'}
                  </p>
                ) : (
                  <p className="text-sm font-bold text-gray-500 mt-1">
                    Lookup did not return this user — suspending or reinstating acts on the entered id directly, and the result will show the user&apos;s role and suspended state.
                  </p>
                )}
                <div className="flex flex-wrap gap-2 mt-6">
                  <button
                    onClick={() => handleAction('suspend')}
                    disabled={actionBusy || (lookedUp && isSuspended)}
                    className="bg-red-500 text-white px-5 py-2.5 rounded-full text-sm font-bold shadow-lg hover:bg-red-600 transition-all disabled:opacity-50"
                  >
                    {actionBusy ? 'Working...' : 'Suspend'}
                  </button>
                  <button
                    onClick={() => handleAction('reinstate')}
                    disabled={actionBusy || (lookedUp && !isSuspended)}
                    className="bg-green-deep text-white px-5 py-2.5 rounded-full text-sm font-bold shadow-lg hover:bg-green-mid transition-all disabled:opacity-50"
                  >
                    {actionBusy ? 'Working...' : 'Reinstate'}
                  </button>
                </div>
              </section>
            )}

            {actionResult && (
              <section className="bg-white rounded-[24px] p-6 shadow-sm mb-10">
                <p className="font-bold text-green-deep">
                  {actionResult.action === 'suspend' ? 'User suspended.' : 'User reinstated.'}
                </p>
                <p className="text-sm font-bold text-gray-500 mt-1">
                  Suspended at: {actionResult.suspendedAt ? new Date(actionResult.suspendedAt).toLocaleString() : '—'}
                </p>
                {actionResult.listingsHidden != null && (
                  <p className="text-sm font-bold text-gray-500">Listings hidden: {actionResult.listingsHidden}</p>
                )}
                {actionResult.listingsRestored != null && (
                  <p className="text-sm font-bold text-gray-500">Listings restored: {actionResult.listingsRestored}</p>
                )}
              </section>
            )}
            {actionError && <p aria-live="polite" className="text-sm text-red-600">{actionError}</p>}
          </div>
        )}
      </main>
      <Footer />
    </div>
  );
};

export default Moderation;
