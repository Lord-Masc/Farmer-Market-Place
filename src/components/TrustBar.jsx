import React from 'react';

const TrustBar = () => {
  return (
    <section className="w-full bg-green-deep py-[1.5rem] px-[5%] flex flex-row flex-wrap justify-center items-center gap-y-[1.5rem] gap-x-[3rem] sm:gap-x-[3rem] gap-[1.5rem]">
      {[
        '🔒 Secure Payments',
        '🚚 Same-Day Delivery',
        '🌱 100% Organic Options',
        '💰 Fair Price Guarantee',
        '📞 24/7 Farmer Support'
      ].map((item, idx) => (
        <div key={idx} className="flex items-center gap-[0.6rem] text-white/75 font-dmsans text-[0.88rem]">
          {item}
        </div>
      ))}
    </section>
  );
};

export default TrustBar;
