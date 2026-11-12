import React, { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { listNotifications } from '../services/escrowApi';

// Notification bell (Stage 9, module H). The badge count comes from
// GET /api/notifications (unread_count) only — never from Supabase
// Realtime (the dashboards use Realtime for orders; this bell does
// not). One fetch per mount/navigation, no interval. A failed fetch
// hides the badge instead of showing a stale or invented count, and
// 0 unread shows the bell with no badge.
const NotificationBell = () => {
  const [unreadCount, setUnreadCount] = useState(null);
  const location = useLocation();

  useEffect(() => {
    let cancelled = false;
    listNotifications({ unreadOnly: true, limit: 1 })
      .then((res) => { if (!cancelled) setUnreadCount(res?.unread_count ?? 0); })
      .catch(() => { if (!cancelled) setUnreadCount(null); });
    return () => { cancelled = true; };
  }, [location.pathname]);

  return (
    <Link
      to="/notifications"
      aria-label={unreadCount ? `${unreadCount} unread notifications` : 'Notifications'}
      className="wayfind relative flex items-center justify-center w-10 h-10 bg-white border-2 border-green-fresh/30 rounded-full hover:border-green-fresh transition-all duration-200 shadow-sm"
    >
      <span className="text-lg">🔔</span>
      {unreadCount > 0 && (
        <span className="absolute -top-1 -right-1 min-w-[1.25rem] h-5 px-1 rounded-full bg-red-500 text-white text-[0.7rem] font-black flex items-center justify-center">
          {unreadCount > 99 ? '99+' : unreadCount}
        </span>
      )}
    </Link>
  );
};

export default NotificationBell;
