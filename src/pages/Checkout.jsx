import React, { useEffect, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../services/supabase';
import Navbar from '../components/Navbar';
import Footer from '../components/Footer';
import EscrowCheckout from '../components/EscrowCheckout';

const Checkout = () => {
    const [params] = useSearchParams();
    const { user } = useAuth();
    const navigate = useNavigate();
    const orderId = params.get('orderId');
    const productId = params.get('productId');
    const [product, setProduct] = useState(null);
    const [order, setOrder] = useState(null);
    const [quantity, setQuantity] = useState(1);
    const [address, setAddress] = useState('');
    const [phone, setPhone] = useState('');
    const [buyerName, setBuyerName] = useState('');
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        if (!user) return;
        const load = async () => {
            try {
                const { data: profile } = await supabase.from('profiles')
                    .select('address,phone_number,phone').eq('id', user.id).single();
                setAddress(profile?.address || '');
                setBuyerName([profile?.first_name, profile?.last_name].filter(Boolean).join(' '));
                setPhone(profile?.phone_number || profile?.phone || '');

                let selectedProductId = productId;
                if (orderId) {
                    const { data, error: orderError } = await supabase.from('orders')
                        .select('*').eq('id', orderId).eq('buyer_id', user.id).single();
                    if (orderError) throw orderError;
                    if (data.status !== 'confirmed') throw new Error('Payment is available only after farmer approval.');
                    setOrder(data);
                    setQuantity(data.quantity);
                    setAddress(data.delivery_address || profile?.address || '');
                    setPhone(data.buyer_phone || profile?.phone_number || profile?.phone || '');
                    selectedProductId = data.product_id;
                }
                if (!selectedProductId) throw new Error('Product or approved order not found.');
                const { data: item, error: productError } = await supabase.from('products')
                    .select('id,name,user_price,price,quantity,unit,farmer_id')
                    .eq('id', selectedProductId).single();
                if (productError) throw productError;
                setProduct(item);
            } catch (err) {
                setError(err.message || 'Unable to load checkout.');
            } finally {
                setLoading(false);
            }
        };
        load();
    }, [user?.id, orderId, productId]);

    const unit = product?.unit || 'kg';
    const multiplier = unit === 'quintal' ? 100 : 1;
    const total = order?.total_price ?? Number(product?.user_price ?? product?.price) * Number(quantity) * multiplier;

    const placeRequest = async (event) => {
        event.preventDefault();
        const qty = Number(quantity);
        if (!Number.isFinite(qty) || qty <= 0 || !address.trim()) {
            setError('Enter a valid quantity and delivery address.');
            return;
        }
        if (qty * multiplier > Number(product.quantity)) {
            setError('Requested quantity is greater than available stock.');
            return;
        }
        setSaving(true);
        setError('');
        try {
            const { error: insertError } = await supabase.from('orders').insert({
                buyer_id: user.id, farmer_id: product.farmer_id, product_id: product.id, buyer_name: buyerName,
                quantity: qty, unit_at_order: unit, total_price: total, status: 'pending',
                delivery_address: address.trim(), buyer_phone: phone.trim(),
            });
            if (insertError) throw insertError;
            navigate('/buyer-dashboard?tab=My%20Orders');
        } catch (err) {
            setError(err.message || 'Could not place order request.');
        } finally {
            setSaving(false);
        }
    };

    if (!user) return <main className="min-h-screen grid place-items-center"><button onClick={() => navigate('/login')}>Login to continue</button></main>;

    return (
        <div className="min-h-screen bg-gradient-to-br from-slate-50 to-emerald-50/30 flex flex-col">
            <Navbar />
            <main className="flex-grow pt-32 pb-20 px-[5%] max-w-[1000px] mx-auto w-full">
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-start">
                    <section className="bg-white p-7 rounded-3xl shadow-sm border border-slate-100">
                        <p className="text-xs font-black uppercase tracking-widest text-emerald-600 mb-2">
                            {order ? 'Farmer approved' : 'Order request'}
                        </p>
                        <h1 className="text-3xl font-black text-slate-900 mb-5">{order ? 'Secure Payment' : 'Request a Product'}</h1>
                        {loading ? <p>Loading checkout...</p> : error && !product ? <p className="text-red-600">{error}</p> : product && (
                            <>
                                <h2 className="text-xl font-bold">{product.name}</h2>
                                <p className="text-emerald-700 font-bold mt-2">₹{total || 0}</p>
                                {!order && (
                                    <form onSubmit={placeRequest} className="mt-6 space-y-4">
                                        <label className="block text-sm font-semibold">Quantity ({unit})
                                            <input className="mt-1 w-full border rounded-xl p-3" type="number" min="0.01" step="0.01" max={Number(product.quantity) / multiplier} value={quantity} onChange={e => setQuantity(e.target.value)} required />
                                        </label>
                                        <label className="block text-sm font-semibold">Delivery address
                                            <textarea className="mt-1 w-full border rounded-xl p-3" value={address} onChange={e => setAddress(e.target.value)} required />
                                        </label>
                                        <label className="block text-sm font-semibold">Phone number
                                            <input className="mt-1 w-full border rounded-xl p-3" value={phone} onChange={e => setPhone(e.target.value)} />
                                        </label>
                                        {error && <p className="text-sm text-red-600">{error}</p>}
                                        <button disabled={saving} className="w-full bg-emerald-600 text-white rounded-xl p-4 font-bold disabled:opacity-50">
                                            {saving ? 'Sending request...' : 'Send order request'}
                                        </button>
                                        <p className="text-xs text-slate-500">Payment becomes available after the farmer approves your request.</p>
                                    </form>
                                )}
                                {order && <p className="text-sm text-slate-500 mt-3">Your approved order is ready for payment.</p>}
                            </>
                        )}
                    </section>
                    {order && product && !loading && (
                        <EscrowCheckout orderId={order.id} amount={order.total_price} productName={product.name} />
                    )}
                </div>
            </main>
            <Footer />
        </div>
    );
};

export default Checkout;
