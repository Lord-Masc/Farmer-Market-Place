import React from 'react';

const Testimonials = () => {
  const testimonials = [
    {
      bg: 'bg-[#d4edda]',
      emoji: '👨‍🌾',
      name: 'Raju Sharma',
      role: 'Farmer · Lucknow, UP',
      quote: 'Earlier I sold tomatoes at ₹12/kg to the mandi. Now on AgroConnect I get ₹42/kg directly from buyers. My income has tripled in just 6 months.'
    },
    {
      bg: 'bg-[#fff3cd]',
      emoji: '👩‍🍳',
      name: 'Priya Mehta',
      role: 'Restaurant Owner · Delhi',
      quote: 'As a restaurant owner I need fresh vegetables every morning. AgroConnect connects me with farmers directly — the quality is far better than any wholesale market.'
    },
    {
      bg: 'bg-[#e8f5e9]',
      emoji: '🧑‍🌾',
      name: 'Mohan Yadav',
      role: 'Farmer · Bareilly, UP',
      quote: 'I was skeptical about selling online but the app is very simple — even without much smartphone experience I was listing products in 10 minutes.'
    }
  ];

  return (
    <section id="stories" className="bg-white py-[6rem] px-[5%]">
      <div className="max-w-[1400px] mx-auto">
        <div className="text-center mb-[4rem] reveal">
          <span className="font-dmsans text-[0.78rem] font-semibold tracking-[0.12em] uppercase text-green-mid block mb-4">Farmer & Buyer Stories</span>
          <h2 className="font-playfair text-[clamp(2rem,3.5vw,2.8rem)] font-black text-green-deep mb-4">Real People, Real Impact</h2>
          <p className="font-dmsans text-[1.1rem] font-light text-[#4a4a4a] max-w-[600px] mx-auto">
            From small farms to large buyers — AgroConnect is changing how India eats.
          </p>
        </div>

        <div className="testi-grid grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-[1.5rem]">
          {testimonials.map((t, idx) => (
            <div 
              key={idx} 
              className="bg-cream rounded-[20px] p-[2rem] border border-cream-dark hover:border-green-fresh hover:shadow-[0_15px_40px_rgba(45,106,79,0.08)] transition-all duration-300 reveal"
              style={{ transitionDelay: `${(idx % 3) * 0.15}s` }}
            >
              <div className="text-amber text-[0.9rem] mb-[1rem] tracking-[0.15em]">★★★★★</div>
              <p className="font-dmsans text-[0.92rem] font-light text-[#4a4a4a] leading-[1.7] italic mb-[1.5rem]">
                "{t.quote}"
              </p>
              
              <div className="flex items-center gap-[0.8rem] mt-auto">
                <div className={`w-[42px] h-[42px] rounded-full flex items-center justify-center text-[1.2rem] ${t.bg}`}>
                  {t.emoji}
                </div>
                <div className="flex flex-col">
                  <span className="font-dmsans text-[0.9rem] font-semibold text-green-deep">{t.name}</span>
                  <span className="font-dmsans text-[0.78rem] text-gray-500">{t.role}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
};

export default Testimonials;
