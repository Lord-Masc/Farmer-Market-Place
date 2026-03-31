import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '../services/supabase';

const Login = () => {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const handleLogin = async (e) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (signInError) {
        setError(signInError.message);
        setLoading(false);
        return;
      }

      navigate('/dashboard');
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
          <h2 className="font-playfair text-2xl font-bold text-green-deep mb-2">Welcome Back</h2>
          <p className="text-[#4a4a4a] text-sm">Sign in to your account</p>
        </div>

        {error && (
          <div className="mb-6 p-3 bg-red-50 border border-red-200 text-red-600 text-sm rounded-xl font-medium text-center">
            {error}
          </div>
        )}

        <form className="space-y-5" onSubmit={handleLogin}>
          <div className="space-y-1.5 text-left">
            <label className="text-sm font-medium text-green-deep block">Email Address</label>
            <input 
              type="email" 
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@example.com" 
              className="w-full bg-cream-dark rounded-xl px-4 py-3 text-sm text-[#4a4a4a] border border-transparent focus:border-green-fresh focus:bg-white focus:outline-none transition-all duration-300 placeholder-gray-400"
            />
          </div>

          <div className="space-y-1.5 text-left">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-green-deep block">Password</label>
              <a href="#" className="text-xs font-semibold text-amber hover:text-amber-light transition-colors">Forgot?</a>
            </div>
            <input 
              type="password" 
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••" 
              className="w-full bg-cream-dark rounded-xl px-4 py-3 text-sm text-[#4a4a4a] border border-transparent focus:border-green-fresh focus:bg-white focus:outline-none transition-all duration-300 placeholder-gray-400"
            />
          </div>

          <button 
            type="submit" 
            disabled={loading}
            className={`w-full bg-green-deep text-white rounded-xl py-3.5 text-sm font-bold shadow-md hover:bg-green-mid transition-all duration-300 mt-2 ${loading ? 'opacity-70 cursor-not-allowed' : 'hover:-translate-y-[1px] hover:shadow-[0_6px_20px_rgba(45,106,79,0.35)]'}`}
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
