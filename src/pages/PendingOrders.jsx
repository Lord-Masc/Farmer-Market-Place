import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../services/supabase';

const PendingOrders = () => {
    const { user } = useAuth();
    const navigate = useNavigate();
    const [loading, setLoading] = useState(true);
    const [orders, setOrders] = useState([]);

    useEffect(() => {
        if (!user) {
            navigate('/login');
            return;
        }
        fetchPendingOrders();
    }, [user]);

    const fetchPendingOrders = async () => {
        setLoading(true);
        try {
            const { data, error } = await supabase
                .from('orders')
                .select(`
                    *,
                    product:products(*)
                `)
                .eq('buyer_id', user.id)
                .eq('status', 'PENDING')
                .order('created_at', { ascending: false });

            if (error) throw error;
            setOrders(data);
        } catch (err) {
            console.error(err);
        } finally {
            setLoading(false);
        }
    };

    if (loading) return <div className="min-h-screen bg-cream flex justify-center items-center font-bold">Waiting for pending requests...</div>;

    return (
        <div className="min-h-screen bg-cream font-dmsans p-6 md:p-12">
            <div className="max-w-5xl mx-auto">
                <Link to="/buyer-dashboard" className="inline-flex items-center gap-2 text-green-deep font-bold mb-8 hover:text-amber transition-colors">
                    ← Back to Dashboard
                </Link>

                <header className="mb-10 flex flex-col md:flex-row justify-between items-start md:items-center border-b border-cream-dark pb-6">
                    <div>
                        <h1 className="font-playfair text-4xl font-black text-green-deep">Pending Requests</h1>
                        <p className="text-gray-500 mt-2">Connecting with farmers... These harvests are awaiting confirmation.</p>
                    </div>
                </header>

                <div className="bg-white rounded-3xl border border-cream-dark overflow-hidden shadow-sm">
                    <table className="w-full text-left">
                        <thead className="bg-cream/50 text-[10px] font-black uppercase text-gray-400">
                            <tr><th className="p-6">Harvest Item</th><th className="p-6">Farmer Request Date</th><th className="p-6">Expected Cost</th><th className="p-6 text-right">Status</th></tr>
                        </thead>
                        <tbody className="divide-y divide-cream-dark">
                            {orders.map(order => (
                                <tr key={order.id} className="hover:bg-cream/10 transition-colors">
                                    <td className="p-6">
                                        <div className="flex items-center gap-4">
                                            <div className="w-12 h-12 rounded-xl overflow-hidden bg-cream border border-cream-dark">
                                                <img src={order.product?.image_url_1} className="w-full h-full object-cover" />
                                            </div>
                                            <div>
                                                <p className="text-sm font-bold text-green-deep">{order.product?.name}</p>
                                                <p className="text-[10px] text-gray-400 font-bold uppercase">{order.quantity} {order.product?.unit}</p>
                                            </div>
                                        </div>
                                    </td>
                                    <td className="p-6">
                                        <p className="text-sm font-bold text-green-deep">{new Date(order.created_at).toLocaleDateString()}</p>
                                        <p className="text-[10px] text-gray-400 font-bold uppercase">{new Date(order.created_at).toLocaleTimeString()}</p>
                                    </td>
                                    <td className="p-6">
                                        <p className="text-md font-black text-green-deep">₹{order.total_price}</p>
                                    </td>
                                    <td className="p-6 text-right">
                                        <span className="bg-amber/20 text-amber text-[10px] font-black uppercase px-4 py-1.5 rounded-full ring-2 ring-amber/5">Awaiting Farmer</span>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    {orders.length === 0 && <div className="py-20 text-center text-gray-400 italic">No pending requests at the moment. Fresh harvests are moving fast!</div>}
                </div>
            </div>
        </div>
    );
};

export default PendingOrders;
