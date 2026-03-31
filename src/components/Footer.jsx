import React from 'react';

const Footer = () => {
  return (
    <footer className="bg-[#111d17] pt-[4rem] px-[5%] pb-[2rem] text-white/50 reveal">
      <div className="max-w-[1400px] mx-auto grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-[3rem] tracking-wide mb-[3rem]">
        
        {/* Column 1 - Brand */}
        <div className="lg:col-span-2">
          <div className="font-playfair text-[1.5rem] font-black cursor-pointer mb-[1rem]">
            <span className="text-white/90">Agro</span>
            <span className="text-amber">Connect</span>
          </div>
          <p className="font-dmsans text-[0.87rem] font-light text-white/40 max-w-[260px] leading-[1.6]">
            Empowering India's farmers by connecting them directly with buyers. No middlemen. Fair prices. Fresh produce.
          </p>
          
          <div className="flex gap-[0.7rem] mt-[1.5rem]">
            {['𝕏', 'f', 'in', '📱'].map((icon, idx) => (
              <a key={idx} href="#social" className="w-[36px] h-[36px] bg-white/5 rounded-full flex items-center justify-center hover:bg-green-mid hover:text-white transition-colors duration-300 text-[1rem]">
                {icon}
              </a>
            ))}
          </div>
        </div>

        {/* Column 2 - Platform */}
        <div className="flex flex-col gap-[0.7rem]">
          <h5 className="font-dmsans text-[0.82rem] font-semibold uppercase tracking-[0.1em] text-white/70 mb-2">Platform</h5>
          {['How It Works', 'For Farmers', 'For Buyers', 'Pricing', 'App Download'].map((link, idx) => (
            <a key={idx} href="#platform" className="font-dmsans text-[0.87rem] text-white/40 hover:text-green-fresh transition-colors decoration-transparent">
              {link}
            </a>
          ))}
        </div>

        {/* Column 3 - Company */}
        <div className="flex flex-col gap-[0.7rem]">
          <h5 className="font-dmsans text-[0.82rem] font-semibold uppercase tracking-[0.1em] text-white/70 mb-2">Company</h5>
          {['About Us', 'Blog', 'Careers', 'Press', 'Contact'].map((link, idx) => (
            <a key={idx} href="#company" className="font-dmsans text-[0.87rem] text-white/40 hover:text-green-fresh transition-colors decoration-transparent">
              {link}
            </a>
          ))}
        </div>

        {/* Column 4 - Support (Wraps in lg) */}
        <div className="flex flex-col gap-[0.7rem]">
          <h5 className="font-dmsans text-[0.82rem] font-semibold uppercase tracking-[0.1em] text-white/70 mb-2">Support</h5>
          {['Help Centre', 'Privacy Policy', 'Terms of Service', 'Grievance', 'हिन्दी में'].map((link, idx) => (
            <a key={idx} href="#support" className="font-dmsans text-[0.87rem] text-white/40 hover:text-green-fresh transition-colors decoration-transparent">
              {link}
            </a>
          ))}
        </div>

      </div>

      <div className="max-w-[1400px] mx-auto border-t border-white/5 pt-[1.5rem] flex flex-wrap justify-between items-center gap-[1rem]">
        <span className="font-dmsans text-[0.85rem] text-white/40 font-light">
          © 2025 AgroConnect Technologies Pvt. Ltd. · Made with 🌾 in India
        </span>
        <span className="font-dmsans text-[0.85rem] text-white/40 font-light">
          Kisan Helpline: 1800-XXX-XXXX (Toll Free)
        </span>
      </div>
    </footer>
  );
};

export default Footer;
