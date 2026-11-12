import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import Navbar from '../components/Navbar';
import Footer from '../components/Footer';
import {
  getNotificationPreferences,
  listNotifications,
  markNotificationRead,
  updateNotificationPreferences,
} from '../services/escrowApi';

// Notifications inbox + preferences (Stage 9, module H). The list
// renders exactly what GET /api/notifications returns — newest first,
// no fake/demo notifications. Delivery status is shown honestly: a
// 'failed' delivery shows as failed, never as sent; a 'deferred' one
// shows as deferred with its next attempt time when the backend
// supplies one. Email/SMS channels are selectable, but no provider is
// configured yet — the preferences hint says so plainly, and those
// notifications stay in the inbox until one is set up.
const PAGE_SIZE = 20;

const EVENT_TYPES = [
  'order_created', 'order_confirmed', 'order_declined', 'order_paid',
  'order_shipped', 'order_completed', 'refund_requested', 'refunded',
  'offer_received', 'offer_countered', 'offer_accepted', 'offer_rejected',
  'group_joined', 'group_closed', 'settlement_ready',
  'shipment_booked', 'shipment_status', 'shipment_delivered',
  'dispute_filed', 'dispute_status', 'dispute_resolved',
  'verification_submitted', 'verification_approved', 'verification_rejected',
];

const EVENT_LABELS = {
  order_created: 'Order created',
  order_confirmed: 'Order confirmed',
  order_declined: 'Order declined',
  order_paid: 'Order paid',
  order_shipped: 'Order shipped',
  order_completed: 'Order completed',
  refund_requested: 'Refund requested',
  refunded: 'Refunded',
  offer_received: 'Offer received',
  offer_countered: 'Offer countered',
  offer_accepted: 'Offer accepted',
  offer_rejected: 'Offer rejected',
  group_joined: 'Group joined',
  group_closed: 'Group closed',
  settlement_ready: 'Settlement ready',
  shipment_booked: 'Shipment booked',
  shipment_status: 'Shipment update',
  shipment_delivered: 'Shipment delivered',
  dispute_filed: 'Dispute filed',
  dispute_status: 'Dispute update',
  dispute_resolved: 'Dispute resolved',
  verification_submitted: 'Verification submitted',
  verification_approved: 'Verification approved',
  verification_rejected: 'Verification rejected',
};

const CHANNELS = ['in_app', 'email', 'sms'];
const CHANNEL_LABELS = { in_app: 'In-app', email: 'Email', sms: 'SMS' };
const DELIVERY_LABELS = {
  sent: 'Sent', delivered: 'Delivered', failed: 'Failed',
  deferred: 'Deferred', pending: 'Pending',
};

// Defaults for event types the user has never set (per contract):
// enabled, in-app only, Hindi, no quiet hours.
const defaultPreference = (eventType) => ({
  event_type: eventType,
  enabled: true,
  channels: ['in_app'],
  language: 'hi',
  quiet_start: '',
  quiet_end: '',
});

const formatRelativeTime = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 7 * 86400) return `${Math.floor(seconds / 86400)}d ago`;
  return date.toLocaleString();
};

// The contract does not name the deferred next-attempt field, so read
// it defensively from the payload first, then the row — and show
// nothing extra when it is absent, rather than inventing a time.
const nextAttemptTime = (notification) => (
  notification?.payload?.next_attempt_at
  || notification?.payload?.next_attempt
  || notification?.payload?.retry_at
  || notification?.next_attempt_at
  || null
);

const Notifications = () => {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();

  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [markingId, setMarkingId] = useState(null);

  const [preferences, setPreferences] = useState(null);
  const [prefsLoading, setPrefsLoading] = useState(true);
  const [prefsError, setPrefsError] = useState('');
  const [prefsSaving, setPrefsSaving] = useState(false);
  const [prefsSaved, setPrefsSaved] = useState('');

  useEffect(() => {
    if (!user && !authLoading) navigate('/login');
  }, [user, authLoading, navigate]);

  const fetchNotifications = async (offset, onlyUnread, append) => {
    if (append) setLoadingMore(true);
    else { setListLoading(true); setListError(''); }
    try {
      const res = await listNotifications({ unreadOnly: onlyUnread, limit: PAGE_SIZE, offset });
      const rows = res.notifications || (Array.isArray(res) ? res : []);
      setNotifications((prev) => (append ? [...prev, ...rows] : rows));
      setUnreadCount(res.unread_count ?? 0);
      setHasMore(rows.length === PAGE_SIZE);
    } catch (err) {
      // 401/403 renders the backend's message as plain text — no
      // session-expired behaviour exists in this codebase.
      if (!append) setListError(err.message || 'Could not load your notifications.');
    } finally {
      setListLoading(false);
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    if (user) void fetchNotifications(0, unreadOnly, false);
  }, [user, unreadOnly]);

  useEffect(() => {
    if (!user) return;
    getNotificationPreferences()
      .then((res) => {
        const rows = res.preferences || (Array.isArray(res) ? res : []);
        const byType = {};
        rows.forEach((row) => { if (row?.event_type) byType[row.event_type] = row; });
        // Missing rows render the contract defaults; only rows the
        // user has set come from the backend.
        setPreferences(EVENT_TYPES.map((type) => {
          const row = byType[type];
          if (!row) return defaultPreference(type);
          return {
            event_type: type,
            enabled: row.enabled !== false,
            channels: Array.isArray(row.channels) && row.channels.length > 0 ? row.channels : ['in_app'],
            language: row.language === 'en' ? 'en' : 'hi',
            quiet_start: row.quiet_start || '',
            quiet_end: row.quiet_end || '',
          };
        }));
      })
      .catch((err) => setPrefsError(err.message || 'Could not load your preferences.'))
      .finally(() => setPrefsLoading(false));
  }, [user]);

  const handleMarkRead = async (notification) => {
    if (notification.read_at || markingId) return;
    setMarkingId(notification.id);
    try {
      const res = await markNotificationRead(notification.id);
      const readAt = res?.notification?.read_at || new Date().toISOString();
      setNotifications((prev) => prev.map((n) => (n.id === notification.id ? { ...n, read_at: readAt } : n)));
      setUnreadCount((prev) => Math.max(0, prev - 1));
    } catch (err) {
      setListError(err.message || 'Could not mark the notification as read.');
    } finally {
      setMarkingId(null);
    }
  };

  const updatePreference = (eventType, patch) => {
    setPrefsSaved('');
    setPreferences((prev) => prev.map((p) => (p.event_type === eventType ? { ...p, ...patch } : p)));
  };

  const toggleChannel = (eventType, channel) => {
    const pref = preferences.find((p) => p.event_type === eventType);
    if (!pref) return;
    const channels = pref.channels.includes(channel)
      ? pref.channels.filter((c) => c !== channel)
      : [...pref.channels, channel];
    updatePreference(eventType, { channels: channels.length > 0 ? channels : ['in_app'] });
  };

  const handleSavePreferences = async (e) => {
    e.preventDefault();
    if (!preferences) return;
    setPrefsSaving(true);
    setPrefsError('');
    setPrefsSaved('');
    try {
      const res = await updateNotificationPreferences(
        preferences.map((p) => ({
          event_type: p.event_type,
          enabled: p.enabled,
          channels: p.channels,
          language: p.language,
          quiet_start: p.quiet_start || null,
          quiet_end: p.quiet_end || null,
        })),
      );
      if (Array.isArray(res?.preferences)) {
        const byType = {};
        res.preferences.forEach((row) => { if (row?.event_type) byType[row.event_type] = row; });
        setPreferences((prev) => prev.map((p) => {
          const row = byType[p.event_type];
          return row ? {
            event_type: p.event_type,
            enabled: row.enabled !== false,
            channels: Array.isArray(row.channels) && row.channels.length > 0 ? row.channels : ['in_app'],
            language: row.language === 'en' ? 'en' : 'hi',
            quiet_start: row.quiet_start || '',
            quiet_end: row.quiet_end || '',
          } : p;
        }));
      }
      setPrefsSaved('Preferences saved.');
    } catch (err) {
      setPrefsError(err.message || 'Could not save your preferences.');
    } finally {
      setPrefsSaving(false);
    }
  };

  return (
    <div className="min-h-screen font-dmsans bg-cream">
      <Navbar />
      <main className="pt-32 pb-20 px-[5%] max-w-[1400px] mx-auto">
        <header className="mb-10">
          <h1 className="font-playfair text-4xl font-black text-green-deep mb-2">Notifications</h1>
          <p className="text-[#4a4a4a] text-lg">
            Your inbox for orders, offers, shipments, disputes and verification — newest first.
            {unreadCount > 0 ? ` ${unreadCount} unread.` : ' Nothing unread.'}
          </p>
        </header>

        <div className="flex flex-wrap items-center gap-3 mb-6">
          <button
            type="button"
            onClick={() => setUnreadOnly((prev) => !prev)}
            className={`px-4 py-1.5 rounded-lg text-[10px] font-black uppercase transition-all ${unreadOnly ? 'bg-green-deep text-white shadow-lg' : 'bg-white text-gray-600 hover:bg-amber/10 hover:text-amber'}`}
          >
            {unreadOnly ? '✓ Unread only' : 'Unread only'}
          </button>
          <button
            type="button"
            onClick={() => void fetchNotifications(0, unreadOnly, false)}
            disabled={listLoading}
            className="px-4 py-1.5 rounded-lg text-[10px] font-black uppercase bg-white text-gray-600 hover:bg-amber/10 hover:text-amber disabled:opacity-50"
          >
            Refresh
          </button>
        </div>

        {listLoading ? (
          <p className="text-center py-20 text-gray-600 italic">Loading notifications...</p>
        ) : listError ? (
          <p aria-live="polite" className="py-20 text-center text-red-600">{listError}</p>
        ) : notifications.length === 0 ? (
          <p className="text-gray-500 font-medium py-10 text-center border-4 border-dashed border-cream-dark rounded-[48px]">No notifications yet.</p>
        ) : (
          <div className="space-y-4 mb-6">
            {notifications.map((n) => {
              const unread = !n.read_at;
              const nextAttempt = n.delivery_status === 'deferred' ? nextAttemptTime(n) : null;
              return (
                <article
                  key={n.id}
                  onClick={() => void handleMarkRead(n)}
                  className={`bg-white rounded-[24px] p-6 shadow-sm border transition-all cursor-pointer ${unread ? 'border-green-fresh/50' : 'border-transparent'}`}
                >
                  <div className="flex flex-wrap items-center gap-2 mb-2">
                    {unread && <span className="px-3 py-1 rounded-full text-[10px] font-black uppercase bg-green-deep text-white">Unread</span>}
                    <span className="px-3 py-1 rounded-full text-[10px] font-black uppercase bg-green-fresh/10 text-green-fresh">{EVENT_LABELS[n.type] || n.type}</span>
                    {n.channel && (
                      <span className="px-3 py-1 rounded-full text-[10px] font-black uppercase bg-cream text-gray-500">{CHANNEL_LABELS[n.channel] || n.channel}</span>
                    )}
                    {n.delivery_status && (
                      <span className={`px-3 py-1 rounded-full text-[10px] font-black uppercase ${n.delivery_status === 'failed' ? 'bg-red-500 text-white' : n.delivery_status === 'deferred' ? 'bg-amber text-white' : 'bg-cream text-gray-500'}`}>
                        {DELIVERY_LABELS[n.delivery_status] || n.delivery_status}
                        {nextAttempt ? ` · next attempt ${formatRelativeTime(nextAttempt)}` : ''}
                      </span>
                    )}
                  </div>
                  <p className={`font-bold text-green-deep ${unread ? 'font-black' : ''}`}>{n.title || EVENT_LABELS[n.type] || n.type}</p>
                  {n.body && <p className="text-sm text-gray-500 mt-1 whitespace-pre-wrap">{n.body}</p>}
                  <p className="text-xs text-gray-600 mt-2">
                    {formatRelativeTime(n.created_at)}
                    {n.created_at && ` · ${new Date(n.created_at).toLocaleString()}`}
                    {unread && markingId === n.id ? ' · Marking as read…' : ''}
                  </p>
                </article>
              );
            })}
          </div>
        )}

        {hasMore && notifications.length > 0 && (
          <div className="text-center mb-10">
            <button
              type="button"
              onClick={() => void fetchNotifications(notifications.length, unreadOnly, true)}
              disabled={loadingMore}
              className="bg-green-deep text-white font-black px-6 py-3 rounded-xl disabled:opacity-50"
            >
              {loadingMore ? 'Loading…' : 'Load more'}
            </button>
          </div>
        )}

        <section className="bg-white rounded-[24px] p-6 shadow-sm">
          <h2 className="font-playfair text-xl font-bold text-green-deep mb-2">Notification preferences</h2>
          <p className="text-sm text-gray-500 mb-6">
            Choose which events notify you, on which channels, in which language, and during which hours.
            Email and SMS delivery is not configured yet — notifications on those channels will stay in
            your inbox until a provider is set up. Nothing here implies an email or SMS was sent.
          </p>
          {prefsLoading ? (
            <p className="text-center py-10 text-gray-600 italic">Loading preferences...</p>
          ) : prefsError && !preferences ? (
            <p aria-live="polite" className="text-red-600">{prefsError}</p>
          ) : (
            <form onSubmit={handleSavePreferences}>
              <div className="space-y-4">
                {preferences.map((pref) => (
                  <div key={pref.event_type} className="border border-cream-dark rounded-2xl p-4">
                    <div className="flex flex-wrap items-center gap-3 mb-3">
                      <label className="flex items-center gap-2 font-bold text-green-deep">
                        <input
                          type="checkbox"
                          checked={pref.enabled}
                          onChange={(e) => updatePreference(pref.event_type, { enabled: e.target.checked })}
                        />
                        {EVENT_LABELS[pref.event_type] || pref.event_type}
                      </label>
                      <span className="text-xs text-gray-600">{pref.event_type}</span>
                    </div>
                    <div className="flex flex-wrap gap-x-6 gap-y-3 text-sm text-gray-600">
                      <div className="flex flex-wrap gap-3">
                        {CHANNELS.map((channel) => (
                          <label key={channel} className="flex items-center gap-1.5">
                            <input
                              type="checkbox"
                              checked={pref.channels.includes(channel)}
                              disabled={!pref.enabled}
                              onChange={() => toggleChannel(pref.event_type, channel)}
                            />
                            {CHANNEL_LABELS[channel]}
                          </label>
                        ))}
                      </div>
                      <label className="flex items-center gap-2">
                        Language
                        <select
                          className="bg-cream rounded-lg px-2 py-1"
                          value={pref.language}
                          disabled={!pref.enabled}
                          onChange={(e) => updatePreference(pref.event_type, { language: e.target.value })}
                        >
                          <option value="hi">हिन्दी</option>
                          <option value="en">English</option>
                        </select>
                      </label>
                      <label className="flex items-center gap-2">
                        Quiet from (UTC)
                        <input
                          type="time"
                          className="bg-cream rounded-lg px-2 py-1"
                          value={pref.quiet_start}
                          disabled={!pref.enabled}
                          onChange={(e) => updatePreference(pref.event_type, { quiet_start: e.target.value })}
                        />
                      </label>
                      <label className="flex items-center gap-2">
                        to
                        <input
                          type="time"
                          className="bg-cream rounded-lg px-2 py-1"
                          value={pref.quiet_end}
                          disabled={!pref.enabled}
                          onChange={(e) => updatePreference(pref.event_type, { quiet_end: e.target.value })}
                        />
                      </label>
                    </div>
                  </div>
                ))}
              </div>
              {prefsError && <p aria-live="polite" className="text-sm text-red-600 mt-4">{prefsError}</p>}
              {prefsSaved && <p className="text-sm text-green-700 mt-4">{prefsSaved}</p>}
              <button type="submit" disabled={prefsSaving} className="mt-6 bg-green-deep text-white font-black px-6 py-3 rounded-xl disabled:opacity-50">
                {prefsSaving ? 'Saving...' : 'Save preferences'}
              </button>
            </form>
          )}
        </section>
      </main>
      <Footer />
    </div>
  );
};

export default Notifications;
