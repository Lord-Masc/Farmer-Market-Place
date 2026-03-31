import React from 'react';

const Hero = () => {
  return (
    <section className="min-h-screen relative flex items-center pt-[8rem] pb-[4rem] px-[5%] overflow-hidden">
      {/* Background Effects */}
      <div className="hidden lg:block absolute top-0 right-0 w-[55%] h-full bg-gradient-to-br from-green-mid/10 to-amber/10 rounded-bl-[80px] z-0" />
      <div className="absolute top-[10%] right-[10%] w-[400px] h-[400px] bg-green-fresh blur-[60px] opacity-15 rounded-full animate-float z-0" />
      <div className="absolute bottom-[10%] left-[5%] w-[300px] h-[300px] bg-amber blur-[60px] opacity-15 rounded-full animate-float z-0" style={{ animationDelay: '-3s' }} />

      <div className="w-full max-w-[1400px] mx-auto grid grid-cols-1 lg:grid-cols-2 gap-[4rem] items-center relative z-10">
        
        {/* LEFT COLUMN */}
        <div className="flex flex-col items-start text-left space-y-6">
          <div className="inline-flex items-center gap-[0.5rem] bg-amber/15 border border-amber/40 rounded-full px-[1rem] py-[0.4rem] animate-fadeUp" style={{ animationDelay: '0.2s', opacity: 0 }}>
            <div className="w-[7px] h-[7px] bg-amber rounded-full animate-pulseBadge" />
            <span className="font-dmsans text-[0.82rem] font-medium text-soil">
              India's #1 Direct Farm Marketplace
            </span>
          </div>

          <h1 className="font-playfair text-[clamp(2.8rem,5vw,4.2rem)] font-black leading-[1.1] text-green-deep animate-fadeUp" style={{ animationDelay: '0.35s', opacity: 0 }}>
            Farm Fresh, <br />
            <span className="italic text-amber">Straight</span> <br />
            to Your Door
          </h1>

          <p className="font-dmsans text-[1.08rem] font-light text-[#4a4a4a] leading-[1.75] max-w-[480px] animate-fadeUp" style={{ animationDelay: '0.5s', opacity: 0 }}>
            AgroConnect connects farmers directly with buyers — no middlemen, fair prices, and the freshest produce from fields across India.
          </p>

          <div className="flex flex-wrap gap-4 animate-fadeUp" style={{ animationDelay: '0.65s', opacity: 0 }}>
            <button className="bg-green-deep text-white px-[2rem] py-[0.85rem] rounded-full font-dmsans text-[1rem] font-semibold hover:bg-green-mid hover:-translate-y-[2px] transition-all duration-300 hover:shadow-[0_10px_30px_rgba(26,58,42,0.3)] shadow-md cursor-pointer">
              🛒 Start Shopping
            </button>
            <button className="border-[1.5px] border-green-deep text-green-deep bg-transparent px-[2rem] py-[0.85rem] rounded-full font-dmsans text-[1rem] font-semibold hover:bg-green-deep hover:text-white transition-all duration-300 cursor-pointer">
              Sell Your Produce →
            </button>
          </div>

          <div className="flex flex-row flex-wrap sm:gap-[2.5rem] gap-[1.5rem] mt-4 animate-fadeUp" style={{ animationDelay: '0.8s', opacity: 0 }}>
            {[
              { num: '12K+', label: 'Registered Farmers' },
              { num: '85K+', label: 'Happy Buyers' },
              { num: '500+', label: 'Crops & Products' }
            ].map((stat, idx) => (
              <div key={idx} className="flex flex-col">
                <span className="font-playfair text-[2rem] font-bold text-green-deep leading-[1]">{stat.num}</span>
                <span className="font-dmsans text-[0.8rem] text-[#8a8a8a] mt-[0.25rem]">{stat.label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* RIGHT COLUMN */}
        <div className="relative w-full max-w-[500px] mx-auto animate-fadeIn" style={{ animationDelay: '0.4s', opacity: 0 }}>
          
          <div className="bg-green-deep rounded-[24px] p-[2.5rem] shadow-[0_30px_80px_rgba(26,58,42,0.3)] overflow-hidden relative">
            <div className="absolute -top-[50%] -right-[30%] w-[300px] h-[300px] bg-green-fresh/20 rounded-full z-0 pointer-events-none" />
            
            <div className="relative z-10">
              <span className="bg-amber/20 text-amber-light px-[0.9rem] py-[0.3rem] rounded-[20px] font-dmsans text-[0.78rem] font-medium inline-block mb-4">
                🌿 Fresh Today
              </span>
              
              <h3 className="font-playfair text-[1.5rem] font-bold text-white mb-1">Seasonal Harvest</h3>
              <p className="font-dmsans text-[0.85rem] text-white/60 mb-[1.5rem]">Direct from farmers near you</p>

              <div className="grid grid-cols-3 gap-[0.8rem] mb-[1.5rem]">
                {[
                  { emoji: '🍅', name: 'Tomatoes' },
                  { emoji: '🥕', name: 'Carrots' },
                  { emoji: '🌽', name: 'Maize' },
                  { emoji: '🥬', name: 'Spinach' },
                  { emoji: '🥭', name: 'Mangoes' },
                  { emoji: '🧅', name: 'Onions' },
                ].map((item, id) => (
                  <div key={id} className="bg-white/10 border border-white/10 rounded-[12px] p-[0.7rem] text-center cursor-pointer hover:bg-green-fresh/20 hover:border-green-fresh hover:scale-[1.04] transition-all duration-250">
                    <span className="text-[1.6rem] block mb-[0.3rem]">{item.emoji}</span>
                    <span className="font-dmsans text-[0.72rem] text-white/80 font-medium">{item.name}</span>
                  </div>
                ))}
              </div>

              <div className="bg-white/5 border border-white/10 rounded-[12px] p-[0.9rem] px-[1rem] flex items-center justify-between">
                <div className="flex items-center gap-[0.7rem]">
                  <div className="w-[36px] h-[36px] bg-amber rounded-full flex items-center justify-center text-[1.1rem]">👨‍🌾</div>
                  <div className="flex flex-col">
                    <span className="font-dmsans text-[0.82rem] text-white font-medium">Ramesh Patel</span>
                    <span className="font-dmsans text-[0.72rem] text-white/50">📍 Bareilly, UP</span>
                  </div>
                </div>
                <div className="font-dmsans text-amber-light text-[0.82rem] font-semibold">
                  ⭐ 4.9
                </div>
              </div>
            </div>
          </div>

          <div className="hidden lg:flex absolute top-[-20px] right-[-20px] bg-white rounded-[16px] py-[0.9rem] px-[1.2rem] shadow-[0_15px_40px_rgba(0,0,0,0.12)] items-center gap-[0.7rem] animate-floatCard z-20">
            <div className="w-[36px] h-[36px] bg-green-fresh/15 rounded-[10px] flex items-center justify-center text-[1.1rem]">📦</div>
            <div className="flex flex-col">
              <span className="font-dmsans text-[0.7rem] text-gray-500">New Order</span>
              <span className="font-dmsans text-[1rem] font-bold text-green-deep">₹1,240 received</span>
            </div>
          </div>

          <div className="hidden lg:flex absolute bottom-[60px] left-[-30px] bg-white rounded-[16px] py-[0.9rem] px-[1.2rem] shadow-[0_15px_40px_rgba(0,0,0,0.12)] items-center gap-[0.7rem] animate-floatCard z-20" style={{ animationDelay: '-2s' }}>
            <div className="flex flex-col">
              <span className="font-dmsans text-[0.7rem] text-gray-500">Delivery in</span>
              <span className="font-dmsans text-[1rem] font-bold text-green-deep">🚚 Same Day</span>
            </div>
          </div>

        </div>
      </div>
    </section>
  );
};

export default Hero;
