import React, { useEffect, useState } from 'react';
import { supabase } from '../services/supabase';
import { useAuth } from '../context/AuthContext';
import Navbar from '../components/Navbar';

const ConfirmedOrders = () => {
    const { user } = useAuth();
    const [orders, setOrders] = useState([]);
    const [loading, setLoading] = useState(true);

    // Custom UI states (Replacing browser popups)
    const [confirmModal, setConfirmModal] = useState({ show: false, orderId: null });
    const [statusToast, setStatusToast] = useState({ show: false, type: 'success', text: '' });

    useEffect(() => {
        if (user) fetchConfirmedOrders();
    }, [user]);

    const fetchConfirmedOrders = async () => {
        setLoading(true);
        const { data, error } = await supabase
            .from('orders')
            .select('*, product:products(*)')
            .eq('buyer_id', user.id)
            .in('status', ['confirmed', 'SHIPPED', 'PAID']);
        
        if (!error) setOrders(data || []);
        setLoading(false);
    };

    const handleConfirmDelivery = async (id) => {
        try {
            const res = await fetch('http://localhost:5001/api/escrow/confirm-delivery', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ order_id: id })
            });
            const data = await res.json();
            if(data.success) {
                setConfirmModal({ show: false, orderId: null });
                setStatusToast({ show: true, type: 'success', text: 'Payment Released to Farmer! 🌾✅' });
                fetchConfirmedOrders();
                setTimeout(() => setStatusToast({ show: false, type: 'success', text: '' }), 4000);
            }
        } catch (err) {
            setStatusToast({ show: true, type: 'error', text: 'Failed: ' + err.message });
            setTimeout(() => setStatusToast({ show: false, type: 'error', text: '' }), 4000);
        }
    };

    return (
        <div className="min-h-screen bg-slate-50">
            <Navbar />
            <div className="max-w-6xl mx-auto p-6 py-24">
                <header className="mb-10 flex flex-col md:flex-row justify-between items-center bg-white p-8 rounded-[32px] shadow-sm border border-slate-100">
                    <div>
                        <h1 className="text-3xl font-black text-slate-900 font-playfair mb-1 tracking-tight">Active Shipments 🚚</h1>
                        <p className="text-slate-500 font-medium text-sm">Secure transactions currently in progress.</p>
                    </div>
                    <button onClick={() => window.location.href='/products'} className="bg-emerald-600 text-white px-8 py-4 rounded-2xl font-black text-xs uppercase tracking-widest shadow-lg hover:bg-emerald-700 transition-all">Go to Marketplace</button>
                </header>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
                    {orders.map(order => (
                        <div key={order.id} className="bg-white rounded-[32px] overflow-hidden shadow-sm border border-slate-100 hover:shadow-xl transition-all group">
                            <div className="h-48 relative overflow-hidden">
                                <img src={order.product?.image_url_1} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" />
                                <div className="absolute top-4 right-4 bg-emerald-500/90 text-white px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-wider backdrop-blur-md">
                                    {order.status}
                                </div>
                            </div>
                            
                            <div className="p-8">
                                <h3 className="text-xl font-black text-slate-900 mb-2 truncate">{order.product?.name}</h3>
                                <p className="text-[10px] text-slate-400 font-black uppercase tracking-widest mb-6">Quantity: {order.quantity} {order.unit_at_order || order.product?.unit}</p>
                                
                                <div className="bg-slate-50 p-4 rounded-2xl mb-6 border border-slate-100">
                                    <div className="flex justify-between items-center mb-1">
                                        <p className="text-[10px] text-slate-400 font-bold uppercase tracking-tighter">Order Amount</p>
                                        <p className="text-xl font-black text-slate-900">₹{order.total_price}</p>
                                    </div>
                                    <p className="text-[9px] text-emerald-600 font-black uppercase flex items-center gap-1.5 mt-1 tracking-widest">
                                        🛡️ ESCROW PROTECTED
                                    </p>
                                </div>

                                {order.status === 'confirmed' || order.status === 'SHIPPED' ? (
                                    <button 
                                        onClick={() => setConfirmModal({ show: true, orderId: order.id })}
                                        className="w-full py-4 bg-emerald-600 hover:bg-emerald-700 text-white font-black text-xs uppercase rounded-2xl shadow-xl shadow-emerald-100 transition-all active:scale-95 flex items-center justify-center gap-2"
                                    >
                                        📦 Confirm Delivered
                                    </button>
                                ) : (
                                    <div className="text-center py-4 italic text-[10px] text-slate-400 font-black uppercase tracking-[0.2em] bg-slate-50 border border-slate-100/50 rounded-2xl">
                                        Waiting for Processor Approval
                                    </div>
                                )}
                            </div>
                        </div>
                    ))}
                    {orders.length === 0 && !loading && (
                        <div className="col-span-full py-32 text-center bg-white rounded-[48px] border-2 border-dashed border-slate-200">
                            <span className="text-5xl block mb-4">🌿</span>
                            <p className="text-slate-400 font-black uppercase tracking-widest text-xs">No Active Secured Orders Found</p>
                        </div>
                    )}
                </div>
            </div>

            {/* Custom Confirm Modal */}
            {confirmModal.show && (
                <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
                    <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" onClick={() => setConfirmModal({ show: false, orderId: null })} />
                    <div className="relative bg-white w-full max-w-sm rounded-[40px] p-10 shadow-2xl text-center animate-in zoom-in-95 duration-300">
                        <div className="w-20 h-20 bg-emerald-100 text-emerald-600 text-4xl flex items-center justify-center rounded-3xl mx-auto mb-6">🛡️</div>
                        <h3 className="text-2xl font-black text-slate-900 mb-4">Release Payment?</h3>
                        <p className="text-sm text-slate-500 font-medium mb-10 leading-relaxed px-4">
                            Is your product delivered? After confirmation, your held payment will be released to the farmer.
                        </p>
                        <div className="flex gap-4">
                            <button 
                                onClick={() => setConfirmModal({ show: false, orderId: null })}
                                className="flex-1 py-4 rounded-2xl font-black text-[10px] uppercase border-2 border-slate-100 text-slate-400 hover:bg-slate-50 transition-all"
                            >
                                Not Yet
                            </button>
                            <button 
                                onClick={() => handleConfirmDelivery(confirmModal.orderId)}
                                className="flex-2 bg-emerald-600 text-white px-8 py-4 rounded-2xl font-black text-[10px] uppercase shadow-lg shadow-emerald-200 hover:scale-105 active:scale-95 transition-all"
                            >
                                Yes, Confirm
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Success/Error Toast */}
            {statusToast.show && (
                <div className={`fixed bottom-10 left-1/2 -translate-x-1/2 z-[300] px-10 py-5 rounded-3xl shadow-2xl text-[10px] font-black uppercase tracking-[0.2em] flex items-center gap-3 animate-in slide-in-from-bottom-10 duration-500 ${statusToast.type === 'success' ? 'bg-emerald-600 text-white' : 'bg-red-500 text-white'}`}>
                    <span>{statusToast.type === 'success' ? '✨' : '⚠️'}</span>
                    {statusToast.text}
                </div>
            )}
        </div>
    );
};

export default ConfirmedOrders;
