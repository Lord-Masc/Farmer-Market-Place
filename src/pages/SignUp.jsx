import React, { useState } from 'react';
import { Link } from 'react-router-dom';

const SignUp = () => {
  const [role, setRole] = useState('buyer'); // 'farmer' or 'buyer'

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
            onClick={() => setRole('buyer')}
            className={`flex-1 py-2.5 text-sm font-bold rounded-lg transition-all duration-300 ${role === 'buyer' ? 'bg-white text-green-deep shadow-sm' : 'text-gray-500'}`}
          >
            🛒 I'm a Buyer
          </button>
          <button 
            onClick={() => setRole('farmer')}
            className={`flex-1 py-2.5 text-sm font-bold rounded-lg transition-all duration-300 ${role === 'farmer' ? 'bg-white text-green-deep shadow-sm' : 'text-gray-500'}`}
          >
            👨‍🌾 I'm a Farmer
          </button>
        </div>

        <form className="grid grid-cols-1 sm:grid-cols-2 gap-5" onSubmit={(e) => e.preventDefault()}>
          <div className="space-y-1.5 text-left">
            <label className="text-sm font-medium text-green-deep block">First Name</label>
            <input 
              type="text" 
              placeholder="Ramesh" 
              className="w-full bg-cream-dark rounded-xl px-4 py-3 text-sm text-[#4a4a4a] border border-transparent focus:border-green-fresh focus:bg-white focus:outline-none transition-all duration-300 placeholder-gray-400"
            />
          </div>

          <div className="space-y-1.5 text-left">
            <label className="text-sm font-medium text-green-deep block">Last Name</label>
            <input 
              type="text" 
              placeholder="Patel" 
              className="w-full bg-cream-dark rounded-xl px-4 py-3 text-sm text-[#4a4a4a] border border-transparent focus:border-green-fresh focus:bg-white focus:outline-none transition-all duration-300 placeholder-gray-400"
            />
          </div>

          <div className="space-y-1.5 text-left sm:col-span-2">
            <label className="text-sm font-medium text-green-deep block">Email Address</label>
            <input 
              type="email" 
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
                placeholder="10-digit mobile number" 
                className="flex-1 bg-cream-dark rounded-xl px-4 py-3 text-sm text-[#4a4a4a] border border-transparent focus:border-green-fresh focus:bg-white focus:outline-none transition-all duration-300 placeholder-gray-400"
              />
            </div>
          </div>

          <div className="space-y-1.5 text-left sm:col-span-2">
            <label className="text-sm font-medium text-green-deep block">Password</label>
            <input 
              type="password" 
              placeholder="Create a strong password" 
              className="w-full bg-cream-dark rounded-xl px-4 py-3 text-sm text-[#4a4a4a] border border-transparent focus:border-green-fresh focus:bg-white focus:outline-none transition-all duration-300 placeholder-gray-400"
            />
          </div>

          {role === 'farmer' && (
            <div className="space-y-1.5 text-left sm:col-span-2 animate-slideDown">
              <label className="text-sm font-medium text-green-deep block">Farm Location (State)</label>
              <select className="w-full bg-cream-dark rounded-xl px-4 py-3 text-sm text-[#4a4a4a] border border-transparent focus:border-green-fresh focus:bg-white focus:outline-none transition-all duration-300">
                <option value="">Select State</option>
                <option>Uttar Pradesh</option>
                <option>Punjab</option>
                <option>Maharashtra</option>
                <option>Haryana</option>
                <option>Gujarat</option>
              </select>
            </div>
          )}

          <div className="sm:col-span-2 flex items-start gap-2 mt-2">
            <input type="checkbox" className="mt-1 accent-green-deep" />
            <span className="text-xs text-gray-500 leading-normal">
              I agree to the <a href="#" className="text-green-deep font-bold hover:underline">Terms of Service</a> and <a href="#" className="text-green-deep font-bold hover:underline">Privacy Policy</a>
            </span>
          </div>

          <button 
            type="submit" 
            className="sm:col-span-2 w-full bg-green-deep text-white rounded-xl py-3.5 text-sm font-bold shadow-md hover:bg-green-mid hover:-translate-y-[1px] hover:shadow-[0_6px_20px_rgba(45,106,79,0.35)] transition-all duration-300 mt-2"
          >
            Create {role.charAt(0).toUpperCase() + role.slice(1)} Account
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
