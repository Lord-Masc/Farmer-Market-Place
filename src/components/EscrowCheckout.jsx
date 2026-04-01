import React, { useState } from 'react';

// ✅ Payment Success Popup
const PaymentSuccessModal = ({ amount, onClose }) => (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
        {/* Backdrop */}
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

        {/* Modal */}
        <div className="relative bg-white rounded-3xl shadow-2xl max-w-md w-full p-8 text-center animate-[fadeInUp_0.4s_ease] max-h-[90vh] overflow-y-auto custom-scrollbar">
            {/* Glow ring */}
            <div className="absolute -top-8 left-1/2 -translate-x-1/2 w-20 h-20 bg-emerald-500 rounded-full flex items-center justify-center shadow-[0_0_40px_rgba(16,185,129,0.5)]">
                <span className="text-4xl">🔒</span>
            </div>

            <div className="mt-8">
                <h2 className="text-2xl font-black text-slate-900 mb-1">Payment Secured!</h2>
                <p className="text-slate-500 text-sm mb-6">Your order request has been sent to the farmer.</p>

                {/* Amount badge */}
                <div className="bg-emerald-50 border border-emerald-100 rounded-2xl p-4 mb-6">
                    <p className="text-xs text-emerald-600 font-bold uppercase tracking-widest mb-1">Amount Held in Escrow</p>
                    <p className="text-4xl font-black text-emerald-700">₹{amount}</p>
                </div>

                {/* Info steps */}
                <div className="space-y-3 text-left mb-8">
                    <div className="flex items-start gap-3 bg-slate-50 p-3 rounded-xl">
                        <span className="text-2xl">🛡️</span>
                        <div>
                            <p className="font-bold text-slate-800 text-sm">Your payment is held safely</p>
                            <p className="text-xs text-slate-500">Money is locked inside AgroConnect — not sent to farmer yet.</p>
                        </div>
                    </div>
                    <div className="flex items-start gap-3 bg-slate-50 p-3 rounded-xl border border-emerald-100">
                        <span className="text-2xl">🚜</span>
                        <div>
                            <p className="font-bold text-slate-800 text-sm">Escrow Release</p>
                            <p className="text-xs text-slate-500">The farmer only gets the money when you click the "Confirm Received" button after checking your product.</p>
                        </div>
                    </div>
                    <div className="flex items-start gap-3 bg-slate-50 p-3 rounded-xl">
                        <span className="text-2xl">↩️</span>
                        <div>
                            <p className="font-bold text-slate-800 text-sm">Auto-refund if not delivered</p>
                            <p className="text-xs text-slate-500">If your product isn't delivered in 2 days, you get a full refund automatically.</p>
                        </div>
                    </div>
                </div>

                <button
                    onClick={() => {
                        window.location.href = '/buyer-dashboard?tab=Payment Track';
                    }}
                    className="w-full py-4 bg-emerald-600 hover:bg-emerald-700 text-white font-black rounded-2xl transition-all duration-200 shadow-lg shadow-emerald-200 hover:scale-[1.02] active:scale-95"
                >
                    Go to My Track Payment →
                </button>
            </div>
        </div>

        <style>{`
            @keyframes fadeInUp {
                from { opacity: 0; transform: translateY(30px) scale(0.95); }
                to   { opacity: 1; transform: translateY(0) scale(1); }
            }
        `}</style>
    </div>
);

const EscrowCheckout = ({ orderId, productId, buyerId, sellerId, amount, productName, quantity, unit, deliveryAddress, buyerPhone }) => {
    const [loading, setLoading] = useState(false);
    const [showSuccess, setShowSuccess] = useState(false);
    const [error, setError] = useState(null);

    const loadRazorpay = () => new Promise((resolve) => {
        if (window.Razorpay) return resolve(true); // Already loaded
        const script = document.createElement('script');
        script.src = 'https://checkout.razorpay.com/v1/checkout.js';
        script.onload = () => resolve(true);
        script.onerror = () => resolve(false);
        document.body.appendChild(script);
    });

    const handlePayment = async () => {
        setError(null);
        setLoading(true);

        const sdkLoaded = await loadRazorpay();
        if (!sdkLoaded) {
            setError('Could not load payment gateway. Please check your internet connection.');
            setLoading(false);
        }

        try {
            // Step 1: Create backend order
            const res = await fetch('http://localhost:5001/api/escrow/create-order', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    buyer_id: buyerId,
                    seller_id: sellerId,
                    amount: amount,
                    product_id: productId,
                    quantity: quantity,
                    unit: unit,
                    delivery_address: deliveryAddress,
                    buyer_phone: buyerPhone,
                    order_id: orderId
                })
            });

            const order = await res.json();
            if (!order.razorpay_order_id) throw new Error(order.error || 'Order creation failed');

            // Step 2: Open Razorpay
            const options = {
                key: 'rzp_test_SY1ec4urEYvzo8',
                amount: order.amount,
                currency: 'INR',
                name: 'AgroConnect',
                description: `Secure payment for ${productName || 'Farm Product'}`,
                image: 'https://ibelaipphuggkncovptw.supabase.co/storage/v1/object/public/logos/agroconnect-logo.png',
                order_id: order.razorpay_order_id,
                prefill: { name: 'Buyer', email: 'buyer@agroconnect.in', contact: '9999999999' },
                theme: { color: '#16a34a' },
                modal: { escape: false },
                handler: async (response) => {
                    // Step 3: Verify & hold payment
                    const verify = await fetch('http://localhost:5001/api/escrow/verify-payment', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            razorpay_order_id: response.razorpay_order_id,
                            razorpay_payment_id: response.razorpay_payment_id,
                            razorpay_signature: response.razorpay_signature,
                            order_id: order.order_id
                        })
                    });

                    const verifyData = await verify.json();
                    if (verifyData.success) {
                        setShowSuccess(true); // ✅ Show success popup
                    } else {
                        setError('Payment verification failed. Please contact support.');
                    }
                    setLoading(false);
                }
            };

            const rzp = new window.Razorpay(options);
            rzp.on('payment.failed', () => {
                setError('Payment was cancelled or failed. Please try again.');
                setLoading(false);
            });
            rzp.open();

        } catch (err) {
            console.error('Payment Error:', err);
            setError(err.message || 'Something went wrong. Please try again.');
            setLoading(false);
        }
    };

    return (
        <>
            {showSuccess && <PaymentSuccessModal amount={amount} onClose={() => setShowSuccess(false)} />}

            <div className="bg-white rounded-3xl shadow-sm border border-slate-100 p-8">
                <div className="flex items-center gap-3 mb-8">
                    <div className="w-10 h-10 bg-emerald-100 rounded-xl flex items-center justify-center">
                        <span className="text-xl">💳</span>
                    </div>
                    <div>
                        <h3 className="font-black text-slate-900">Secure Payment</h3>
                        <p className="text-xs text-slate-400">Powered by Razorpay · 256-bit Encrypted</p>
                    </div>
                </div>

                {/* Amount breakdown */}
                <div className="space-y-3 mb-8">
                    <div className="flex justify-between items-center text-sm text-slate-600 bg-slate-50 p-4 rounded-xl">
                        <span>Product Amount</span>
                        <span className="font-bold text-slate-900">₹{amount}</span>
                    </div>
                    <div className="flex justify-between items-center text-sm text-slate-600 bg-emerald-50 p-4 rounded-xl">
                        <span>Platform Fee</span>
                        <span className="font-bold text-emerald-600">₹0 (Free)</span>
                    </div>
                    <div className="flex justify-between items-center text-lg font-black text-slate-900 p-4 border-t-2 border-dashed border-slate-200">
                        <span>Total Payable</span>
                        <span className="text-emerald-700">₹{amount}</span>
                    </div>
                </div>

                {/* Error */}
                {error && (
                    <div className="mb-4 p-3 bg-red-50 border border-red-100 rounded-xl text-red-600 text-sm font-medium flex items-center gap-2">
                        <span>⚠️</span> {error}
                    </div>
                )}

                {/* Pay button */}
                <button
                    onClick={handlePayment}
                    disabled={loading}
                    className={`w-full py-5 rounded-2xl font-black text-white text-lg transition-all duration-300 flex items-center justify-center gap-3
                        ${loading
                            ? 'bg-slate-300 cursor-not-allowed'
                            : 'bg-emerald-600 hover:bg-emerald-700 hover:scale-[1.02] shadow-xl shadow-emerald-200 active:scale-95'
                        }`}
                >
                    {loading ? (
                        <>
                            <span className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                            Processing...
                        </>
                    ) : (
                        <>🔒 Pay ₹{amount} Securely</>
                    )}
                </button>

                <p className="text-center text-xs text-slate-400 mt-4">
                    Your payment is held safely until delivery is confirmed
                </p>
            </div>
        </>
    );
};

export default EscrowCheckout;
