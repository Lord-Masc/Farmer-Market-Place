import React from 'react';
import { Link } from 'react-router-dom';

const Roles = () => {
  return (
    <section id="for-farmers-buyers" className="bg-cream-dark py-[6rem] px-[5%]">
      <div className="max-w-[1400px] mx-auto">
        <div className="text-center mb-[4rem] reveal">
          <span className="font-dmsans text-[0.78rem] font-semibold tracking-[0.12em] uppercase text-green-mid block mb-4">Who Is It For</span>
          <h2 className="font-playfair text-[clamp(2rem,3.5vw,2.8rem)] font-black text-green-deep">Built for Both Sides of the Field</h2>
        </div>

        <div className="roles-grid grid grid-cols-1 md:grid-cols-2 gap-[2rem]">
          {/* Farmer Card */}
          <div className="bg-green-deep rounded-[24px] p-[2.5rem] reveal" style={{ transitionDelay: '0.1s' }}>
            <div className="text-[3rem] mb-[1.5rem]">👨‍🌾</div>
            <h3 className="font-playfair text-[1.6rem] font-black text-white mb-4">For Farmers</h3>
            <p className="font-dmsans text-[1.05rem] font-light text-white/65 leading-relaxed mb-6">
              Take control of your income. Sell directly, skip the middlemen, and get fair prices for the crops you've worked so hard to grow.
            </p>
            
            <div className="flex flex-col mb-8">
              {[
                'Create a farm profile & product listings',
                'Manage orders & track earnings',
                'Set your own prices & quantities',
                'Receive payments instantly via UPI',
                'Chat directly with buyers',
                'Access crop demand forecasts'
              ].map((item, i) => (
                <div key={i} className="flex items-center gap-[0.7rem] border-b border-white/10 py-[0.5rem]">
                  <span className="text-green-fresh">✓</span>
                  <span className="font-dmsans text-[0.88rem] font-medium text-white/85">{item}</span>
                </div>
              ))}
            </div>
            
            <Link to="/signup" className="inline-block bg-amber text-green-deep rounded-full px-[1.8rem] py-[0.75rem] font-dmsans text-[0.9rem] font-semibold hover:bg-amber-light hover:-translate-y-[2px] transition-all duration-300 shadow-md">
              Register as Farmer →
            </Link>
          </div>

          {/* Buyer Card */}
          <div className="bg-amber rounded-[24px] p-[2.5rem] reveal" style={{ transitionDelay: '0.3s' }}>
            <div className="text-[3rem] mb-[1.5rem]">🛍️</div>
            <h3 className="font-playfair text-[1.6rem] font-black text-green-deep mb-4">For Buyers</h3>
            <p className="font-dmsans text-[1.05rem] font-light text-green-deep/70 leading-relaxed mb-6">
              Take control of your income. Sell directly, skip the middlemen, and get fair prices for the crops you've worked so hard to grow.
            </p>
            
            <div className="flex flex-col mb-8">
              {[
                'Browse 500+ crops from local farms',
                'Filter by organic, location & price',
                'Order in bulk at wholesale rates',
                'Track delivery in real time',
                'Subscribe to your favourite farms',
                'Secure checkout & easy returns'
              ].map((item, i) => (
                <div key={i} className="flex items-center gap-[0.7rem] border-b border-green-deep/10 py-[0.5rem]">
                  <span className="text-green-deep">✓</span>
                  <span className="font-dmsans text-[0.88rem] font-medium text-green-deep">{item}</span>
                </div>
              ))}
            </div>
            
            <Link to="/signup" className="inline-block bg-green-deep text-white rounded-full px-[1.8rem] py-[0.75rem] font-dmsans text-[0.9rem] font-semibold hover:-translate-y-[2px] transition-all duration-300 shadow-md">
              Start Shopping →
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
};

export default Roles;
