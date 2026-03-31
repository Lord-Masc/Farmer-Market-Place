import React from 'react';

const Features = () => {
  const featureList = [
    {
      icon: '🌾',
      bgClass: 'bg-green-fresh/15',
      title: 'Easy Product Listing',
      desc: 'Farmers can list products in minutes with photos, pricing, quantity, and harvest dates. No tech skills needed.',
    },
    {
      icon: '📊',
      bgClass: 'bg-amber/15',
      title: 'Live Order Dashboard',
      desc: 'Real-time visibility on all incoming orders, payments, and delivery status from one clean dashboard.',
    },
    {
      icon: '🔍',
      bgClass: 'bg-soil/12',
      title: 'Smart Search & Filter',
      desc: 'Buyers can browse by crop type, location, organic certification, price range, and harvest freshness.',
    },
    {
      icon: '💬',
      bgClass: 'bg-green-fresh/15',
      title: 'Direct Messaging',
      desc: 'Farmers and buyers communicate directly — negotiate bulk prices, ask about quality, or schedule pickup.',
    },
    {
      icon: '💳',
      bgClass: 'bg-amber/15',
      title: 'Secure Payments',
      desc: 'UPI, cards, and wallets — payments are processed securely and released to farmers only on delivery.',
    },
    {
      icon: '⭐',
      bgClass: 'bg-soil/12',
      title: 'Reviews & Ratings',
      desc: 'Build trust through verified buyer reviews. Top-rated farmers get featured placements on the platform.',
    },
    {
      icon: '📦',
      bgClass: 'bg-green-fresh/15',
      title: 'Inventory Management',
      desc: 'Track stock levels, set low-stock alerts, and auto-close listings when produce sells out.',
    },
    {
      icon: '🚚',
      bgClass: 'bg-amber/15',
      title: 'Delivery & Pickup',
      desc: 'Flexible fulfillment — offer doorstep delivery, farm pickup, or connect with our logistics partners.',
    },
    {
      icon: '📈',
      bgClass: 'bg-soil/12',
      title: 'Earnings Analytics',
      desc: 'Farmers get weekly earnings reports, top-selling product insights, and buyer demand forecasts.',
    }
  ];

  return (
    <section id="features" className="bg-white py-[6rem] px-[5%]">
      <div className="max-w-[1400px] mx-auto">
        <div className="text-center mb-[4rem] reveal">
          <span className="font-dmsans text-[0.78rem] font-semibold tracking-[0.12em] uppercase text-green-mid block mb-4">Platform Features</span>
          <h2 className="font-playfair text-[clamp(2rem,3.5vw,2.8rem)] font-black text-green-deep mb-4">
            Everything You Need to <span className="italic text-amber">Grow</span>
          </h2>
          <p className="font-dmsans text-[1.1rem] font-light text-[#4a4a4a] max-w-[600px] mx-auto">
            A complete ecosystem for farmers and buyers — from listing to delivery, we've got every step covered.
          </p>
        </div>

        <div className="features-grid grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-[1.5rem]">
          {featureList.map((feature, idx) => (
            <div 
              key={idx} 
              className="bg-cream-dark rounded-[20px] p-[2rem] border border-transparent hover:border-green-fresh hover:-translate-y-[5px] hover:shadow-[0_20px_50px_rgba(45,106,79,0.1)] transition-all duration-300 cursor-default reveal"
              style={{ transitionDelay: `${(idx % 3) * 0.1}s` }}
            >
              <div className={`w-[52px] h-[52px] rounded-[14px] mb-[1.3rem] flex items-center justify-center text-[1.4rem] ${feature.bgClass}`}>
                {feature.icon}
              </div>
              <h4 className="font-playfair text-[1.15rem] font-bold text-green-deep mb-3">{feature.title}</h4>
              <p className="font-dmsans text-[0.88rem] font-light text-[#4a4a4a] leading-[1.65]">{feature.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
};

export default Features;
