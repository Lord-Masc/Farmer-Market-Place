import React from 'react';

const HowItWorks = () => {
  return (
    <section id="how-it-works" className="bg-green-deep py-[6rem] px-[5%]">
      <div className="max-w-[1400px] mx-auto grid grid-cols-1 lg:grid-cols-2 gap-[5rem] items-center">
        
        {/* Left Side */}
        <div className="reveal">
          <span className="text-amber-light font-dmsans text-[0.85rem] font-semibold tracking-wide uppercase block mb-3">How It Works</span>
          <h2 className="text-white font-playfair text-[clamp(2rem,3.5vw,2.8rem)] font-black mb-4">
            Three Steps to <span className="italic text-amber">Fresh</span>
          </h2>
          <p className="text-white/60 font-dmsans text-[1.1rem] font-light mb-10 leading-relaxed">
            Whether you're selling or buying, AgroConnect makes the entire process simple and transparent.
          </p>

          <div className="flex flex-col gap-[2rem]">
            {[
              { num: '1', title: 'Create Your Account', desc: 'Sign up as a farmer or buyer in under 2 minutes. Verify your phone number and you\'re ready to go.' },
              { num: '2', title: 'List or Browse Products', desc: 'Farmers upload their produce with photos and pricing. Buyers search and filter for exactly what they need.' },
              { num: '3', title: 'Transact & Deliver', desc: 'Pay securely online. Track your order live. Farmers get paid instantly once delivery is confirmed.' }
            ].map((step, idx) => (
              <div key={idx} className="flex flex-row gap-[1.3rem] items-start reveal" style={{ transitionDelay: `${idx * 0.15}s` }}>
                <div className="flex-shrink-0 w-[44px] h-[44px] border-[1.5px] border-amber/50 rounded-full flex items-center justify-center font-playfair text-[1.1rem] font-bold text-amber">
                  {step.num}
                </div>
                <div>
                  <h4 className="text-[1rem] font-semibold text-white font-dmsans mb-1">{step.title}</h4>
                  <p className="text-[0.87rem] font-light text-white/55 leading-[1.6] font-dmsans">{step.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Right Side - Phone Mockup Card */}
        <div className="bg-white/5 border border-white/10 rounded-[32px] p-[2rem] backdrop-blur-[10px] reveal" style={{ transitionDelay: '0.3s' }}>
          <div className="bg-white rounded-[20px] overflow-hidden shadow-2xl relative">
            
            {/* App Bar */}
            <div className="bg-green-deep p-[1rem] px-[1.2rem] flex justify-between items-center">
              <div className="flex flex-col">
                <span className="font-playfair text-[1rem] font-bold text-white tracking-wide">AgroConnect</span>
                <span className="font-dmsans text-[0.72rem] text-white/60">📍 Bareilly, UP</span>
              </div>
              <span className="text-[1.2rem]">🛒</span>
            </div>

            {/* App Content */}
            <div className="bg-cream p-[1.2rem]">
              
              <div className="bg-white rounded-[12px] p-[0.7rem] px-[1rem] mb-[1rem] shadow-sm">
                <span className="font-dmsans text-[0.85rem] text-gray-400">🔍 Search fruits, vegetables...</span>
              </div>

              <div className="flex flex-row overflow-x-auto gap-[0.5rem] mb-[1.5rem] pb-2 hide-scrollbar whitespace-nowrap">
                <span className="bg-green-deep text-white px-[0.9rem] py-[0.3rem] rounded-[20px] font-dmsans text-[0.8rem] font-medium flex-shrink-0 inline-block">All</span>
                {['🥦 Vegetables', '🍎 Fruits', '🌾 Grains', '🥛 Dairy'].map((cat, idx) => (
                  <span key={idx} className="bg-white text-gray-500 border border-cream-dark px-[0.9rem] py-[0.3rem] rounded-[20px] font-dmsans text-[0.8rem] flex-shrink-0 inline-block">
                    {cat}
                  </span>
                ))}
              </div>

              <h4 className="font-dmsans text-[0.78rem] font-semibold text-gray-800 mb-[0.7rem]">Fresh Today 🌿</h4>
              
              <div className="grid grid-cols-2 gap-[0.7rem]">
                {[
                  { emoji: '🍅', name: 'Desi Tomatoes', price: '₹45/kg', farm: 'Ramesh Farm' },
                  { emoji: '🥭', name: 'Alphonso Mangoes', price: '₹120/kg', farm: 'Suresh Farms' },
                  { emoji: '🧅', name: 'Red Onions', price: '₹25/kg', farm: 'Mohan Ki Khet' },
                  { emoji: '🥬', name: 'Palak', price: '₹28/kg', farm: 'Devi Agro' },
                ].map((item, id) => (
                  <div key={id} className="bg-white rounded-[12px] p-[0.8rem] shadow-sm relative group cursor-pointer border border-transparent hover:border-green-fresh transition-all">
                    <span className="text-[1.8rem] block mb-[0.5rem]">{item.emoji}</span>
                    <h5 className="font-dmsans text-[0.75rem] font-semibold text-green-deep">{item.name}</h5>
                    <p className="font-dmsans text-[0.68rem] text-gray-500 mb-2">{item.farm}</p>
                    <div className="flex justify-between items-center">
                      <span className="font-dmsans text-[0.8rem] font-bold text-green-mid">{item.price}</span>
                      <button className="w-[22px] h-[22px] bg-green-deep rounded-full flex items-center justify-center text-white text-[0.9rem] leading-none hover:bg-green-mid transition-colors">+</button>
                    </div>
                  </div>
                ))}
              </div>

            </div>
          </div>
        </div>

      </div>
    </section>
  );
};

export default HowItWorks;
