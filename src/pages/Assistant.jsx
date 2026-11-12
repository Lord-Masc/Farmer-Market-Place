import React, { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import Navbar from '../components/Navbar';
import Footer from '../components/Footer';
import AssistantChat from '../components/AssistantChat';

// AI Farmer Assistant (Stage 8, module G): Hindi-first chat that only
// answers from platform data. Same page shell as the other dashboard
// pages; no restyle (Stage 11 is design).
const Assistant = () => {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!user && !authLoading) navigate('/login');
  }, [user, authLoading, navigate]);

  return (
    <div className="min-h-screen font-dmsans bg-cream">
      <Navbar />
      <main className="pt-32 pb-20 px-[5%] max-w-[1400px] mx-auto">
        <header className="mb-10">
          <h1 className="font-playfair text-4xl font-black text-green-deep mb-2">सहायक (Assistant)</h1>
          <p className="text-[#4a4a4a] text-lg">
            Apne sawaal poochhein — mandi bhaav, order, dispute. Jawab sirf platform ke data se aata hai; data na ho to sahayak saaf mana kar dega.
          </p>
        </header>
        <AssistantChat />
      </main>
      <Footer />
    </div>
  );
};

export default Assistant;
