import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import NotificationBell from './NotificationBell';

const Navbar = () => {
  const { user, profile, signOut } = useAuth();
  const navigate = useNavigate();
  const [dropdownOpen, setDropdownOpen] = useState(false);

  const dashboardPath = profile?.role === 'farmer' ? '/farmer-dashboard' : '/buyer-dashboard';
  const initials = profile?.first_name
    ? `${profile.first_name[0]}${profile.last_name?.[0] || ''}`.toUpperCase()
    : user?.email?.[0]?.toUpperCase() || '?';

  const handleSignOut = async () => {
    await signOut();
    setDropdownOpen(false);
    navigate('/');
  };

  return (
    <nav className="fixed top-0 left-0 w-full z-[100] animate-slideDown flex items-center justify-between px-[5%] py-[1.2rem] bg-cream/92 backdrop-blur-[12px] border-b border-amber/20">
      <Link to="/" className="font-playfair text-[1.7rem] font-black cursor-pointer">
        <span className="text-green-deep">Agro</span>
        <span className="text-amber">Connect</span>
      </Link>

      <div className="hidden lg:flex items-center gap-[2.5rem]">
        {['Features', 'How it Works', 'For Farmers/Buyers', 'Stories'].map((item) => (
          <a
            key={item}
            href={`#${item.toLowerCase().replace(/[\s/]+/g, '-')}`}
            className="font-dmsans text-[0.9rem] font-medium text-[#4a4a4a] hover:text-green-mid transition-colors duration-200"
          >
            {item}
          </a>
        ))}
      </div>

      <div className="flex items-center gap-3">
        {user ? (
          /* ── LOGGED IN STATE ── */
          <div className="flex items-center gap-3">
            {/* Notification bell (Stage 9): count from the API only. */}
            <NotificationBell />

            {/* Dashboard Button */}
            <Link
              to={dashboardPath}
              className="bg-green-deep text-white rounded-full px-[1.4rem] py-[0.6rem] font-dmsans text-[0.88rem] font-semibold shadow-md hover:bg-green-mid hover:-translate-y-[1px] transition-all duration-300"
            >
              🌾 Dashboard
            </Link>

            {/* Avatar + Dropdown */}
            <div className="relative">
              <button
                onClick={() => setDropdownOpen(prev => !prev)}
                className="flex items-center gap-2 bg-white border-2 border-green-fresh/30 rounded-full pl-1 pr-3 py-1 hover:border-green-fresh transition-all duration-200 shadow-sm"
              >
                <div className="w-8 h-8 rounded-full bg-green-deep text-white flex items-center justify-center text-sm font-black">
                  {initials}
                </div>
                <span className="font-dmsans text-[0.82rem] font-bold text-green-deep hidden sm:block">
                  {profile?.first_name || 'User'}
                </span>
                <span className="text-gray-400 text-xs">{dropdownOpen ? '▲' : '▼'}</span>
              </button>

              {/* Dropdown Menu */}
              {dropdownOpen && (
                <div className="absolute right-0 top-[calc(100%+8px)] bg-white rounded-2xl shadow-xl border border-cream-dark p-2 min-w-[180px] animate-fadeIn z-50">
                  <div className="px-3 py-2 border-b border-cream-dark mb-1">
                    <p className="text-xs font-black text-green-deep uppercase tracking-widest">{profile?.role || 'User'}</p>
                    <p className="text-sm font-bold text-gray-700 truncate">{profile?.first_name} {profile?.last_name}</p>
                  </div>
                  <Link
                    to={dashboardPath}
                    onClick={() => setDropdownOpen(false)}
                    className="flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-semibold text-green-deep hover:bg-cream transition-colors"
                  >
                    📊 My Dashboard
                  </Link>
                  {profile?.role === 'buyer' && (
                    <Link
                      to="/requirements"
                      onClick={() => setDropdownOpen(false)}
                      className="flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-semibold text-green-deep hover:bg-cream transition-colors"
                    >
                      📝 Requirements
                    </Link>
                  )}
                  {profile?.role === 'farmer' && (
                    <Link
                      to="/group-buys"
                      onClick={() => setDropdownOpen(false)}
                      className="flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-semibold text-green-deep hover:bg-cream transition-colors"
                    >
                      🤝 Group buys
                    </Link>
                  )}
                  {profile?.role === 'transporter' && (
                    <Link
                      to="/transporters"
                      onClick={() => setDropdownOpen(false)}
                      className="flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-semibold text-green-deep hover:bg-cream transition-colors"
                    >
                      🚚 Transporters
                    </Link>
                  )}
                  {(profile?.role === 'buyer' || profile?.role === 'farmer' || profile?.role === 'admin') && (
                    <Link
                      to="/disputes"
                      onClick={() => setDropdownOpen(false)}
                      className="flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-semibold text-green-deep hover:bg-cream transition-colors"
                    >
                      ⚖️ Disputes
                    </Link>
                  )}
                  <Link
                    to="/assistant"
                    onClick={() => setDropdownOpen(false)}
                    className="flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-semibold text-green-deep hover:bg-cream transition-colors"
                  >
                    💬 सहायक (Assistant)
                  </Link>
                  <Link
                    to="/notifications"
                    onClick={() => setDropdownOpen(false)}
                    className="flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-semibold text-green-deep hover:bg-cream transition-colors"
                  >
                    🔔 Notifications
                  </Link>
                  {profile?.role === 'admin' && (
                    <Link
                      to="/admin/verifications"
                      onClick={() => setDropdownOpen(false)}
                      className="flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-semibold text-green-deep hover:bg-cream transition-colors"
                    >
                      🛡️ Admin review
                    </Link>
                  )}
                  <button
                    onClick={handleSignOut}
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-semibold text-red-500 hover:bg-red-50 transition-colors mt-1"
                  >
                    🚪 Sign Out
                  </button>
                </div>
              )}
            </div>
          </div>
        ) : (
          /* ── LOGGED OUT STATE ── */
          <>
            <Link to="/login" className="hidden sm:block border-[1.5px] border-green-mid text-green-mid rounded-full px-[1.4rem] py-[0.55rem] font-dmsans text-[0.88rem] font-medium hover:bg-green-mid hover:text-white transition-all duration-300">
              Sign In
            </Link>
            <Link to="/signup" className="bg-green-deep text-white rounded-full px-[1.5rem] py-[0.6rem] font-dmsans text-[0.88rem] font-semibold shadow-lg hover:bg-green-mid hover:-translate-y-[1px] hover:shadow-[0_6px_20px_rgba(45,106,79,0.35)] transition-all duration-300">
              Get Started
            </Link>
          </>
        )}
      </div>
    </nav>
  );
};

export default Navbar;
