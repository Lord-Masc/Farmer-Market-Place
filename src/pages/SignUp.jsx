import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '../services/supabase';

const SignUp = () => {
  const [role, setRole] = useState('buyer'); // 'farmer' or 'buyer'
  const navigate = useNavigate();

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [state, setState] = useState('');
  
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const handleSignUp = async (e) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      // Sign up the user in Supabase Auth
      const { data, error: signUpError } = await supabase.auth.signUp({
        email,
        password,
      });

      if (signUpError) {
        if (signUpError.message.includes('already registered')) {
          setError('An account with this email already exists. Please log in instead.');
        } else {
          setError(signUpError.message);
        }
        setLoading(false);
        return;
      }

      if (data?.user) {
        // Insert user details into the profiles table
        const { error: profileError } = await supabase
          .from('profiles')
          .insert([
            {
              id: data.user.id,
              first_name: firstName,
              last_name: lastName,
              phone_number: phone,
              role: role,
              state: role === 'farmer' ? state : null,
            }
          ]);
          
        if (profileError) {
          console.error("Profile creation error:", profileError);
          // If inserting into profiles fails due to duplication, it's already caught by Auth usually
        }
        
        // Redirect to dashboard after successful signup and profile creation
        navigate('/dashboard');
      }

    } catch (err) {
      console.error(err);
      setError('An unexpected error occurred. Please try again.');
    } finally {
      if(!data?.user) {
         setLoading(false);
      }
    }
  };

  return (
    <div className="min-h-screen font-dmsans flex items-center justify-center bg-cream px-4 py-12 relative overflow-hidden">
      {/* Background blobs matching the hero section */}
      <div className="absolute top-[-10%] right-[-10%] w-[400px] h-[400px] bg-green-fresh blur-[80px] opacity-15 rounded-full animate-float z-0" />
      <div className="absolute bottom-[-10%] left-[-5%] w-[350px] h-[350px] bg-amber blur-[80px] opacity-15 rounded-full animate-float z-0" style={{ animationDelay: '-3s' }} />

      <div className="w-full max-w-[480px] bg-white rounded-[24px] p-8 sm:p-10 shadow-[0_20px_50px_rgba(26,58,42,0.08)] relative z-10 animate-fadeIn">
        
        <div className="text-center mb-8">
          <Link to="/" className="font-playfair text-[1.8rem] font-black cursor-pointer inline-block mb-6">
            <span className="text-green-deep">Agro</span>
            <span className="text-amber">Connect</span>
          </Link>
          <h2 className="font-playfair text-2xl font-bold text-green-deep mb-2">Create Your Account</h2>
          <p className="text-[#4a4a4a] text-sm">Join the network connecting field to fork</p>
        </div>

        {/* Role Selector */}
        <div className="flex bg-cream-dark p-1 rounded-xl mb-8">
          <button 
            type="button"
            onClick={() => setRole('buyer')}
            className={`flex-1 py-2.5 text-sm font-bold rounded-lg transition-all duration-300 ${role === 'buyer' ? 'bg-white text-green-deep shadow-sm' : 'text-gray-500'}`}
          >
            🛒 I'm a Buyer
          </button>
          <button 
            type="button"
            onClick={() => setRole('farmer')}
            className={`flex-1 py-2.5 text-sm font-bold rounded-lg transition-all duration-300 ${role === 'farmer' ? 'bg-white text-green-deep shadow-sm' : 'text-gray-500'}`}
          >
            👨‍🌾 I'm a Farmer
          </button>
        </div>

        {error && (
          <div className="mb-6 p-3 bg-red-50 border border-red-200 text-red-600 text-sm rounded-xl font-medium text-center">
            {error}
          </div>
        )}

        <form className="grid grid-cols-1 sm:grid-cols-2 gap-5" onSubmit={handleSignUp}>
          <div className="space-y-1.5 text-left">
            <label className="text-sm font-medium text-green-deep block">First Name</label>
            <input 
              type="text" 
              required
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              placeholder="First Name" 
              className="w-full bg-cream-dark rounded-xl px-4 py-3 text-sm text-[#4a4a4a] border border-transparent focus:border-green-fresh focus:bg-white focus:outline-none transition-all duration-300 placeholder-gray-400"
            />
          </div>

          <div className="space-y-1.5 text-left">
            <label className="text-sm font-medium text-green-deep block">Last Name</label>
            <input 
              type="text" 
              required
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              placeholder="Last Name" 
              className="w-full bg-cream-dark rounded-xl px-4 py-3 text-sm text-[#4a4a4a] border border-transparent focus:border-green-fresh focus:bg-white focus:outline-none transition-all duration-300 placeholder-gray-400"
            />
          </div>

          <div className="space-y-1.5 text-left sm:col-span-2">
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

          <div className="space-y-1.5 text-left sm:col-span-2">
            <label className="text-sm font-medium text-green-deep block">Phone Number</label>
            <div className="flex gap-2">
              <span className="bg-cream-dark rounded-xl px-3 py-3 text-sm text-gray-500 font-medium">+91</span>
              <input 
                type="tel" 
                required
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="10-digit mobile number" 
                className="flex-1 bg-cream-dark rounded-xl px-4 py-3 text-sm text-[#4a4a4a] border border-transparent focus:border-green-fresh focus:bg-white focus:outline-none transition-all duration-300 placeholder-gray-400"
              />
            </div>
          </div>

          <div className="space-y-1.5 text-left sm:col-span-2">
            <label className="text-sm font-medium text-green-deep block">Password</label>
            <input 
              type="password" 
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Create a strong password (min 6 chars)" 
              className="w-full bg-cream-dark rounded-xl px-4 py-3 text-sm text-[#4a4a4a] border border-transparent focus:border-green-fresh focus:bg-white focus:outline-none transition-all duration-300 placeholder-gray-400"
            />
          </div>

          {role === 'farmer' && (
            <div className="space-y-1.5 text-left sm:col-span-2 animate-slideDown">
              <label className="text-sm font-medium text-green-deep block">Farm Location (State)</label>
              <select 
                required
                value={state}
                onChange={(e) => setState(e.target.value)}
                className="w-full bg-cream-dark rounded-xl px-4 py-3 text-sm text-[#4a4a4a] border border-transparent focus:border-green-fresh focus:bg-white focus:outline-none transition-all duration-300"
              >
                <option value="">Select State</option>
                <option value="Uttar Pradesh">Uttar Pradesh</option>
                <option value="Punjab">Punjab</option>
                <option value="Maharashtra">Maharashtra</option>
                <option value="Haryana">Haryana</option>
                <option value="Gujarat">Gujarat</option>
              </select>
            </div>
          )}

          <div className="sm:col-span-2 flex items-start gap-2 mt-2">
            <input type="checkbox" required className="mt-1 accent-green-deep" />
            <span className="text-xs text-gray-500 leading-normal">
              I agree to the <a href="#" className="text-green-deep font-bold hover:underline">Terms of Service</a> and <a href="#" className="text-green-deep font-bold hover:underline">Privacy Policy</a>
            </span>
          </div>

          <button 
            type="submit" 
            disabled={loading}
            className={`sm:col-span-2 w-full bg-green-deep text-white rounded-xl py-3.5 text-sm font-bold shadow-md hover:bg-green-mid transition-all duration-300 mt-2 ${loading ? 'opacity-70 cursor-not-allowed' : 'hover:-translate-y-[1px] hover:shadow-[0_6px_20px_rgba(45,106,79,0.35)]'}`}
          >
            {loading ? 'Creating Account...' : `Create ${role.charAt(0).toUpperCase() + role.slice(1)} Account`}
          </button>
        </form>

        <div className="mt-8 pt-6 border-t border-gray-100 text-center text-sm">
          <p className="text-gray-500">
            Already have an account?{' '}
            <Link to="/login" className="font-bold text-green-deep hover:text-amber transition-colors duration-200 ml-1">
              Sign In
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

export default SignUp;
