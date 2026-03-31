import React from 'react';
import { Link } from 'react-router-dom';

const CTA = () => {
  return (
    <section className="relative overflow-hidden bg-green-deep py-[6rem] px-[5%] text-center reveal">
      <div className="absolute inset-0 z-0 pointer-events-none" style={{ backgroundImage: 'radial-gradient(ellipse at center, rgba(82,183,136,0.15) 0%, transparent 70%)' }}></div>
      <div className="relative z-10 max-w-[700px] mx-auto flex flex-col items-center">
        <span className="text-amber-light font-dmsans text-[0.85rem] font-semibold tracking-wide uppercase block mb-4">
          Join AgroConnect Today
        </span>
        <h2 className="text-white font-playfair text-[clamp(2.2rem,4vw,3.2rem)] font-black mb-6 leading-[1.2]">
          The Future of Farming is <span className="italic text-amber">Direct</span>
        </h2>
        <p className="font-dmsans text-[1.05rem] font-light text-white/60 mb-[2.5rem] max-w-[500px]">
          Whether you grow it or need it fresh — AgroConnect is the bridge between India's fields and your kitchen.
        </p>

        <div className="flex flex-col sm:flex-row gap-[1rem] justify-center w-full">
          <Link to="/signup" className="bg-amber text-green-deep px-[2.2rem] py-[0.9rem] rounded-full font-dmsans font-bold hover:bg-amber-light hover:-translate-y-[2px] hover:shadow-[0_10px_30px_rgba(233,168,76,0.4)] transition-all duration-300">
            🌾 List Your Farm for Free
          </Link>
          <Link to="/products" className="border-[1.5px] border-white/30 text-white bg-transparent px-[2.2rem] py-[0.9rem] rounded-full font-dmsans font-bold hover:border-white hover:bg-white/10 transition-all duration-300">
            🛒 Shop Fresh Produce
          </Link>
        </div>
      </div>
    </section>
  );
};

export default CTA;
