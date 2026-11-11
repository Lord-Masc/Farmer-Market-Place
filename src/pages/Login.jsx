import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '../services/supabase';
import { validateEmail } from '../utils/helper';

const Login = () => {
  const navigate = useNavigate();
  const [role, setRole] = useState('buyer'); // 'farmer' or 'buyer'
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const handleLogin = async (e) => {
    e.preventDefault();
    setError(null);
    
    if (!agreed) {
      setError('You must agree to the terms to sign in.');
      return;
    }

    setLoading(true);
    try {
      if (!validateEmail(identifier)) {
        setError('Please enter a valid email address.');
        setLoading(false);
        return;
      }

      const { data: authData, error: signInError } = await supabase.auth.signInWithPassword({
        email: identifier,
        password,
      });

      if (signInError) {
        // Keep wrong-password failures indistinguishable from an unknown
        // identifier: same generic message either way.
        if (signInError.message.includes('Invalid login credentials')) {
          setError('Invalid email or password.');
        } else {
          setError(signInError.message);
        }
        setLoading(false);
        return;
      }

      // Final Role matching check after Auth success
      const { data: profileTest, error: profileTestError } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', authData.user.id)
        .eq('role', role)
        .single();
      
      if (profileTestError || !profileTest) {
        setError(`You do not have a ${role} profile associated with this account.`);
        setLoading(false);
        return;
      }

      navigate(`/${role}-dashboard`);
    } catch (err) {
      console.error(err);
      setError('An unexpected error occurred. Please try again.');
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen font-dmsans flex items-center justify-center bg-cream px-4 relative overflow-hidden">
      {/* Background blobs matching the hero section */}
      <div className="absolute top-[-10%] left-[-10%] w-[400px] h-[400px] bg-green-fresh blur-[80px] opacity-15 rounded-full animate-float z-0" />
      <div className="absolute bottom-[-10%] right-[-5%] w-[350px] h-[350px] bg-amber blur-[80px] opacity-15 rounded-full animate-float z-0" style={{ animationDelay: '-3s' }} />

      <div className="w-full max-w-[400px] bg-white rounded-[24px] p-8 sm:p-10 shadow-[0_20px_50px_rgba(26,58,42,0.08)] relative z-10 animate-fadeIn">
        
        <div className="text-center mb-8">
          <Link to="/" className="font-playfair text-[1.8rem] font-black cursor-pointer inline-block mb-6">
            <span className="text-green-deep">Agro</span>
            <span className="text-amber">Connect</span>
          </Link>
          <h2 className="font-playfair text-2xl font-bold text-green-deep mb-2">{role.charAt(0).toUpperCase() + role.slice(1)} Login</h2>
          <p className="text-[#4a4a4a] text-sm">Access your {role} dashboard</p>
        </div>

        {/* Role Selector */}
        <div className="flex bg-cream-dark p-1 rounded-xl mb-8">
          <button 
            type="button"
            onClick={() => setRole('buyer')}
            className={`flex-1 py-2.5 text-sm font-bold rounded-lg transition-all duration-300 ${role === 'buyer' ? 'bg-white text-green-deep shadow-sm' : 'text-gray-500'}`}
          >
            🛒 Buyer
          </button>
          <button 
            type="button"
            onClick={() => setRole('farmer')}
            className={`flex-1 py-2.5 text-sm font-bold rounded-lg transition-all duration-300 ${role === 'farmer' ? 'bg-white text-green-deep shadow-sm' : 'text-gray-500'}`}
          >
            👨‍🌾 Farmer
          </button>
        </div>

        {error && (
          <div className="mb-6 p-3 bg-red-50 border border-red-200 text-red-600 text-sm rounded-xl font-medium text-center">
            {error}
          </div>
        )}

        <form className="space-y-5" onSubmit={handleLogin}>
          <div className="space-y-1.5 text-left">
            <label htmlFor="identifier" className="text-sm font-medium text-green-deep block">Email Address</label>
            <input 
              id="identifier"
              type="text" 
              required
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              placeholder="name@example.com" 
              className="w-full bg-cream-dark rounded-xl px-4 py-3 text-sm text-[#4a4a4a] border border-transparent focus:border-green-fresh focus:bg-white focus:outline-none transition-all duration-300 placeholder-gray-400"
            />
          </div>

          <div className="space-y-1.5 text-left">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-green-deep block">Password</label>
              <a href="#" className="text-xs font-semibold text-amber hover:text-amber-light transition-colors">Forgot?</a>
            </div>
            <div className="relative">
              <input 
                type={showPassword ? "text" : "password"} 
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••" 
                className="w-full bg-cream-dark rounded-xl px-4 py-3 text-sm text-[#4a4a4a] border border-transparent focus:border-green-fresh focus:bg-white focus:outline-none transition-all duration-300 placeholder-gray-400 pr-12"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-4 top-1/2 -translate-y-1/2 text-lg opacity-50 hover:opacity-100 transition-opacity"
              >
                {showPassword ? '👁️' : '🔒'}
              </button>
            </div>
          </div>

          <div className="flex items-start gap-2 mt-2">
            <input 
              type="checkbox" 
              required 
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
              className="mt-1 accent-green-deep" 
            />
            <span className="text-xs text-gray-500 leading-normal">
              I agree to the <a href="#" className="text-green-deep font-bold hover:underline">Terms of Service</a>
            </span>
          </div>

          <button 
            type="submit" 
            disabled={loading || !agreed}
            className={`w-full bg-green-deep text-white rounded-xl py-3.5 text-sm font-bold shadow-md hover:bg-green-mid transition-all duration-300 mt-2 ${loading || !agreed ? 'opacity-50 cursor-not-allowed' : 'hover:-translate-y-[1px] hover:shadow-[0_6px_20px_rgba(45,106,79,0.35)]'}`}
          >
            {loading ? 'Signing In...' : 'Sign In'}
          </button>
        </form>

        <div className="mt-8 pt-6 border-t border-gray-100 text-center text-sm">
          <p className="text-gray-500">
            Don't have an account?{' '}
            <Link to="/signup" className="font-bold text-green-deep hover:text-amber transition-colors duration-200 ml-1">
              Create Account
            </Link>
          </p>
        </div>
      </div>
      
      {/* Absolute back button */}
      <Link to="/" className="absolute top-6 left-6 flex items-center gap-2 text-green-deep text-sm font-semibold hover:text-amber transition-colors duration-200 z-20">
        <span>←</span> Back to Home
      </Link>
    </div>
  );
};

export default Login;
