import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../services/supabase';

const FarmerDashboard = () => {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();

  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = searchParams.get('tab') || 'Dashboard';
  const setActiveTab = (tab) => setSearchParams({ tab });
  const [profile, setProfile] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  
  // Products State
  const [showAddModal, setShowAddModal] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  const [products, setProducts] = useState([]);
  const [orders, setOrders] = useState([]);
  const [editingProduct, setEditingProduct] = useState(null);
  const [productToDelete, setProductToDelete] = useState(null);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [processingOrders, setProcessingOrders] = useState({});
  const [escrowNotification, setEscrowNotification] = useState({ show: false, orderId: null, amount: 0 });
  const [showListingSuccess, setShowListingSuccess] = useState(false);
  const [listingSuccessMsg, setListingSuccessMsg] = useState("");
  const [lightbox, setLightbox] = useState({ show: false, images: [], index: 0, productName: '' });
  
  // Form State
  const [formData, setFormData] = useState({
    name: '',
    quantity: '',
    unit: 'kg',
    user_price: '',
    description: '',
    category: 'Vegetables',
    address: ''
  });

  // Photo Upload State
  const [photo1, setPhoto1] = useState(null);
  const [photo2, setPhoto2] = useState(null);
  const [preview1, setPreview1] = useState(null);
  const [preview2, setPreview2] = useState(null);

  // Location State
  const [showLocationModal, setShowLocationModal] = useState(false);
  const [userLocation, setUserLocation] = useState(null);
  const [locationName, setLocationName] = useState('Set Farm Area');
  const [suggestions, setSuggestions] = useState([]);
  const [isSearching, setIsSearching] = useState(false);

  const reverseGeocode = (lat, lng) => {
    const fallbackGeocode = async (lat, lng) => {
        try {
            // (1) Attempt Direct Google API (Might hit CORS)
            const apiKey = 'AIzaSyBB7MHzXVXJVyBfuWfd5zvVI1KSLOcNM1A';
            const res = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${apiKey}`);
            const data = await res.json();
            if (data.results && data.results[0]) {
                const components = data.results[0].address_components;
                let city = ''; let state = ''; let dist = '';
                components.forEach(c => {
                    if (c.types.includes('locality')) city = c.long_name;
                    if (c.types.includes('administrative_area_level_2')) dist = c.long_name;
                    if (c.types.includes('administrative_area_level_1')) state = c.long_name;
                });
                setLocationName(`${city || dist || "City"}, ${state || "State"}`);
                return;
            }
        } catch (e) {
            // (2) Triple Fallback: High-speed, CORS-friendly Geocoder (BigDataCloud)
            try {
                const res = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=en`);
                const data = await res.json();
                const city = data.locality || data.city || data.principalSubdivision;
                const state = data.principalSubdivision;
                if (city && state) setLocationName(`${city}, ${state}`);
                else if (city) setLocationName(city);
                else setLocationName("Region Active");
            } catch (err) {
                setLocationName("Location Resolved");
            }
        }
    };

    if (!window.google || !window.google.maps || !window.google.maps.Geocoder) {
        fallbackGeocode(lat, lng);
        return;
    }

    const geocoder = new window.google.maps.Geocoder();
    const latlng = { lat: parseFloat(lat), lng: parseFloat(lng) };

    geocoder.geocode({ location: latlng }, (results, status) => {
        if (status === "OK" && results[0]) {
            const components = results[0].address_components;
            let city = ''; let state = ''; let dist = '';
            components.forEach(c => {
                if (c.types.includes('locality')) city = c.long_name;
                if (c.types.includes('administrative_area_level_2')) dist = c.long_name;
                if (c.types.includes('administrative_area_level_1')) state = c.long_name;
            });
            setLocationName(`${city || dist || "City"}, ${state || "State"}`);
        } else {
            fallbackGeocode(lat, lng);
        }
    });
  };

  // Custom Search Handler (Failover for Google Autocomplete)
  const handleSearchSuggestions = async (val) => {
    if (val.length < 3) { setSuggestions([]); return; }
    setIsSearching(true);
    try {
        const res = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?localityLanguage=en&address=${encodeURIComponent(val)}`);
        const data = await res.json();
        const results = [];
        if (data.locality) results.push({ name: `${data.locality}, ${data.principalSubdivision}`, lat: data.latitude, lng: data.longitude });
        
        const nomRes = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(val)}&format=json&limit=3&countrycodes=in`);
        const nomData = await nomRes.json();
        nomData.forEach(item => {
            results.push({ name: item.display_name, lat: parseFloat(item.lat), lng: parseFloat(item.lon) });
        });
        setSuggestions(results);
    } catch (err) { console.error("Search failed", err); }
    finally { setIsSearching(false); }
  };

  const handleSelectLocation = async (loc) => {
    try {
        setLoading(true);
        await supabase.from('profiles').update({ address: loc.name, latitude: loc.lat, longitude: loc.lng }).eq('id', user.id);
        setUserLocation({ lat: loc.lat, lng: loc.lng });
        setLocationName(loc.name);
        setFormData(prev => ({ ...prev, address: loc.name })); // Auto-fill product address
        setShowLocationModal(false);
    } catch (e) { alert(e.message); }
    finally { setLoading(false); }
  };

  // Wait for Google SDK to load
  useEffect(() => {
    if (userLocation && locationName === 'Set Farm Area') {
        const checkSDK = setInterval(() => {
            if (window.google && window.google.maps && window.google.maps.Geocoder) {
                reverseGeocode(userLocation.lat, userLocation.lng);
                clearInterval(checkSDK);
            }
        }, 1000);
        return () => clearInterval(checkSDK);
    }
  }, [userLocation, locationName]);

  const tabs = ['Dashboard', 'My Products', 'Orders', 'Payment Track', 'Analytics', 'Settings'];

  useEffect(() => {
    if (!user && !loading) {
      navigate('/login');
    }
  }, [user, loading, navigate]);

  useEffect(() => {
    const initFarmer = async () => {
      if (user) {
        setLoading(true);
        try {
          const { data, error } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', user.id)
            .eq('role', 'farmer')
            .single();

          if (error) {
            setError('Could not find farmer profile.');
          } else {
            setProfile(data);
            if (data.address) setFormData(prev => ({ ...prev, address: data.address }));
            if (data.latitude && data.longitude) {
                setUserLocation({ lat: data.latitude, lng: data.longitude });
                if (data.address) setLocationName(data.address);
                else reverseGeocode(data.latitude, data.longitude);
            } else {
                // Only show modal if it hasn't been dismissed in this session
                if (!sessionStorage.getItem('farmerLocationDismissed')) {
                    setShowLocationModal(true);
                }
            }
            await Promise.all([fetchMyProducts(), fetchMyOrders()]);
          }
        } catch (err) {
          setError('An unexpected error occurred.');
        } finally {
          setLoading(false);
        }
      }
    };

    let ordersSubscription;

    if (user) {
        initFarmer();
        // Enable Realtime for Orders (Farmer Side)
        ordersSubscription = supabase
          .channel('farmer-orders')
          .on('postgres_changes', { 
              event: '*', 
              schema: 'public', 
              table: 'orders',
              filter: `farmer_id=eq.${user.id}`
          }, (payload) => {
              if (payload.new && (payload.new.status === 'PAID' || payload.new.status === 'pending')) {
                  setEscrowNotification({ 
                      show: true, 
                      orderId: payload.new.id, 
                      amount: payload.new.total_price,
                      type: payload.new.status === 'PAID' ? 'payment' : 'request'
                  });
                  setTimeout(() => setEscrowNotification({ show: false, orderId: null, amount: 0 }), 8000);
              }
              // Wait a fraction to ensure consistency
              setTimeout(() => {
                  fetchMyOrders();
              }, 500);
          })
          .subscribe();
    }

    return () => {
        if (ordersSubscription) ordersSubscription.unsubscribe();
    };
  }, [user]);

  const fetchMyProducts = async () => {
    const { data, error } = await supabase.from('products').select('*').eq('farmer_id', user.id).order('created_at', { ascending: false });
    if (!error) setProducts(data);
  };

  const fetchMyOrders = async () => {
    try {
        const { data: rawOrders, error } = await supabase.from('orders').select('*').eq('farmer_id', user.id).order('created_at', { ascending: false });
        
        if (error) {
            console.error("Farmer fetch error:", error);
            return;
        }

        // Fetch products manually
        const productIds = [...new Set(rawOrders.map(o => o.product_id).filter(Boolean))];
        const { data: products } = await supabase.from('products').select('*').in('id', productIds);
        const productsMap = {};
        if (products) products.forEach(p => productsMap[p.id] = p);

        // Fetch buyers manually
        const buyerIds = [...new Set(rawOrders.map(o => o.buyer_id).filter(Boolean))];
        const { data: buyers } = await supabase.from('profiles').select('id, first_name, last_name, phone_number, phone').in('id', buyerIds);
        const buyersMap = {};
        if (buyers) buyers.forEach(b => buyersMap[b.id] = b);

        const mergedOrders = rawOrders.map(o => ({
            ...o,
            product: productsMap[o.product_id] || {},
            buyer: buyersMap[o.buyer_id] || {}
        }));

        setOrders(mergedOrders || []);
    } catch (err) {
        console.error("Farmer Orders catch:", err);
        const { data: fallback } = await supabase.from('orders').select('*').eq('farmer_id', user.id);
        if (fallback) setOrders(fallback);
    }
  };

  const handleLogout = async (e) => {
    e.preventDefault();
    await signOut();
    navigate('/login');
  };

  const handlePhotoChange = (e, slot) => {
    const file = e.target.files[0];
    if (file) {
        if (slot === 1) {
            setPhoto1(file);
            setPreview1(URL.createObjectURL(file));
        } else {
            setPhoto2(file);
            setPreview2(URL.createObjectURL(file));
        }
    }
  };

  const uploadPhoto = async (file) => {
    const fileExt = file.name.split('.').pop();
    const fileName = `${user.id}-${Math.random()}.${fileExt}`;
    const filePath = `product-items/${fileName}`;

    const { error: uploadError } = await supabase.storage
      .from('product-images')
      .upload(filePath, file);

    if (uploadError) throw uploadError;

    const { data } = supabase.storage
      .from('product-images')
      .getPublicUrl(filePath);

    return data.publicUrl;
  };

  const handlePublishProduct = async (e) => {
    e.preventDefault();
    if (!editingProduct && (!photo1 || !photo2)) {
        alert("Please upload 2 photos.");
        return;
    }
    
    setIsPublishing(true);
    try {
        let url1 = preview1;
        let url2 = preview2;

        if (photo1) url1 = await uploadPhoto(photo1);
        if (photo2) url2 = await uploadPhoto(photo2);

        // Geocode the product address
        let pLat = editingProduct?.latitude || profile?.latitude || null;
        let pLng = editingProduct?.longitude || profile?.longitude || null;
        
        if (formData.address && formData.address !== (editingProduct?.address || profile?.address)) {
            try {
                if (window.google && window.google.maps && window.google.maps.Geocoder) {
                    const geocoder = new window.google.maps.Geocoder();
                    const result = await new Promise((resolve) => {
                        geocoder.geocode({ address: formData.address }, (res, status) => {
                            if (status === 'OK' && res[0]) resolve(res[0].geometry.location);
                            else resolve(null);
                        });
                    });
                    if (result) {
                        pLat = result.lat();
                        pLng = result.lng();
                    }
                } else {
                    const apiKey = 'AIzaSyBB7MHzXVXJVyBfuWfd5zvVI1KSLOcNM1A';
                    const res = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(formData.address)}&key=${apiKey}`);
                    const data = await res.json();
                    if (data.results?.[0]) {
                        pLat = data.results[0].geometry.location.lat;
                        pLng = data.results[0].geometry.location.lng;
                    }
                }
            } catch (err) {
                console.error("Geocoding failed, using profile fallback:", err);
            }
        }

        // Final safety fallback: If geocoding failed and profile had no location either
        if (!pLat || !pLng) {
            pLat = profile?.latitude;
            pLng = profile?.longitude;
        }

        const productData = {
            ...formData,
            farmer_id: user.id,
            user_price: parseFloat(formData.user_price),
            quantity: parseFloat(formData.quantity),
            image_url_1: url1,
            image_url_2: url2,
            gov_price: 0,
            latitude: pLat,
            longitude: pLng
        };

        if (editingProduct) {
            const { error } = await supabase.from('products').update(productData).eq('id', editingProduct.id);
            if (error) throw error;
            setListingSuccessMsg("Crop Updated Successfully! 🚜✨");
            setShowListingSuccess(true);
        } else {
            const { error } = await supabase.from('products').insert([productData]);
            if (error) throw error;
            setListingSuccessMsg("Your harvest is LIVE in the marketplace! 🌾✨");
            setShowListingSuccess(true);
        }
        
        setShowAddModal(false);
        resetForm();
        fetchMyProducts();
    } catch (err) {
        alert(err.message);
    } finally {
        setIsPublishing(false);
    }
  };

  const resetForm = () => {
    setFormData({ name: '', quantity: '', unit: 'kg', user_price: '', description: '', category: 'Vegetables', address: profile?.address || '' });
    setPhoto1(null); setPhoto2(null);
    setPreview1(null); setPreview2(null);
    setEditingProduct(null);
  };

  const handleEditProduct = (product) => {
    setEditingProduct(product);
    setFormData({
      name: product.name,
      quantity: product.quantity,
      unit: product.unit,
      user_price: product.user_price,
      description: product.description || '',
      category: product.category || 'Vegetables',
      address: product.address || ''
    });
    setPreview1(product.image_url_1);
    setPreview2(product.image_url_2);
    setShowAddModal(true);
  };

  const handleDeleteProduct = async () => {
    if (!productToDelete) return;
    
    setIsDeleting(true);
    try {
        const { error } = await supabase.from('products').delete().eq('id', productToDelete.id);
        
        if (error) {
            // Detailed error handling for foreign key constraint (if product has orders)
            if (error.code === '23503') {
                throw new Error("Cannot delete this product because there are active orders for it. 📦 Please fulfill or cancel those orders first.");
            }
            throw error;
        }

        // Successfully deleted from Supabase
        setProducts(prev => prev.filter(p => p.id !== productToDelete.id));
        setShowDeleteModal(false);
        setProductToDelete(null);
        setListingSuccessMsg("Crop permanently removed from market! 🚜💨");
        setShowListingSuccess(true);
    } catch (err) {
        console.error("Delete failed:", err);
        setListingSuccessMsg("🚜 Error: " + err.message);
        setShowListingSuccess(true);
    } finally {
        setIsDeleting(false);
    }
  };

  const openDeleteModal = (product) => {
    setProductToDelete(product);
    setShowDeleteModal(true);
  };

  const handleUpdateOrderStatus = async (orderId, newStatus) => {
    if (!orderId || !newStatus) return;
    
    setProcessingOrders(prev => ({ ...prev, [orderId]: true }));
    try {
        // Step 1: Fetch the order + product details (uses farmer's auth session — RLS OK)
        const { data: orderData, error: orderError } = await supabase
            .from('orders')
            .select('*, product:products(*)')
            .eq('id', orderId)
            .single();

        if (orderError) throw new Error("Order not found: " + orderError.message);
        if (orderData.farmer_id !== user.id) throw new Error("Unauthorized: This order doesn't belong to you.");

        // Step 2: If approving ('confirmed'), reduce product stock
        if (newStatus === 'confirmed' && (orderData.status === 'pending' || orderData.status === 'CREATED')) {
            const orderQty = orderData.unit_at_order === 'quintal' ? (orderData.quantity * 100) : (orderData.quantity || 0);
            const currentStock = orderData.product?.quantity || 0;

            if (currentStock < orderQty) {
                throw new Error(`🚨 Not Enough Stock: You only have ${currentStock} KG available.`);
            }

            // Reduce Stock
            const { error: stockError } = await supabase
                .from('products')
                .update({ quantity: currentStock - orderQty })
                .eq('id', orderData.product_id);

            if (stockError) throw new Error("Stock update failed: " + stockError.message);
        }

        // Step 3: Update order status (uses farmer's auth session — RLS OK)
        const { error: updateError } = await supabase
            .from('orders')
            .update({ status: newStatus })
            .eq('id', orderId);

        if (updateError) throw new Error("Status update failed: " + updateError.message);

        // UI Update
        setOrders(prev => prev.map(o => o.id === orderId ? { ...o, status: newStatus } : o));
        
        // Data Refresh
        fetchMyOrders();
        fetchMyProducts(); 

    } catch (err) {
        console.error("Status update failed:", err);
        alert("⚠️ " + err.message);
    } finally {
        setProcessingOrders(prev => ({ ...prev, [orderId]: false }));
    }
  };

  const renderStats = () => {
    const totalEarnings = orders.filter(o => o.status === 'delivered').reduce((acc, curr) => acc + curr.total_price, 0);
    const stats = [
        { label: 'Total Earnings', value: `₹${totalEarnings || '0'}`, icon: '💰', trend: 'Lifetime income' },
        { label: 'Active Listings', value: products.length.toString(), icon: '🌾', trend: 'Live products' },
        { label: 'Pending Orders', value: orders.filter(o => o.status === 'pending').length.toString(), icon: '📦', trend: 'New orders' },
        { label: 'Farmer Rating', value: '4.8', icon: '⭐', trend: 'Very Reliable' },
    ];

    return (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 mb-10">
          {stats.map((stat, i) => (
            <div key={i} className="bg-white p-6 rounded-2xl shadow-sm border border-transparent hover:border-green-fresh transition-all group">
              <span className="text-2xl mb-4 block">{stat.icon}</span>
              <p className="text-xs text-gray-400 font-bold uppercase tracking-wider mb-1">{stat.label}</p>
              <h3 className="text-2xl font-black text-green-deep mb-2">{stat.value}</h3>
              <span className="text-xs text-green-mid font-bold">{stat.trend}</span>
            </div>
          ))}
        </div>
    );
  };

  const renderContent = () => {
    switch (activeTab) {
      case 'Dashboard':
        return (
          <>
            {renderStats()}
            <section className="bg-white rounded-3xl p-8 shadow-sm border border-cream-dark">
                <h2 className="font-playfair text-xl font-bold text-green-deep mb-6">Farmer Activity</h2>
                <div className="space-y-4">
                    {orders.slice(0, 3).map(order => (
                        <div key={order.id} className="flex items-center justify-between p-4 bg-cream/20 rounded-2xl border border-cream-dark">
                            <div className="flex items-center gap-4">
                                <span className="text-xl">💰</span>
                                <div>
                                    <p className="text-sm font-bold text-green-deep">Received order for {order.product?.name}</p>
                                    <p className="text-[10px] text-gray-400 uppercase font-black">{new Date(order.created_at).toLocaleDateString()}</p>
                                </div>
                            </div>
                            <span className="bg-amber/20 text-amber px-3 py-1 rounded-full text-[10px] font-black uppercase">{order.status}</span>
                        </div>
                    ))}
                    {orders.length === 0 && <p className="text-center py-20 text-gray-400 italic">No activity yet. Your fields are quiet!</p>}
                </div>
            </section>
          </>
        );
      case 'My Products':
        return (
            <div className="space-y-6">
                <div className="flex justify-between items-center">
                    <h2 className="font-playfair text-2xl font-bold text-green-deep">My Harvest</h2>
                    <button onClick={() => setShowAddModal(true)} className="bg-green-deep text-white px-6 py-2 rounded-xl font-bold">+ List New Crop</button>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {products.map(p => (
                        <div key={p.id} className="bg-white rounded-2xl overflow-hidden shadow-sm border border-cream-dark hover:shadow-xl transition-all group">
                             <div className="h-56 bg-cream overflow-hidden relative group/img cursor-zoom-in" onClick={() => setLightbox({ show: true, images: [p.image_url_1, p.image_url_2].filter(Boolean), index: 0, productName: p.name })}>
                                 <img src={p.image_url_1} className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-700" alt={p.name} />
                                 {p.image_url_2 && (
                                     <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex gap-1.5 bg-black/20 backdrop-blur-md px-3 py-1.5 rounded-full ring-1 ring-white/20">
                                         <div className="w-1.5 h-1.5 rounded-full bg-white shadow-sm"></div>
                                         <div className="w-1.5 h-1.5 rounded-full bg-white/40 shadow-sm"></div>
                                     </div>
                                 )}
                                 <div className="absolute top-4 right-4 bg-green-deep/90 backdrop-blur px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-wider text-white shadow-lg ring-1 ring-white/20">
                                     {p.category}
                                  </div>
                                  <div className="absolute inset-0 bg-black/20 opacity-0 group-hover/img:opacity-100 transition-opacity flex items-center justify-center text-white text-xs font-black uppercase tracking-[0.2em] backdrop-grayscale-[0.5]">
                                      View Photos 🔍
                                  </div>
                             </div>
                            <div className="p-5 text-left">
                                <h3 className="font-bold text-green-deep text-lg mb-1">{p.name}</h3>
                                <div className="flex justify-between items-baseline">
                                    <p className="text-xl font-black text-green-deep">₹{p.user_price}<span className="text-xs font-medium text-gray-400">/{p.unit}</span></p>
                                    <p className="text-[10px] font-black text-green-mid uppercase">{p.quantity} {p.unit} available</p>
                                </div>
                                <div className="text-[10px] font-black text-amber uppercase mt-2 flex items-center gap-1">
                                    <span className="text-xs">📍</span> {p.address || 'Field Location'}
                                </div>
                                
                                <div className="mt-4 pt-4 border-t border-cream-dark flex gap-3">
                                    <button 
                                        onClick={() => handleEditProduct(p)}
                                        className="flex-1 bg-green-fresh/10 text-green-fresh py-2 rounded-xl text-[10px] font-black uppercase hover:bg-green-fresh hover:text-white transition-all flex items-center justify-center gap-1"
                                    >
                                        <span>✏</span> Edit
                                    </button>
                                    <button 
                                        onClick={() => openDeleteModal(p)}
                                        className="flex-1 bg-red-400/10 text-red-400 py-2 rounded-xl text-[10px] font-black uppercase hover:bg-red-400 hover:text-white transition-all flex items-center justify-center gap-1"
                                    >
                                        <span>🗑</span> Delete
                                    </button>
                                </div>

                                <div className="mt-3 flex justify-between items-center opacity-40">
                                    <span className="text-[10px] font-black text-green-mid uppercase">Live in Market</span>
                                    <span className="text-[10px] font-bold text-gray-400">ID: {p.id.slice(0, 8)}</span>
                                </div>
                            </div>
                        </div>
                    ))}
                    {products.length === 0 && (
                        <div className="col-span-full py-20 text-center border-4 border-dashed border-cream-dark rounded-[48px]">
                            <p className="text-gray-400 font-bold italic mb-4 text-xl">Your field is empty...</p>
                            <button onClick={() => setShowAddModal(true)} className="bg-amber text-green-deep px-8 py-3 rounded-2xl font-black text-sm shadow-xl hover:scale-105 active:scale-95 transition-all uppercase tracking-widest">+ List First Product</button>
                        </div>
                    )}
                </div>
            </div>
        );
      case 'Orders':
        return (
            <div className="bg-white rounded-3xl shadow-sm border border-cream-dark overflow-hidden">
                <div className="overflow-x-auto">
                    <table className="w-full text-left">
                        <thead className="bg-cream/50 text-[10px] font-black uppercase text-gray-400">
                            <tr>
                                <th className="p-6">Product</th>
                                <th className="p-6">Buyer</th>
                                <th className="p-6">Total</th>
                                <th className="p-6">Status</th>
                                <th className="p-6">Action</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-cream-dark">
                            {orders.map(order => (
                                <tr key={order.id} className="hover:bg-cream/5 transition-colors">
                                    <td className="p-6">
                                        <p className="text-sm font-black text-green-deep">{order.product?.name}</p>
                                        <p className="text-[10px] text-gray-400 font-bold uppercase mt-0.5">Order Quantity: <span className="text-amber">{order.quantity} {order.unit_at_order || order.product?.unit}</span></p>
                                    </td>
                                    <td className="p-6">
                                        <div className="flex flex-col gap-1">
                                            <p className="text-sm font-bold text-green-deep uppercase tracking-tighter">👤 {order.buyer?.first_name} {order.buyer?.last_name || ''}</p>
                                            <div className="flex flex-col">
                                                <p className="text-[10px] text-gray-400 font-bold uppercase">🏠 TO: {order.delivery_address || 'Profile Location'}</p>
                                                <p className="text-[10px] text-green-fresh font-black tracking-widest mt-0.5">📞 {order.buyer_phone || order.buyer?.phone_number || order.buyer?.phone || 'No Phone'}</p>
                                            </div>
                                        </div>
                                    </td>
                                    <td className="p-6">
                                        <p className="text-sm font-black text-green-deep">₹{order.total_price}</p>
                                        <p className="text-[9px] text-gray-300 font-black uppercase mt-1">{new Date(order.created_at).toLocaleDateString()}</p>
                                    </td>
                                    <td className="p-6">
                                        <div className="flex flex-col items-start gap-1">
                                            <span className={`px-3 py-1 rounded-full text-[9px] font-black uppercase ${
                                                (order.status === 'pending' || order.status === 'CREATED' || order.status === 'PAID') ? 'bg-amber/20 text-amber' : 
                                                order.status === 'confirmed' ? 'bg-green-deep text-amber border border-amber/10 shadow-sm' : 
                                                (order.status === 'delivered' || order.status === 'COMPLETED') ? 'bg-green-fresh text-white shadow-md' : 
                                                order.status === 'declined' ? 'bg-red-500/20 text-red-600' :
                                                order.status === 'SHIPPED' ? 'bg-blue-100 text-blue-600' :
                                                'bg-green-fresh/20 text-green-fresh'
                                            }`}>
                                                {(order.status === 'pending' || order.status === 'CREATED') ? 'New Request' : 
                                                 order.status === 'PAID' ? 'Payment Held (Escrow)' :
                                                 (order.status === 'delivered' || order.status === 'COMPLETED') ? 'Completed & Released' : 
                                                 order.status === 'declined' ? 'Request Rejected' :
                                                 order.status}
                                            </span>
                                        </div>
                                    </td>
                                    <td className="p-6">
                                        <div className="flex gap-2">
                                            {(order.status === 'pending' || order.status === 'CREATED') && (
                                                <>
                                                    <button 
                                                        onClick={() => handleUpdateOrderStatus(order.id, 'confirmed')} 
                                                        className="bg-green-deep text-[9px] uppercase font-black px-4 py-2 rounded-xl text-amber shadow-lg hover:scale-105 active:scale-95 transition-all flex items-center gap-1 border border-amber/20"
                                                    >
                                                        <span>✅</span> Approve
                                                    </button>
                                                    <button 
                                                        onClick={() => handleUpdateOrderStatus(order.id, 'declined')} 
                                                        className="bg-red-50/50 text-[9px] uppercase font-black px-4 py-2 rounded-xl text-red-600 shadow-md hover:bg-red-100 active:scale-95 transition-all flex items-center gap-1 border border-red-200"
                                                    >
                                                        <span>❌</span> Decline
                                                    </button>
                                                </>
                                            )}
                                            {order.status === 'confirmed' && (
                                                <span className="text-[10px] font-black text-amber uppercase italic flex items-center gap-1 opacity-70">
                                                    <span>⏳</span> Waiting for Payment...
                                                </span>
                                            )}
                                            {order.status === 'PAID' && (
                                                <span className="text-[10px] font-black text-green-fresh uppercase italic flex items-center gap-1 opacity-90 animate-pulse">
                                                    <span>📦</span> Payment Held. Dispatch Now!
                                                </span>
                                            )}
                                            {(order.status === 'delivered' || order.status === 'COMPLETED') && (
                                                <span className="text-[10px] font-black text-green-fresh uppercase italic flex items-center gap-1">
                                                    <span>💎</span> Paid & Completed
                                                </span>
                                            )}
                                            {order.status === 'declined' && (
                                                <span className="text-[10px] font-black text-red-400 uppercase italic">
                                                    Order Rejected
                                                </span>
                                            )}
                                        </div>
                                    </td>
                                </tr>
                            ))}
                            {orders.length === 0 && (
                                <tr><td colSpan="5" className="p-20 text-center text-gray-400 italic">No sales yet.</td></tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>
        );
      case 'Analytics': {
          const deliveredOrders = orders.filter(o => o.status === 'delivered');
          const totalRevenue = deliveredOrders.reduce((acc, curr) => acc + curr.total_price, 0);
          const fulfilledVolume = deliveredOrders.reduce((acc, curr) => acc + curr.quantity, 0);
          const avgOrderValue = deliveredOrders.length > 0 ? Math.round(totalRevenue / deliveredOrders.length) : 0;
          const rejectionRate = orders.length > 0 ? Math.round((orders.filter(o => o.status === 'declined').length / orders.length) * 100) : 0;

          // Simple grouping for crop breakdown
          const cropStats = {};
          deliveredOrders.forEach(o => {
              const name = o.product?.name || 'Unknown';
              cropStats[name] = (cropStats[name] || 0) + o.total_price;
          });

          return (
              <div className="space-y-8">
                  {/* Top Level KPIs */}
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                      <div className="bg-white p-8 rounded-[32px] shadow-sm border border-cream-dark group hover:border-green-fresh transition-all">
                          <p className="text-[10px] font-black uppercase text-gray-400 tracking-widest mb-2">Net Sales</p>
                          <h3 className="text-4xl font-black text-green-deep">₹{totalRevenue}</h3>
                          <div className="mt-4 flex items-center gap-2">
                              <span className="text-green-fresh font-black text-xs">↑ 12%</span>
                              <span className="text-[10px] font-bold text-gray-300 uppercase">vs last month</span>
                          </div>
                      </div>
                      <div className="bg-white p-8 rounded-[32px] shadow-sm border border-cream-dark group hover:border-amber transition-all">
                          <p className="text-[10px] font-black uppercase text-gray-400 tracking-widest mb-2">Avg Order</p>
                          <h3 className="text-4xl font-black text-green-deep">₹{avgOrderValue}</h3>
                          <div className="mt-4 flex items-center gap-2">
                              <span className="text-amber font-black text-xs">⭐ High Value</span>
                              <span className="text-[10px] font-bold text-gray-300 uppercase">Per Transaction</span>
                          </div>
                      </div>
                      <div className="bg-white p-8 rounded-[32px] shadow-sm border border-cream-dark group hover:border-red-400 transition-all">
                          <p className="text-[10px] font-black uppercase text-gray-400 tracking-widest mb-2">Inquiry Lost</p>
                          <h3 className="text-4xl font-black text-red-400">{rejectionRate}%</h3>
                          <div className="mt-4 flex items-center gap-2">
                              <span className="text-[10px] font-bold text-gray-300 uppercase">Rejection benchmark</span>
                          </div>
                      </div>
                  </div>

                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                      {/* Revenue Visualization (CSS Bars) */}
                      <div className="bg-white p-10 rounded-[40px] shadow-sm border border-cream-dark">
                          <div className="flex justify-between items-center mb-10">
                              <h3 className="font-playfair text-xl font-bold text-green-deep">Sales Intensity</h3>
                              <span className="text-[10px] font-black uppercase text-gray-300">Last 7 Days</span>
                          </div>
                          <div className="flex items-end justify-between gap-2 h-40">
                              {[40, 70, 45, 90, 65, 30, 85].map((h, i) => (
                                  <div key={i} className="flex-1 flex flex-col items-center gap-3 group px-1">
                                      <div className="w-full bg-cream rounded-full relative overflow-hidden h-full">
                                          <div 
                                            className="absolute bottom-0 left-0 right-0 bg-green-fresh group-hover:bg-amber transition-all rounded-full"
                                            style={{ height: `${h}%` }}
                                          ></div>
                                      </div>
                                      <span className="text-[8px] font-black uppercase text-gray-400">Day {i+1}</span>
                                  </div>
                              ))}
                          </div>
                      </div>

                      {/* Best Sellers */}
                      <div className="bg-white p-10 rounded-[40px] shadow-sm border border-cream-dark">
                          <h3 className="font-playfair text-xl font-bold text-green-deep mb-8">Crop Revenue Split</h3>
                          <div className="space-y-6">
                              {Object.entries(cropStats).length > 0 ? Object.entries(cropStats).map(([name, revenue], i) => (
                                  <div key={i} className="space-y-2">
                                      <div className="flex justify-between items-center">
                                          <span className="text-[10px] font-black uppercase text-green-deep">{name}</span>
                                          <span className="text-[10px] font-black text-amber">₹{revenue}</span>
                                      </div>
                                      <div className="w-full h-1.5 bg-cream rounded-full overflow-hidden">
                                          <div 
                                              className="h-full bg-green-deep rounded-full"
                                              style={{ width: `${Math.min(100, (revenue/totalRevenue)*100)}%` }}
                                          ></div>
                                      </div>
                                  </div>
                              )) : (
                                  <div className="py-20 text-center opacity-30 italic text-sm">No sales data recorded for breakdown.</div>
                              )}
                          </div>
                      </div>
                  </div>

                  {/* Harvest Performance Table */}
                  <div className="bg-green-deep rounded-[40px] p-10 text-white relative overflow-hidden">
                      <div className="absolute top-0 right-0 w-64 h-64 bg-white/5 rounded-full -mr-20 -mt-20 blur-3xl"></div>
                      <div className="relative z-10 flex flex-col md:flex-row justify-between items-center gap-8">
                          <div>
                              <h3 className="text-3xl font-playfair font-black mb-2">Efficiency Rating</h3>
                              <p className="text-white/60 text-sm font-medium">You have fulfilled <span className="text-amber font-black">{fulfilledVolume} {profile?.unit || 'KG'}</span> this month!</p>
                          </div>
                          <div className="flex gap-4">
                              <div className="text-center p-6 bg-white/10 rounded-3xl border border-white/10">
                                  <p className="text-[10px] font-bold uppercase tracking-widest opacity-60 mb-1">Growth</p>
                                  <p className="text-2xl font-black text-amber">+18%</p>
                              </div>
                              <div className="text-center p-6 bg-white/10 rounded-3xl border border-white/10">
                                  <p className="text-[10px] font-bold uppercase tracking-widest opacity-60 mb-1">Impact</p>
                                  <p className="text-2xl font-black text-green-fresh">High</p>
                              </div>
                          </div>
                      </div>
                  </div>
              </div>
          );
      }
      case 'Settings':
        return (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-10">
                {/* Profile Card */}
                <div className="lg:col-span-1 bg-white rounded-[40px] p-8 shadow-sm border border-cream-dark text-center flex flex-col items-center">
                    <div className="relative group mb-6">
                        <div className="w-32 h-32 rounded-full bg-cream border-4 border-green-fresh ring-4 ring-green-fresh/10 flex items-center justify-center overflow-hidden shadow-2xl transition-all group-hover:scale-105">
                             {profile?.photo_url ? (
                                 <img src={profile.photo_url} className="w-full h-full object-cover" />
                             ) : (
                                 <span className="text-4xl font-black text-green-deep opacity-20">{profile?.first_name?.charAt(0)}</span>
                             )}
                        </div>
                        <label className="absolute bottom-0 right-0 bg-green-deep text-white w-10 h-10 rounded-full flex items-center justify-center shadow-lg border-4 border-white cursor-pointer hover:bg-green-fresh transition-all">
                             📸
                             <input type="file" className="hidden" onChange={async (e) => {
                                 const file = e.target.files[0];
                                 if (file) {
                                     try {
                                         const fileName = `farmer-p-${user.id}-${Date.now()}`;
                                         const { error: uploadError } = await supabase.storage.from('product-images').upload(fileName, file);
                                         if (uploadError) throw uploadError;
                                         const { data } = supabase.storage.from('product-images').getPublicUrl(fileName);
                                         await supabase.from('profiles').update({ photo_url: data.publicUrl }).eq('id', user.id);
                                         window.location.reload();
                                     } catch (err) { alert(err.message); }
                                 }
                             }} />
                        </label>
                    </div>
                    <h3 className="text-2xl font-black text-green-deep font-playfair">{profile?.first_name} {profile?.last_name}</h3>
                    <p className="text-[10px] font-black uppercase text-green-fresh tracking-widest mt-1">Verified Agro-Farmer</p>
                    
                    <div className="w-full mt-10 space-y-4 border-t border-cream-dark pt-8 text-left">
                        <div className="flex justify-between items-center bg-cream/30 p-3 rounded-xl border border-cream-dark/50">
                            <div>
                                <p className="text-[10px] font-black uppercase text-gray-400">Farm Location</p>
                                <p className="text-sm font-bold text-green-fresh">{profile?.latitude ? '📍 Geo-Tagged' : '⚠ Missing Geotag'}</p>
                            </div>
                            <button onClick={() => setShowLocationModal(true)} className="text-xs font-black uppercase text-amber hover:underline">Update</button>
                        </div>
                        <div className="flex justify-between items-center bg-cream/30 p-3 rounded-xl border border-cream-dark/50">
                            <div>
                                <p className="text-[10px] font-black uppercase text-gray-400">Public Contact</p>
                                <p className={`text-sm font-bold ${profile?.phone_number ? 'text-green-fresh' : 'text-red-400 animate-pulse'}`}>
                                    {profile?.phone_number ? `📞 ${profile.phone_number}` : '⚠ Missing Phone'}
                                </p>
                            </div>
                            <button onClick={() => setActiveTab('Settings')} className="text-xs font-black uppercase text-amber hover:underline">Settings</button>
                        </div>
                    </div>
                </div>

                {/* Edit Section */}
                <div className="lg:col-span-2 bg-white rounded-[40px] p-10 shadow-sm border border-cream-dark">
                    <h3 className="text-xl font-bold text-green-deep mb-8 font-playfair">Farmer Dossier</h3>
                    <form className="space-y-6" onSubmit={async (e) => {
                        e.preventDefault();
                        const formData = new FormData(e.target);
                        const address = formData.get('address')?.trim();

                        if (!address) {
                            alert("🚜 Action Required: Please provide your Farm/Home address to list your harvest.");
                            return;
                        }

                        const updates = {
                            first_name: formData.get('first_name'),
                            last_name: formData.get('last_name'),
                            phone_number: formData.get('phone_number'),
                            address: address,
                        };
                        try {
                            const { error } = await supabase.from('profiles').update(updates).eq('id', user.id);
                            if (error) throw error;
                            alert("Harvest profile updated! ✨");
                            window.location.reload();
                        } catch (err) { alert(err.message); }
                    }}>
                        <div className="grid grid-cols-2 gap-6">
                            <div className="space-y-1.5 text-left">
                                <label className="text-[10px] font-black uppercase text-gray-400 ml-1 tracking-widest">First Name</label>
                                <input name="first_name" defaultValue={profile?.first_name} className="w-full bg-cream/50 border border-transparent focus:border-green-fresh focus:bg-white px-5 py-3 rounded-2xl outline-none transition-all font-bold" />
                            </div>
                            <div className="space-y-1.5 text-left">
                                <label className="text-[10px] font-black uppercase text-gray-400 ml-1 tracking-widest">Last Name</label>
                                <input name="last_name" defaultValue={profile?.last_name} className="w-full bg-cream/50 border border-transparent focus:border-green-fresh focus:bg-white px-5 py-3 rounded-2xl outline-none transition-all font-bold" />
                            </div>
                        </div>
                        <div className="space-y-1.5 text-left">
                             <label className="text-[10px] font-black uppercase text-gray-400 ml-1 tracking-widest">Business Phone Number</label>
                             <div className="flex gap-2">
                                <span className="bg-cream/50 rounded-2xl px-4 py-3 text-sm font-bold text-gray-400 border border-transparent">+91</span>
                                <input name="phone_number" defaultValue={profile?.phone_number} placeholder="10-digit mobile number" className="flex-1 bg-cream/50 border border-transparent focus:border-green-fresh focus:bg-white px-5 py-3 rounded-2xl outline-none transition-all font-bold" />
                             </div>
                        </div>
                        <div className="space-y-1.5 text-left">
                            <label className="text-[10px] font-black uppercase text-gray-400 ml-1 tracking-widest">Farm/Home Address</label>
                            <textarea name="address" defaultValue={profile?.address} placeholder="Mention Farm Location, Pincode, State..." className="w-full bg-cream/50 border border-transparent focus:border-green-fresh focus:bg-white px-5 py-4 rounded-2xl outline-none transition-all font-bold min-h-[120px] resize-none" />
                        </div>
                        <div className="flex gap-4">
                            <button className="bg-green-deep text-white px-10 py-4 rounded-2xl font-black text-sm shadow-xl hover:scale-105 active:scale-95 transition-all">
                                Update Merchant Info
                            </button>
                            <Link to="/user-profile" className="bg-white border-2 border-green-deep/10 text-green-deep px-6 py-4 rounded-2xl font-black text-sm hover:bg-cream transition-all flex items-center gap-2">
                                Dedicated View ↗
                            </Link>
                        </div>
                    </form>
                </div>
            </div>
        );
      case 'Payment Track':
        return (
          <div className="space-y-6">
            <div className="bg-white p-6 rounded-3xl shadow-sm border border-cream-dark">
                <h2 className="font-playfair text-2xl font-black text-green-deep">Income Tracker 💸</h2>
                <p className="text-gray-400 text-sm font-bold">Track your payments being held in the secure Agro-Vault.</p>
            </div>

            <div className="grid grid-cols-1 gap-6">
                {orders.filter(o => o.status === 'PAID' || o.status === 'COMPLETED' || o.status === 'SHIPPED').length === 0 ? (
                    <div className="py-20 text-center bg-white rounded-3xl border border-cream-dark text-gray-400 font-bold italic">
                        No secured payments to track yet. Sell more crops! 🌾
                    </div>
                ) : (
                    orders.filter(o => o.status === 'PAID' || o.status === 'COMPLETED' || o.status === 'SHIPPED').map(order => (
                        <div key={order.id} className="bg-white p-8 rounded-[32px] shadow-sm border border-cream-dark hover:border-green-fresh transition-all group">
                            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-10">
                                <div className="flex items-center gap-6">
                                    <div className="w-16 h-16 bg-cream rounded-2xl flex items-center justify-center text-3xl shadow-inner">📦</div>
                                    <div>
                                        <h4 className="text-lg font-black text-green-deep">{order.product?.name}</h4>
                                        <p className="text-[10px] text-gray-400 font-black uppercase">Buyer: {order.buyer?.first_name} · <span className="text-green-fresh">₹{order.total_price}</span></p>
                                    </div>
                                </div>

                                {/* Flow Tracker */}
                                <div className="flex-1 max-w-lg mx-auto">
                                    <div className="relative flex justify-between items-center px-4">
                                        <div className="absolute top-1/2 left-0 w-full h-[2px] bg-cream-dark -translate-y-1/2" />
                                        <div 
                                            className="absolute top-1/2 left-0 h-[2px] bg-amber -translate-y-1/2 transition-all duration-1000"
                                            style={{ width: (order.status === 'COMPLETED' || order.status === 'delivered') ? '100%' : '50%' }}
                                        />

                                        <div className="relative z-10 flex flex-col items-center">
                                            <div className="w-8 h-8 rounded-full bg-green-fresh text-white flex items-center justify-center text-xs shadow-lg">✅</div>
                                            <p className="text-[9px] font-black uppercase mt-2 text-green-fresh">Buyer Paid</p>
                                        </div>

                                        <div className="relative z-10 flex flex-col items-center">
                                            <div className={`w-10 h-10 rounded-full flex items-center justify-center text-lg transition-all ${(order.status === 'COMPLETED' || order.status === 'delivered') ? 'bg-green-fresh shadow-lg' : 'bg-amber text-white shadow-[0_0_20px_rgba(245,158,11,0.4)]'}`}>
                                                {(order.status === 'COMPLETED' || order.status === 'delivered') ? '✅' : '🛡️'}
                                            </div>
                                            <p className={`text-[9px] font-black uppercase mt-2 ${(order.status === 'COMPLETED' || order.status === 'delivered') ? 'text-green-fresh' : 'text-amber animate-pulse'}`}>
                                                {(order.status === 'COMPLETED' || order.status === 'delivered') ? 'Escrow Released' : 'Held in Vault'}
                                            </p>
                                        </div>

                                        <div className="relative z-10 flex flex-col items-center">
                                            <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs transition-all ${(order.status === 'COMPLETED' || order.status === 'delivered') ? 'bg-green-fresh text-white shadow-lg' : 'bg-cream-dark text-gray-300'}`}>💰</div>
                                            <p className={`text-[9px] font-black uppercase mt-2 ${(order.status === 'COMPLETED' || order.status === 'delivered') ? 'text-green-fresh' : 'text-gray-300'}`}>Arrived in Bank</p>
                                        </div>
                                    </div>
                                </div>

                                <div className="bg-cream/30 p-6 rounded-[24px] text-center lg:text-right min-w-[220px]">
                                    <p className="text-[10px] font-black text-gray-400 uppercase mb-1 tracking-tighter">Current Money Status</p>
                                    <p className={`text-md font-black uppercase ${(order.status === 'COMPLETED' || order.status === 'delivered') ? 'text-green-fresh' : 'text-amber'}`}>
                                        {(order.status === 'COMPLETED' || order.status === 'delivered') ? '💸 PAID TO YOU' : '🔒 SECURELY HELD'}
                                    </p>
                                    {order.status !== 'COMPLETED' && order.status !== 'delivered' && (
                                        <p className="text-[9px] text-gray-400 italic mt-2">Will be released once buyer confirms delivery.</p>
                                    )}
                                </div>
                            </div>
                        </div>
                    ))
                )}
            </div>
          </div>
        );
      default:
        return <div>Tab under development</div>;
    }
  };

  if (loading) return <div className="min-h-screen bg-cream flex items-center justify-center font-bold">Harvesting Dashboard...</div>;

  return (
    <div className="min-h-screen bg-cream flex flex-col md:flex-row font-dmsans">
      {/* Sidebar - Specific to Farmer */}
      <aside className="w-full md:w-64 bg-green-deep text-white p-6 md:min-h-screen flex flex-col relative z-20">
        <div className="mb-10">
            <Link to="/" className="font-playfair text-[1.5rem] font-black cursor-pointer inline-block mb-6 text-white">
                <span>Agro</span>
                <span className="text-amber">Farmer</span>
            </Link>
            
            {/* User Profile Mini Summary - Link to Full Profile */}
            <Link 
                to="/user-profile" 
                className="bg-white/10 p-4 rounded-[24px] border border-white/10 flex items-center gap-3 hover:bg-white/20 transition-all cursor-pointer group"
            >
                <div className="w-10 h-10 rounded-full bg-white flex items-center justify-center text-green-deep font-black shadow-sm overflow-hidden border-2 border-white group-hover:scale-110 transition-transform">
                    {profile?.photo_url ? <img src={profile.photo_url} className="w-full h-full object-cover" /> : profile?.first_name?.substring(0,1)}
                </div>
                <div className="overflow-hidden">
                    <p className="text-xs font-black truncate text-white">{profile?.first_name} {profile?.last_name}</p>
                    <p className="text-[10px] opacity-60 font-bold uppercase tracking-wider text-amber">Master Farmer</p>
                </div>
            </Link>
        </div>
        <nav className="space-y-2">
          {tabs.map((tab) => (
            <button key={tab} onClick={() => setActiveTab(tab)} className={`w-full text-left px-4 py-3 rounded-xl text-sm font-bold transition-all ${activeTab === tab ? 'bg-amber text-green-deep shadow-lg' : 'hover:bg-white/10 text-white/70'}`}>{tab}</button>
          ))}
        </nav>
        <div className="mt-auto pt-10 border-t border-white/10">
          <button onClick={handleLogout} className="text-white/50 hover:text-white text-sm font-bold">Logout →</button>
        </div>
      </aside>

      <main className="flex-1 p-6 md:p-10 relative z-10">
        <header className="mb-10 flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
            <div className="flex items-center gap-6">
                 {/* Farmer Identity Circle */}
                 <div className="w-16 h-16 rounded-full bg-white border-2 border-green-fresh shadow-lg overflow-hidden flex items-center justify-center text-green-deep font-black group transition-all hover:scale-105">
                     {profile?.photo_url ? <img src={profile.photo_url} className="w-full h-full object-cover" /> : profile?.first_name?.charAt(0)}
                 </div>
                 <div>
                    <div className="flex items-center gap-2 mb-1">
                        <h1 className="font-playfair text-3xl font-black text-green-deep">{activeTab}</h1>
                        <span className="bg-amber/20 text-amber text-[10px] font-black uppercase px-2 py-1 rounded">Farmer Account</span>
                         <button 
                            onClick={() => setShowLocationModal(true)}
                            className={`flex items-center gap-1.5 ml-4 px-3 py-1.5 rounded-full border shadow-sm overflow-hidden max-w-[200px] transition-all hover:scale-105 active:scale-95 ${locationName === 'Set Farm Area' ? 'bg-amber text-white border-amber animate-pulse' : 'bg-white/50 border-cream-dark text-green-deep'}`}
                         >
                             <span className="text-xs">📍</span>
                             <span className="text-[10px] font-black truncate">{locationName}</span>
                         </button>
                    </div>
                    <p className="text-gray-500 text-sm font-medium">Hello, Master {profile?.first_name}! Managing your fields today.</p>
                 </div>
            </div>
            <button onClick={() => setShowAddModal(true)} className="bg-green-fresh text-white px-6 py-2.5 rounded-full text-sm font-bold shadow-lg hover:scale-105 transition-all text-center">+ List New Crop</button>
        </header>
        {renderContent()}
      </main>

      {/* Add Product Modal */}
      {showAddModal && (
          <div className="fixed inset-0 bg-green-deep/80 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
              <div className="bg-white w-full max-w-2xl rounded-[32px] overflow-hidden shadow-2xl flex flex-col">
                  <div className="bg-green-deep p-6 text-white flex justify-between items-center">
                      <h2 className="text-2xl font-playfair font-black">{editingProduct ? 'Edit Harvest' : 'List New Crop'}</h2>
                      <button onClick={() => { setShowAddModal(false); resetForm(); }} className="text-white/40 hover:text-white text-2xl">×</button>
                  </div>
                  <form onSubmit={handlePublishProduct} className="p-8 grid grid-cols-1 md:grid-cols-2 gap-6 overflow-y-auto max-h-[70vh]">
                      <div className="md:col-span-2"><label className="text-xs font-bold uppercase text-gray-400">Crop Name</label><input required className="w-full bg-cream rounded-xl p-4 mt-1 border" placeholder="Wheat..." value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} /></div>
                      <div><label className="text-xs font-bold uppercase text-gray-400">Quantity</label><input required type="number" className="w-full bg-cream rounded-xl p-4 mt-1" value={formData.quantity} onChange={e => setFormData({...formData, quantity: e.target.value})} /></div>
                      <div><label className="text-xs font-bold uppercase text-gray-400">Unit</label><select className="w-full bg-cream rounded-xl p-4 mt-1 font-bold" value={formData.unit} onChange={e => setFormData({...formData, unit: e.target.value})}><option>kg</option><option>quintal</option></select></div>
                      <div className="md:col-span-2">
                        <label className="text-xs font-bold uppercase text-gray-400 font-black tracking-widest">Crop Category</label>
                        <div className="relative group">
                          <input 
                              required 
                              list="category-suggestions"
                              className="w-full bg-cream rounded-xl p-4 mt-2 border-2 border-transparent focus:border-green-fresh outline-none font-bold text-sm transition-all"
                              placeholder="🌾 Select or type a category (e.g., Basmati Rice, Organic Kale...)"
                              value={formData.category} 
                              onChange={e => setFormData({...formData, category: e.target.value})}
                          />
                          <datalist id="category-suggestions">
                              <option value="Rice">🌾 Rice</option>
                              <option value="Vegetables">🥦 Vegetables</option>
                              <option value="Fruits">🍎 Fruits</option>
                              <option value="Grains">🌽 Grains</option>
                              <option value="Pulses">🥣 Pulses</option>
                              <option value="Spices">🌶 Spices</option>
                              <option value="Dairy">🥛 Dairy</option>
                              <option value="Poultry">🍗 Poultry</option>
                              <option value="Organic">🌿 Organic Items</option>
                              <option value="Seeds">🌱 Seeds</option>
                              <option value="Fertilizers">💩 Fertilizers</option>
                              <option value="Others">📦 Others</option>
                          </datalist>
                          <div className="absolute right-4 top-[60%] -translate-y-1/2 opacity-20 group-focus-within:opacity-100 transition-opacity">
                              ⌨
                          </div>
                        </div>
                      </div>
                      <div className="md:col-span-2"><label className="text-xs font-bold uppercase text-gray-400">Selling Price</label><input required type="number" className="w-full bg-cream rounded-xl p-4 mt-1 border-2 border-green-fresh" placeholder="₹" value={formData.user_price} onChange={e => setFormData({...formData, user_price: e.target.value})} /></div>
                      <div className="md:col-span-2"><label className="text-xs font-bold uppercase text-gray-400">Harvest Address</label><textarea required className="w-full bg-cream rounded-xl p-4 mt-1 border min-h-[80px]" placeholder="Specific field location, village, or warehouse address..." value={formData.address} onChange={e => setFormData({...formData, address: e.target.value})} /></div>
                      <div className="md:col-span-2 grid grid-cols-2 gap-4">
                          <label className="col-span-2 text-xs font-bold uppercase text-gray-400">Crop Photos {editingProduct && '(Leave empty to keep current)'}</label>
                          <div className="relative group">
                              <input type="file" onChange={e => handlePhotoChange(e, 1)} className="text-[10px] w-full" />
                              {preview1 && <img src={preview1} className="mt-2 w-16 h-16 rounded-lg object-cover border" />}
                          </div>
                          <div className="relative group">
                              <input type="file" onChange={e => handlePhotoChange(e, 2)} className="text-[10px] w-full" />
                              {preview2 && <img src={preview2} className="mt-2 w-16 h-16 rounded-lg object-cover border" />}
                          </div>
                      </div>
                      <button disabled={isPublishing} className="md:col-span-2 bg-green-fresh text-white font-black py-4 rounded-xl mt-4">
                          {isPublishing ? 'Processing...' : (editingProduct ? 'Update Harvest' : 'List Harvest')}
                      </button>
                  </form>
              </div>
          </div>
      )}

      {/* Farmer Geolocation Modal */}
      {showLocationModal && (
          <div className="fixed inset-0 bg-green-deep/90 backdrop-blur-md z-[100] flex items-center justify-center p-4">
              <div className="bg-white w-full max-w-md rounded-[48px] p-10 shadow-2xl text-center border-4 border-green-fresh/20 overflow-hidden relative">
                  <div className="relative z-10">
                      <div className="w-20 h-20 bg-green-fresh text-white text-3xl flex items-center justify-center rounded-full mx-auto mb-6 shadow-xl ring-8 ring-green-fresh/10">🚜</div>
                      <h2 className="text-2xl font-playfair font-black text-green-deep mb-4 uppercase tracking-tight">Geotag Your Farm</h2>
                      <p className="text-sm text-gray-500 font-bold mb-8 leading-relaxed px-4">
                          Allow AgroConnect to pin your farm's location so local buyers within <span className="text-green-fresh">50km</span> can find your fresh harvests!
                      </p>
                      
                      <button 
                          onClick={() => {
                              if ("geolocation" in navigator) {
                                  navigator.geolocation.getCurrentPosition(async (pos) => {
                                      const { latitude, longitude } = pos.coords;
                                      setUserLocation({ lat: latitude, lng: longitude });
                                      await supabase.from('profiles').update({ latitude, longitude }).eq('id', user.id);
                                      setShowLocationModal(false);
                                      alert("🌟 Farm location synced! You are now visible to local buyers. ✨");
                                      window.location.reload();
                                  });
                              }
                          }}
                          className="w-full bg-green-deep text-white py-5 rounded-[28px] font-black text-xs shadow-2xl hover:scale-105 active:scale-95 transition-all uppercase tracking-widest"
                      >
                          Enable Harvest Tracking
                      </button>
                      <button 
                          onClick={() => setShowLocationModal(false)}
                          className="mt-4 text-[10px] font-black uppercase text-gray-300 hover:text-amber transition-colors tracking-widest"
                      >
                          I'll tag it later
                      </button>
                  </div>
              </div>
          </div>
      )}
      {showLocationModal && (
        <div className="fixed inset-0 bg-green-deep/90 backdrop-blur-md z-[100] flex items-center justify-center p-4">
            <div className="bg-white w-full max-w-lg rounded-[48px] p-10 shadow-2xl text-center border-4 border-amber/20 relative">
                <div className="w-20 h-20 bg-green-deep text-white text-3xl flex items-center justify-center rounded-full mx-auto mb-6 shadow-xl ring-8 ring-green-deep/10">👨‍🌾</div>
                <h2 className="text-2xl font-playfair font-black text-green-deep mb-2 uppercase tracking-tight">Pin Your Farm</h2>
                <p className="text-xs text-gray-500 font-bold mb-8 leading-relaxed">
                    Set your farm's primary location. This address will be <span className="text-amber">automatically added</span> to all your product listings!
                </p>
                <div className="mb-6 relative">
                    <input 
                        name="farm-address" 
                        required 
                        autoComplete="off"
                        onChange={(e) => handleSearchSuggestions(e.target.value)}
                        placeholder="Enter City or Village Name..." 
                        className="w-full bg-cream rounded-2xl p-5 text-sm font-bold border-2 border-transparent focus:border-amber focus:bg-white outline-none h-[60px] shadow-inner transition-all"
                    />
                    {suggestions.length > 0 && (
                        <div className="absolute top-full left-0 right-0 bg-white shadow-2xl rounded-2xl mt-2 overflow-hidden z-[110] border border-cream-dark">
                            {suggestions.map((loc, i) => (
                                <button 
                                    key={i}
                                    onClick={() => handleSelectLocation(loc)}
                                    className="w-full px-5 py-4 text-left text-xs font-bold text-gray-600 hover:bg-green-fresh hover:text-white transition-colors border-b last:border-0"
                                >
                                    🚜 {loc.name}
                                </button>
                            ))}
                        </div>
                    )}
                    {isSearching && <div className="absolute right-4 top-[18px] text-[10px] font-black text-amber animate-pulse uppercase">Searching...</div>}
                </div>
                <button 
                    onClick={() => {
                        sessionStorage.setItem('farmerLocationDismissed', 'true');
                        setShowLocationModal(false);
                    }}
                    className="text-[10px] font-black uppercase text-gray-300 hover:text-red-400 transition-all tracking-widest outline-none"
                >
                    Dismiss
                </button>
            </div>
        </div>
      )}
      {/* Delete Confirmation Modal */}
      {showDeleteModal && (
          <div className="fixed inset-0 bg-green-deep/90 backdrop-blur-md z-[150] flex items-center justify-center p-4 animate-in fade-in duration-300">
              <div className="bg-white w-full max-w-sm rounded-[40px] p-8 shadow-2xl text-center border-4 border-red-400/20 relative overflow-hidden">
                  {/* Background Accents */}
                  <div className="absolute -top-10 -right-10 w-32 h-32 bg-red-400/10 rounded-full blur-3xl"></div>
                  <div className="absolute -bottom-10 -left-10 w-32 h-32 bg-amber/10 rounded-full blur-3xl"></div>

                  <div className="relative z-10">
                      <div className="w-20 h-20 bg-red-50 text-red-400 text-3xl flex items-center justify-center rounded-3xl mx-auto mb-6 shadow-sm border-2 border-red-400/10">
                          🗑
                      </div>
                      <h2 className="text-2xl font-playfair font-black text-green-deep mb-2 uppercase tracking-tight">Remove Crop?</h2>
                      <p className="text-xs text-gray-500 font-bold mb-8 leading-relaxed">
                          Are you sure you want to remove <span className="text-red-400 font-black">"{productToDelete?.name}"</span> from the marketplace? This action cannot be undone.
                      </p>
                      
                      <div className="flex flex-col gap-3">
                        <button 
                            disabled={isDeleting}
                            onClick={handleDeleteProduct}
                            className={`w-full py-4 rounded-2xl font-black text-xs shadow-xl transition-all uppercase tracking-widest ${isDeleting ? 'bg-gray-200 text-gray-500 cursor-not-allowed' : 'bg-red-400 text-white hover:bg-red-500 hover:scale-[1.02] active:scale-95'}`}
                        >
                            {isDeleting ? 'Deleting Forever...' : 'Yes, Permanently Delete'}
                        </button>
                        <button 
                            disabled={isDeleting}
                            onClick={() => {
                                setShowDeleteModal(false);
                                setProductToDelete(null);
                            }}
                            className="w-full bg-cream text-green-deep py-4 rounded-2xl font-black text-xs hover:bg-cream-dark transition-all uppercase tracking-widest disabled:opacity-50"
                        >
                            No, Keep it safe
                        </button>
                      </div>
                  </div>
              </div>
          </div>
      )}
      {/* 🚀 New Payment Escrow Notification */}
      {escrowNotification.show && (
          <div className="fixed top-24 right-10 z-[300] max-w-sm w-full bg-white rounded-[32px] p-6 shadow-[0_20px_50px_rgba(0,0,0,0.15)] border-l-8 border-green-fresh animate-in slide-in-from-right-10 duration-500">
              <div className="flex gap-4">
                  <div className="w-14 h-14 bg-green-fresh/10 text-green-fresh text-3xl flex items-center justify-center rounded-2xl shrink-0">💰</div>
                  <div>
                      <h4 className="text-md font-black text-green-deep mb-1">Buyer has Paid! ✨</h4>
                      <p className="text-xs text-gray-500 font-bold leading-relaxed">
                          A payment of <span className="text-green-fresh">₹{escrowNotification.amount}</span> for Order #{escrowNotification.orderId.slice(0,6)} is now **Held in Escrow**.
                      </p>
                      <button 
                         onClick={() => { setActiveTab('Payment Track'); setEscrowNotification({ show: false, orderId: null, amount: 0 }); }}
                         className="mt-4 text-[10px] font-black text-green-fresh uppercase tracking-widest hover:underline"
                      >
                         Track Money Safety →
                      </button>
                  </div>
                  <button onClick={() => setEscrowNotification({ show: false, orderId: null, amount: 0 })} className="text-gray-300 hover:text-red-400 text-xl font-bold">×</button>
              </div>
          </div>
      )}
      {/* 🚜 Farmer Success Notification */}
      {showListingSuccess && (
          <div className="fixed inset-0 z-[500] flex items-center justify-center p-4 bg-green-deep/20 backdrop-blur-md animate-in fade-in duration-300">
              <div className="bg-white max-w-sm w-full rounded-[40px] p-8 shadow-[0_40px_100px_rgba(0,0,0,0.2)] border-b-8 border-amber transform animate-in zoom-in-95 duration-500">
                  <div className="text-center">
                      <div className="w-24 h-24 bg-cream rounded-full flex items-center justify-center mx-auto mb-6 text-5xl shadow-inner animate-bounce text-slate-800">🚜</div>
                      <h3 className="text-2xl font-black text-green-deep uppercase tracking-tighter mb-2">Farmer Alert!</h3>
                      <p className="text-gray-500 font-bold text-sm leading-relaxed mb-8">{listingSuccessMsg}</p>
                      
                      <button 
                          onClick={() => setShowListingSuccess(false)}
                          className="w-full bg-green-deep text-white py-4 rounded-2xl font-black text-xs uppercase tracking-[0.2em] shadow-xl hover:scale-105 active:scale-95 transition-all"
                      >
                          Great! ✅
                      </button>
                  </div>
              </div>
          </div>
      )}
      {/* 🖼️ Full Screen Lightbox */}
      {lightbox.show && (
          <div className="fixed inset-0 z-[600] bg-black/95 backdrop-blur-2xl flex flex-col items-center justify-center p-4 lg:p-10 animate-in fade-in duration-300">
              <button 
                  onClick={() => setLightbox(prev => ({ ...prev, show: false }))}
                  className="absolute top-8 right-8 text-white/40 hover:text-white text-4xl font-light transition-all hover:rotate-90 z-[610]"
              >
                  ×
              </button>

              <div className="w-full max-w-5xl aspect-video relative flex items-center justify-center group/light">
                  <img 
                      src={lightbox.images[lightbox.index]} 
                      className="max-w-full max-h-[80vh] object-contain rounded-3xl shadow-[0_0_100px_rgba(255,255,255,0.1)] transition-all duration-500 animate-in zoom-in-95" 
                      alt={lightbox.productName}
                  />

                  {lightbox.images.length > 1 && (
                      <>
                          <button 
                              onClick={(e) => { e.stopPropagation(); setLightbox(prev => ({ ...prev, index: (prev.index - 1 + prev.images.length) % prev.images.length })) }}
                              className="absolute left-4 lg:-left-12 p-4 text-white/30 hover:text-white transition-all text-4xl"
                          >
                              ‹
                          </button>
                          <button 
                              onClick={(e) => { e.stopPropagation(); setLightbox(prev => ({ ...prev, index: (prev.index + 1) % prev.images.length })) }}
                              className="absolute right-4 lg:-right-12 p-4 text-white/30 hover:text-white transition-all text-4xl"
                          >
                              ›
                          </button>

                          <div className="absolute -bottom-12 flex gap-3">
                              {lightbox.images.map((_, i) => (
                                  <div 
                                      key={i} 
                                      className={`h-1.5 transition-all duration-300 rounded-full ${i === lightbox.index ? 'w-12 bg-amber shadow-[0_0_15px_rgba(245,158,11,0.5)]' : 'w-4 bg-white/20'}`}
                                  ></div>
                              ))}
                          </div>
                      </>
                  )}
              </div>

              <div className="absolute top-8 left-1/2 -translate-x-1/2 text-center pointer-events-none">
                  <h4 className="text-white font-black uppercase tracking-[0.4em] text-xs mb-1 opacity-50">Harvest Inspection</h4>
                  <p className="text-amber font-black text-2xl uppercase tracking-tighter">{lightbox.productName}</p>
              </div>
          </div>
      )}
    </div>
  );
};

export default FarmerDashboard;
