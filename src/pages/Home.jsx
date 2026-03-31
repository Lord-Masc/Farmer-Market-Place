import React from 'react';
import Navbar from '../components/Navbar';
import Hero from '../components/Hero';
import TrustBar from '../components/TrustBar';
import Features from '../components/Features';
import HowItWorks from '../components/HowItWorks';
import Roles from '../components/Roles';
import Testimonials from '../components/Testimonials';
import CTA from '../components/CTA';
import Footer from '../components/Footer';
import { useReveal } from '../hooks/useReveal';

const Home = () => {
  useReveal();

  return (
    <div className="font-dmsans text-[#4a4a4a] bg-cream">
      <Navbar />
      <Hero />
      <TrustBar />
      <Features />
      <HowItWorks />
      <Roles />
      <Testimonials />
      <CTA />
      <Footer />
    </div>
  );
};

export default Home;
