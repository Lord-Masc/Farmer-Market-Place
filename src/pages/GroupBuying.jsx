import React from 'react';
import Navbar from '../components/Navbar';
import Footer from '../components/Footer';

const GroupBuying = () => {
  return (
    <div className="min-h-screen bg-cream font-dmsans">
      <Navbar />
      
      <main className="pt-32 pb-20 px-[5%] max-w-[1200px] mx-auto text-center">
        <div className="bg-white rounded-[32px] p-12 shadow-sm border border-cream-dark">
          <span className="text-6xl mb-6 block">🤝</span>
          <h1 className="font-playfair text-4xl font-black text-green-deep mb-4">Group Buying Deals</h1>
          <p className="text-[#4a4a4a] text-lg max-w-[600px] mx-auto mb-10">
            Combine orders with your neighbors to unlock wholesale bulk pricing directly from farms!
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-8 text-left">
            <div className="p-8 bg-green-deep/5 rounded-3xl">
                <h3 className="font-bold text-green-deep mb-2">How it works?</h3>
                <p className="text-sm text-gray-600 leading-relaxed">
                    1. Join an active group in your area.<br/>
                    2. Everyone adds their desired quantity.<br/>
                    3. Reach the threshold (e.g. 100kg total).<br/>
                    4. Get the lowest bulk price + shared delivery!
                </p>
            </div>
            
            <div className="p-8 bg-amber/5 rounded-3xl">
                <h3 className="font-bold text-green-deep mb-2">Active Near You</h3>
                <p className="text-sm text-gray-500 italic opacity-60">
                    Calculated groups for your location will appear here...
                </p>
            </div>
          </div>
        </div>
      </main>

      <Footer />
    </div>
  );
};

export default GroupBuying;
