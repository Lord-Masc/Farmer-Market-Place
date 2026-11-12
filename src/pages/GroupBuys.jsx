import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import Navbar from '../components/Navbar';
import Footer from '../components/Footer';
import { listGroupBuys, createGroupBuy, joinGroupBuy } from '../services/escrowApi';

// Group buys (Stage 5, module D): farmers pool quantities of the same crop
// to buy wholesale as one buyer. The list is every group the backend
// returns for the status filter; the create form is farmer-only. The list
// rows carry no per-user joined flag, so a card's join form is hidden
// after this user joins it here (a 409 "already joined" hides it too) —
// the detail page always knows from the participants list.
const GroupBuys = () => {
  const { user, profile, loading: authLoading } = useAuth();
  const navigate = useNavigate();

  const [groups, setGroups] = useState([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [forbidden, setForbidden] = useState(false);
  const [filter, setFilter] = useState('all');

  const [form, setForm] = useState({ crop: '', thresholdQuantity: '', deadline: '', unit: 'kg' });
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  // contribution_quantity typed per group id, join errors per group id, and
  // the groups this user has joined in this session.
  const [joinQty, setJoinQty] = useState({});
  const [joinErrors, setJoinErrors] = useState({});
  const [joinBusy, setJoinBusy] = useState({});
  const [joinedIds, setJoinedIds] = useState([]);

  useEffect(() => {
    if (!user && !authLoading) navigate('/login');
  }, [user, authLoading, navigate]);

  const fetchGroups = async (status) => {
    setListLoading(true);
    setListError('');
    try {
      const res = await listGroupBuys(status);
      setGroups(res.group_buys || res.data || (Array.isArray(res) ? res : []));
    } catch (err) {
      if (err.status === 403) setForbidden(true);
      else setListError(err.message || 'Could not load group buys.');
    } finally {
      setListLoading(false);
    }
  };

  useEffect(() => {
    if (user) void fetchGroups(filter);
  }, [user, filter]);

  const handleCreate = async (e) => {
    e.preventDefault();
    const thresholdQuantity = parseFloat(form.thresholdQuantity);
    if (!form.crop.trim()) {
      setFormError('Enter the crop name.');
      return;
    }
    if (!Number.isFinite(thresholdQuantity) || thresholdQuantity <= 0) {
      setFormError('Enter a threshold quantity greater than 0.');
      return;
    }
    if (!form.deadline) {
      setFormError('Enter a deadline.');
      return;
    }
    if (new Date(form.deadline) <= new Date()) {
      setFormError('The deadline must be in the future.');
      return;
    }

    setSaving(true);
    setFormError('');
    try {
      await createGroupBuy({
        crop: form.crop.trim(),
        threshold_quantity: thresholdQuantity,
        deadline: new Date(form.deadline).toISOString(),
        unit: form.unit,
      });
      setForm({ crop: '', thresholdQuantity: '', deadline: '', unit: 'kg' });
      await fetchGroups(filter);
    } catch (err) {
      setFormError(err.message || 'Could not create the group buy.');
    } finally {
      setSaving(false);
    }
  };

  const handleJoin = async (group) => {
    const contributionQuantity = parseFloat(joinQty[group.id]);
    if (!Number.isFinite(contributionQuantity) || contributionQuantity <= 0) {
      setJoinErrors((prev) => ({ ...prev, [group.id]: 'Enter a quantity greater than 0.' }));
      return;
    }
    setJoinBusy((prev) => ({ ...prev, [group.id]: true }));
    setJoinErrors((prev) => ({ ...prev, [group.id]: '' }));
    try {
      await joinGroupBuy(group.id, { contribution_quantity: contributionQuantity });
      setJoinedIds((prev) => [...prev, group.id]);
      await fetchGroups(filter);
    } catch (err) {
      if (err.status === 409) {
        // Already joined (or the group closed / deadline passed): hide the
        // join form for this card rather than offering a dead action.
        setJoinedIds((prev) => [...prev, group.id]);
        setJoinErrors((prev) => ({ ...prev, [group.id]: err.message || 'You cannot join this group.' }));
      } else {
        setJoinErrors((prev) => ({ ...prev, [group.id]: err.message || 'Could not join the group.' }));
      }
    } finally {
      setJoinBusy((prev) => ({ ...prev, [group.id]: false }));
    }
  };

  const isFarmer = profile?.role === 'farmer';
  const formatDeadline = (value) => (value ? new Date(value).toLocaleString() : '—');
  const progressPct = (group) => {
    const threshold = Number(group.threshold_quantity) || 0;
    if (threshold <= 0) return 0;
    return Math.min(100, ((Number(group.total_quantity) || 0) / threshold) * 100);
  };
  const isPastDeadline = (group) => (group.deadline ? new Date(group.deadline) < new Date() : false);

  const filters = [
    { key: 'all', label: 'All' },
    { key: 'open', label: 'Open' },
    { key: 'closed', label: 'Closed' },
    { key: 'mine', label: 'My groups' },
  ];

  return (
    <div className="min-h-screen font-dmsans bg-cream">
      <Navbar />
      <main className="pt-32 pb-20 px-[5%] max-w-[1400px] mx-auto">
        <header className="mb-10">
          <h1 className="font-playfair text-4xl font-black text-green-deep mb-2">Group buys</h1>
          <p className="text-[#4a4a4a] text-lg">Farmers pool quantities of the same crop and buy wholesale as one buyer.</p>
        </header>

        {forbidden ? (
          <p className="py-20 text-center text-gray-500 font-medium">You don&apos;t have access to this page.</p>
        ) : (
          <>
            {isFarmer && (
              <section className="bg-white rounded-[24px] p-6 shadow-sm mb-10">
                <h2 className="font-playfair text-xl font-bold text-green-deep mb-6">Start a group buy</h2>
                <form onSubmit={handleCreate} className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div>
                    <label className="text-xs font-bold uppercase text-gray-400">Crop</label>
                    <input required className="w-full bg-cream rounded-xl p-4 mt-1" placeholder="Wheat..." value={form.crop} onChange={(e) => setForm({ ...form, crop: e.target.value })} />
                  </div>
                  <div>
                    <label className="text-xs font-bold uppercase text-gray-400">Threshold quantity</label>
                    <input required type="number" min="0.01" step="0.01" className="w-full bg-cream rounded-xl p-4 mt-1" placeholder="1000" value={form.thresholdQuantity} onChange={(e) => setForm({ ...form, thresholdQuantity: e.target.value })} />
                  </div>
                  <div>
                    <label className="text-xs font-bold uppercase text-gray-400">Unit</label>
                    <select className="w-full bg-cream rounded-xl p-4 mt-1" value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })}>
                      <option value="kg">kg</option>
                      <option value="quintal">quintal</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-xs font-bold uppercase text-gray-400">Deadline</label>
                    <input required type="datetime-local" className="w-full bg-cream rounded-xl p-4 mt-1" value={form.deadline} onChange={(e) => setForm({ ...form, deadline: e.target.value })} />
                  </div>
                  {formError && <p className="md:col-span-2 text-sm text-red-600">{formError}</p>}
                  <button type="submit" disabled={saving} className="md:col-span-2 bg-green-deep text-white font-black py-4 rounded-xl disabled:opacity-50">
                    {saving ? 'Creating...' : 'Create Group Buy'}
                  </button>
                </form>
              </section>
            )}

            <section>
              <div className="flex items-center justify-between gap-4 mb-6">
                <h2 className="font-playfair text-2xl font-bold text-green-deep">All group buys</h2>
                <div className="flex gap-2">
                  {filters.map((f) => (
                    <button
                      key={f.key}
                      type="button"
                      onClick={() => setFilter(f.key)}
                      className={`px-4 py-2 rounded-full text-sm font-bold ${filter === f.key ? 'bg-green-deep text-white' : 'bg-white text-green-deep border border-cream-dark'}`}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>

              {listLoading ? (
                <p className="text-center py-10 text-gray-400 italic">Loading group buys...</p>
              ) : listError ? (
                <p className="text-center py-10 text-red-600">{listError}</p>
              ) : groups.length === 0 ? (
                <div className="py-20 text-center border-4 border-dashed border-cream-dark rounded-[48px]">
                  <p className="text-gray-400 font-bold italic text-xl">No group buys yet.</p>
                  <p className="text-gray-400 text-sm mt-2">Start one above and other farmers can pool in.</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {groups.map((group) => {
                    const pct = progressPct(group);
                    const open = group.status === 'open' && !isPastDeadline(group);
                    const alreadyJoined = joinedIds.includes(group.id);
                    return (
                      <div key={group.id} className="bg-white rounded-[24px] p-6 shadow-sm border border-transparent hover:border-green-fresh transition-all">
                        <div className="flex items-start justify-between gap-4 mb-2">
                          <Link to={`/group-buys/${group.id}`} className="font-playfair text-xl font-bold text-green-deep hover:underline">{group.crop}</Link>
                          {group.status && (
                            <span className={`px-3 py-1 rounded-full text-[10px] font-black uppercase ${group.status === 'open' ? 'bg-green-fresh/10 text-green-fresh' : 'bg-cream-dark text-gray-500'}`}>{group.status}</span>
                          )}
                        </div>
                        <p className="text-sm text-[#4a4a4a] mb-1">
                          {group.total_quantity ?? 0} / {group.threshold_quantity} {group.unit} pooled
                        </p>
                        <div className="w-full bg-cream-dark rounded-full h-2 mb-3">
                          <div className="bg-green-fresh h-2 rounded-full" style={{ width: `${pct}%` }} />
                        </div>
                        <p className="text-sm text-[#4a4a4a] mb-1">{group.participant_count ?? 0} participant{(group.participant_count ?? 0) === 1 ? '' : 's'}</p>
                        <p className="text-sm text-gray-500 mb-4">Deadline: {formatDeadline(group.deadline)}</p>
                        {isFarmer && open && !alreadyJoined && (
                          <form
                            onSubmit={(e) => { e.preventDefault(); void handleJoin(group); }}
                            className="border-t border-cream-dark pt-4"
                          >
                            <label className="text-xs font-bold uppercase text-gray-400">Your contribution ({group.unit})</label>
                            <div className="flex gap-3 mt-1">
                              <input
                                required
                                type="number" min="0.01" step="0.01" placeholder="100"
                                className="flex-1 bg-cream rounded-xl p-3"
                                value={joinQty[group.id] || ''}
                                onChange={(e) => setJoinQty((prev) => ({ ...prev, [group.id]: e.target.value }))}
                              />
                              <button type="submit" disabled={joinBusy[group.id]} className="bg-green-deep text-white font-bold px-5 rounded-xl disabled:opacity-50">
                                {joinBusy[group.id] ? 'Joining...' : 'Join'}
                              </button>
                            </div>
                            {joinErrors[group.id] && <p className="text-sm text-red-600 mt-2">{joinErrors[group.id]}</p>}
                          </form>
                        )}
                        {alreadyJoined && (
                          <p className="border-t border-cream-dark pt-4 text-sm font-bold text-green-mid">You have joined this group.</p>
                        )}
                      </div>
                    );
                  })}
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

export default GroupBuys;
