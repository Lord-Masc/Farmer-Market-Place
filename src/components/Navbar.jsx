import React from 'react';
import { Link } from 'react-router-dom';

const Navbar = () => {
  return (
    <nav className="fixed top-0 left-0 w-full z-[100] animate-slideDown flex items-center justify-between px-[5%] py-[1.2rem] bg-cream/92 backdrop-blur-[12px] border-b border-amber/20">
      <div className="font-playfair text-[1.7rem] font-black cursor-pointer">
        <span className="text-green-deep">Agro</span>
        <span className="text-amber">Connect</span>
      </div>

      <div className="hidden lg:flex items-center gap-[2.5rem]">
        {['Features', 'How it Works', 'For Farmers/Buyers', 'Stories'].map((item) => (
          <a
            key={item}
            href={`#${item.toLowerCase().replace(/[\s/]+/g, '-')}`}
            className="font-dmsans text-[0.9rem] font-medium text-[#4a4a4a] hover:text-green-mid transition-colors duration-200"
          >
            {item}
          </a>
        ))}
      </div>

      <div className="flex items-center gap-3">
        <Link to="/login" className="hidden sm:block border-[1.5px] border-green-mid text-green-mid rounded-full px-[1.4rem] py-[0.55rem] font-dmsans text-[0.88rem] font-medium hover:bg-green-mid hover:text-white transition-all duration-300">
          Sign In
        </Link>
        <Link to="/signup" className="bg-green-deep text-white rounded-full px-[1.5rem] py-[0.6rem] font-dmsans text-[0.88rem] font-semibold shadow-lg hover:bg-green-mid hover:-translate-y-[1px] hover:shadow-[0_6px_20px_rgba(45,106,79,0.35)] transition-all duration-300 cursor-pointer">
          Get Started
        </Link>
      </div>
    </nav>
  );
};

export default Navbar;
