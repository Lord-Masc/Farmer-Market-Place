import React from 'react';
import { useSearchParams } from 'react-router-dom';
import EscrowCheckout from '../components/EscrowCheckout';
import Navbar from '../components/Navbar';
import Footer from '../components/Footer';

const EscrowTest = () => {
    const [searchParams] = useSearchParams();

    // Fetch dynamic parameters from URL
    const dynamicData = {
        orderId: searchParams.get('orderId') || '',
        productId: searchParams.get('productId') || '',
        buyerId: searchParams.get('buyerId') || '',
        sellerId: searchParams.get('sellerId') || '',
        amount: parseFloat(searchParams.get('amount') || '0') || 0,
        productName: searchParams.get('productName') || 'Fresh Harvest',
        quantity: searchParams.get('quantity') || '0',
        unit: searchParams.get('unit') || 'kg',
        deliveryAddress: searchParams.get('deliveryAddress') || '',
        buyerPhone: searchParams.get('buyerPhone') || ''
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
                            Your Payment is <span className="text-emerald-600 underline decoration-emerald-200 underline-offset-8">Fully Protected.</span>
                        </h1>
                        <p className="text-lg text-slate-600 leading-relaxed max-w-lg">
                            We don't send your money to the farmer immediately. We hold it in a secure app-wallet until you receive your harvest.
                        </p>
                        
                        <div className="space-y-6">
                            <div className="flex items-start gap-4 bg-white p-5 rounded-3xl shadow-sm border border-slate-100 transition-all hover:shadow-md">
                                <div className="w-10 h-10 rounded-2xl bg-emerald-500 flex items-center justify-center text-white shrink-0 shadow-lg shadow-emerald-200 font-bold">1</div>
                                <div>
                                    <p className="font-bold text-slate-800">Secure Payment Hold</p>
                                    <p className="text-sm text-slate-500">Your money is deducted but held by AgroConnect, not the farmer.</p>
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
                                    <p className="font-bold text-slate-800">Release Funds</p>
                                    <p className="text-sm text-slate-500">Only after you click "Confirm Received" do we pay the farmer.</p>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Right Payment Section */}
                    <div className="w-full lg:sticky lg:top-32">
                        <EscrowCheckout 
                            orderId={dynamicData.orderId}
                            productId={dynamicData.productId}
                            buyerId={dynamicData.buyerId}
                            sellerId={dynamicData.sellerId}
                            amount={dynamicData.amount}
                            productName={dynamicData.productName}
                            quantity={dynamicData.quantity}
                            unit={dynamicData.unit}
                            deliveryAddress={dynamicData.deliveryAddress}
                            buyerPhone={dynamicData.buyerPhone}
                        />
                    </div>
                </div>
            </main>

            <Footer />
        </div>
    );
};

export default EscrowTest;
