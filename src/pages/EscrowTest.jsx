import React from 'react';
import { useSearchParams } from 'react-router-dom';
import EscrowCheckout from '../components/EscrowCheckout';
import Navbar from '../components/Navbar';
import Footer from '../components/Footer';

const EscrowTest = () => {
    const [searchParams] = useSearchParams();

    // Dev-only test page: never render the unauthenticated checkout
    // harness in a production build.
    if (!import.meta.env.DEV) {
        return (
            <div className="min-h-screen bg-slate-50 flex flex-col">
                <Navbar />
                <main className="flex-grow flex items-center justify-center">
                    <p className="text-slate-500 font-bold">Not available</p>
                </main>
                <Footer />
            </div>
        );
    }

    // Fetch dynamic parameters from URL (only what EscrowCheckout takes).
    const dynamicData = {
        orderId: searchParams.get('orderId') || '',
        amount: parseFloat(searchParams.get('amount') || '0') || 0,
        productName: searchParams.get('productName') || 'Fresh Harvest',
    };

    return (
        <div className="min-h-screen bg-slate-50 flex flex-col">
            <Navbar />
            
            <main className="flex-grow flex items-center justify-center p-4 py-32 bg-gradient-to-br from-white to-emerald-50/20">
                <div className="w-full max-w-6xl grid grid-cols-1 lg:grid-cols-2 gap-12 items-start">
                    
                    {/* Left Info Section */}
                    <div className="space-y-8 lg:pt-10">
                        <div className="inline-block px-4 py-2 bg-emerald-100 text-emerald-700 rounded-full text-xs font-black tracking-widest uppercase shadow-sm">
                            🛡️ AgroConnect Secure Escrow
                        </div>
                        <h1 className="text-4xl md:text-5xl font-black text-slate-900 leading-tight font-playfair">
                            Test a <span className="text-emerald-600 underline decoration-emerald-200 underline-offset-8">Verified Payment.</span>
                        </h1>
                        <p className="text-lg text-slate-600 leading-relaxed max-w-lg">
                            Payments are verified by the backend and recorded. Automatic farmer payouts are not configured yet.
                        </p>
                        
                        <div className="space-y-6">
                            <div className="flex items-start gap-4 bg-white p-5 rounded-3xl shadow-sm border border-slate-100 transition-all hover:shadow-md">
                                <div className="w-10 h-10 rounded-2xl bg-emerald-500 flex items-center justify-center text-white shrink-0 shadow-lg shadow-emerald-200 font-bold">1</div>
                                <div>
                                    <p className="font-bold text-slate-800">Payment Verification</p>
                                    <p className="text-sm text-slate-500">The backend verifies the Razorpay payment and records it.</p>
                                </div>
                            </div>
                            <div className="flex items-start gap-4 bg-white p-5 rounded-3xl shadow-sm border border-slate-100 transition-all hover:shadow-md">
                                <div className="w-10 h-10 rounded-2xl bg-emerald-500 flex items-center justify-center text-white shrink-0 shadow-lg shadow-emerald-200 font-bold">2</div>
                                <div>
                                    <p className="font-bold text-slate-800">Receive & Verify</p>
                                    <p className="text-sm text-slate-500">The farmer ships your order. Inspect the quality when it arrives.</p>
                                </div>
                            </div>
                            <div className="flex items-start gap-4 bg-white p-5 rounded-3xl shadow-sm border border-slate-100 transition-all hover:shadow-md">
                                <div className="w-10 h-10 rounded-2xl bg-emerald-500 flex items-center justify-center text-white shrink-0 shadow-lg shadow-emerald-200 font-bold">3</div>
                                <div>
                                    <p className="font-bold text-slate-800">Order Completion</p>
                                    <p className="text-sm text-slate-500">Confirm receipt after delivery to complete the order.</p>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Right Payment Section */}
                    <div className="w-full lg:sticky lg:top-32">
                        <EscrowCheckout 
                            orderId={dynamicData.orderId}
                            amount={dynamicData.amount}
                            productName={dynamicData.productName}
                        />
                    </div>
                </div>
            </main>

            <Footer />
        </div>
    );
};

export default EscrowTest;
