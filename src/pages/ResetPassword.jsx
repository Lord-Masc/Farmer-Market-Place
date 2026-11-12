import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '../services/supabase';

// Password reset landing page: the recovery link from Supabase establishes
// a session on arrival (supabase-js reads the URL hash), then the user sets
// a new password here. A stale or already-used link fails updateUser, and
// the error stays generic.
const ResetPassword = () => {
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleReset = async (e) => {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setLoading(true);
    const { error: updateError } = await supabase.auth.updateUser({ password });
    setLoading(false);
    if (updateError) {
      setError('This reset link is invalid or has expired. Request a new one from the login page.');
      return;
    }
    setDone(true);
    setTimeout(() => navigate('/login'), 2000);
  };

  return (
    <div className="min-h-screen font-dmsans flex items-center justify-center bg-cream px-4">
      <div className="w-full max-w-[400px] bg-white rounded-[24px] p-8 sm:p-10 shadow-[0_20px_50px_rgba(26,58,42,0.08)]">
        <div className="text-center mb-8">
          <Link to="/" className="font-playfair text-[1.8rem] font-black cursor-pointer inline-block mb-6">
            <span className="text-green-deep">Agro</span>
            <span className="text-amber">Connect</span>
          </Link>
          <h2 className="font-playfair text-2xl font-bold text-green-deep mb-2">Set a new password</h2>
          <p className="text-[#4a4a4a] text-sm">Choose a new password for your account.</p>
        </div>

        {error && (
          <div className="mb-6 p-3 bg-red-50 border border-red-200 text-red-600 text-sm rounded-xl font-medium text-center">
            {error}
          </div>
        )}

        {done ? (
          <div className="mb-6 p-3 bg-green-50 border border-green-200 text-green-700 text-sm rounded-xl font-medium text-center">
            Password updated. Taking you to the login page…
          </div>
        ) : (
          <form className="space-y-5" onSubmit={handleReset}>
            <div className="space-y-1.5 text-left">
              <label className="text-sm font-medium text-green-deep block">New password</label>
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 8 characters"
                className="w-full bg-cream-dark rounded-xl px-4 py-3 text-sm text-[#4a4a4a] border border-transparent focus:border-green-fresh focus:bg-white focus:outline-none transition-all placeholder-gray-400"
              />
            </div>
            <div className="space-y-1.5 text-left">
              <label className="text-sm font-medium text-green-deep block">Confirm new password</label>
              <input
                type="password"
                required
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="Repeat the new password"
                className="w-full bg-cream-dark rounded-xl px-4 py-3 text-sm text-[#4a4a4a] border border-transparent focus:border-green-fresh focus:bg-white focus:outline-none transition-all placeholder-gray-400"
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className={`w-full bg-green-deep text-white rounded-xl py-3.5 text-sm font-bold shadow-md hover:bg-green-mid transition-all mt-2 ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              {loading ? 'Updating…' : 'Update password'}
            </button>
          </form>
        )}

        <div className="mt-8 pt-6 border-t border-gray-100 text-center text-sm">
          <Link to="/login" className="font-bold text-green-deep hover:text-amber transition-colors">
            Back to login
          </Link>
        </div>
      </div>
    </div>
  );
};

export default ResetPassword;
