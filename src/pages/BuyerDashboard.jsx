import React, { useEffect, useState, useRef } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../services/supabase';

const BuyerDashboard = () => {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();

  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = searchParams.get('tab') || 'Dashboard';
  const setActiveTab = (tab) => setSearchParams({ tab });
  const [profile, setProfile] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const autocompleteRef = useRef(null);
  
  // Data State
  const [products, setProducts] = useState([]);
  const [orders, setOrders] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [orderFilter, setOrderFilter] = useState('All'); // For My Orders tab
  
  // Ordering State
  const [showOrderModal, setShowOrderModal] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [orderQuantity, setOrderQuantity] = useState(1);
  const [orderUnit, setOrderUnit] = useState('kg');
  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [isEditingAddress, setIsEditingAddress] = useState(false);
  const [phoneNumber, setPhoneNumber] = useState('');
  const [isEditingPhone, setIsEditingPhone] = useState(false);
  const [isOrdering, setIsOrdering] = useState(false);
  const [orderStep, setOrderStep] = useState(1); // 1: Details, 2: Payment, 3: Success
  
  // Location States
  const [showLocationModal, setShowLocationModal] = useState(false);
  const [userLocation, setUserLocation] = useState(null);
  const [locationName, setLocationName] = useState('Set Delivery Area');
  const [suggestions, setSuggestions] = useState([]);
  const [isSearching, setIsSearching] = useState(false);

  // Custom Modal State
  const [confirmModal, setConfirmModal] = useState({ show: false, orderId: null });
  const [statusMessage, setStatusMessage] = useState({ show: false, type: 'success', text: '' });

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

  // Wait for Google SDK to load
  useEffect(() => {
    if (userLocation && locationName === 'Set Delivery Area') {
        const checkSDK = setInterval(() => {
            if (window.google && window.google.maps && window.google.maps.Geocoder) {
                reverseGeocode(userLocation.lat, userLocation.lng);
                clearInterval(checkSDK);
            }
        }, 1000);
        return () => clearInterval(checkSDK);
    }
  }, [userLocation, locationName]);

  // Custom Search Handler (Failover for Google Autocomplete)
  const handleSearchSuggestions = async (val) => {
    if (val.length < 3) { setSuggestions([]); return; }
    setIsSearching(true);
    try {
        // High-speed, Free, CORS-friendly Geocoding Search
        const res = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?localityLanguage=en&address=${encodeURIComponent(val)}`);
        const data = await res.json();
        const results = [];
        if (data.locality) results.push({ name: `${data.locality}, ${data.principalSubdivision}`, lat: data.latitude, lng: data.longitude });
        
        // Secondary Search: Nominatim (OpenStreetMap)
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
        setShowLocationModal(false);
        fetchMarketplaceProducts(loc.lat, loc.lng);
    } catch (e) { alert(e.message); }
    finally { setLoading(false); }
  };

  const haversineDistance = (lat1, lon1, lat2, lon2) => {
    const R = 6371; // Radius of Earth in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = 
      Math.sin(dLat/2) * Math.sin(dLat/2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
      Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c; 
  };

  const tabs = ['Dashboard', 'Marketplace', 'My Orders', 'Payment Track', 'Address', 'Settings'];

  useEffect(() => {
    if (!user && !loading) {
      navigate('/login');
    }
  }, [user, loading, navigate]);

  useEffect(() => {
    const initBuyer = async () => {
      if (user) {
        setLoading(true);
        try {
          const { data, error } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', user.id)
            .eq('role', 'buyer')
            .single();

          if (error) {
            setError('Could not find buyer profile.');
          } else {
            setProfile(data);
            if (data.latitude && data.longitude) {
                setUserLocation({ lat: data.latitude, lng: data.longitude });
                if (data.address) setLocationName(data.address);
                else reverseGeocode(data.latitude, data.longitude);
                await Promise.all([fetchMarketplaceProducts(data.latitude, data.longitude), fetchMyOrders()]);
            } else {
                // Only show modal if it hasn't been dismissed in this session
                if (!sessionStorage.getItem('locationDismissed')) {
                    setShowLocationModal(true);
                }
                await Promise.all([fetchMarketplaceProducts(), fetchMyOrders()]);
            }
          }
        } catch (err) {
          setError('An unexpected error occurred.');
        } finally {
          setLoading(false);
        }
      }
    };
    initBuyer();
  }, [user]);

  useEffect(() => {
    let productsSubscription;
    let ordersSubscription;

    if (user) {
        // ALWAYS keep orders up to date regardless of tab
        fetchMyOrders();
        ordersSubscription = supabase
            .channel('buyer-order-updates')
            .on('postgres_changes', { 
                event: '*', 
                schema: 'public', 
                table: 'orders',
                filter: `buyer_id=eq.${user.id}`
            }, () => {
                fetchMyOrders();
            })
            .subscribe();

        if (activeTab === 'Marketplace') {
            fetchMarketplaceProducts(userLocation?.lat, userLocation?.lng);
            productsSubscription = supabase
                .channel('marketplace-updates')
                .on('postgres_changes', { event: '*', schema: 'public', table: 'products' }, (payload) => {
                    fetchMarketplaceProducts(userLocation?.lat, userLocation?.lng);
                })
                .subscribe();
        }
    }

    return () => {
        if (productsSubscription) supabase.removeChannel(productsSubscription);
        if (ordersSubscription) supabase.removeChannel(ordersSubscription);
    };
  }, [user, activeTab, userLocation]);

  const fetchMarketplaceProducts = async (userLat, userLng) => {
    try {
        // Step 1: Fetch all products
        const { data: productsData, error } = await supabase.from('products').select('*').order('created_at', { ascending: false });
        
        if (error) {
            console.warn("Market fetch error:", error);
            return;
        }

        // Step 2: Fetch corresponding farmer profiles
        const farmerIds = [...new Set(productsData.map(p => p.farmer_id).filter(Boolean))];
        const { data: profiles } = await supabase.from('profiles').select('id, first_name, last_name, latitude, longitude, phone_number, address, city').in('id', farmerIds);
        
        const profilesMap = {};
        if (profiles) profiles.forEach(p => profilesMap[p.id] = p);

        // Step 3: Attach profiles
        const data = productsData.map(p => ({
            ...p,
            farmer: profilesMap[p.farmer_id] || {}
        }));
        if (userLat && userLng) {
            const localProducts = data.filter(p => {
                const pLat = Number(p.latitude);
                const pLng = Number(p.longitude);
                const pAddr = (p.address || "").toLowerCase();
                const userName = (locationName || "").toLowerCase();
                const userAddr = (profile?.address || profile?.city || "").toLowerCase();
                
                // (1) Proximity Reality (50km)
                let isWithinRadius = false;
                if (!isNaN(pLat) && !isNaN(pLng)) {
                    const dist = haversineDistance(userLat, userLng, pLat, pLng);
                    p.distance = dist;
                    isWithinRadius = dist <= 50;
                }

                // (2) Identity Sync (City, State, or same address match)
                // This is a MUST-SHOW if they are in the same area!
                const isMatch = (userName && userName !== 'Set Delivery Area' && pAddr.includes(userName)) || 
                                (userAddr && pAddr.includes(userAddr));

                return isWithinRadius || isMatch;
            });
            // STRICT DEDUPE BY ID: No two cards can share the same ID
            const uniqueProducts = Array.from(new Map(localProducts.map(item => [item.id, item])).values());
            setProducts(uniqueProducts);
        } else {
            // STRICT DEDUPE BY ID (Even in Global View)
            const uniqueProducts = Array.from(new Map(data.map(item => [item.id, item])).values());
            setProducts(uniqueProducts);
        }
    } catch (err) {
        console.error("Fetch failed unexpectedly:", err);
    }
  };

  const handleEnableLocation = () => {
    if ("geolocation" in navigator) {
        navigator.geolocation.getCurrentPosition(async (position) => {
            const { latitude, longitude } = position.coords;
            setUserLocation({ lat: latitude, lng: longitude });
            reverseGeocode(latitude, longitude);
            await supabase.from('profiles').update({ latitude, longitude }).eq('id', user.id);
            fetchMarketplaceProducts(latitude, longitude);
            setShowLocationModal(false);
            alert("📍 Location Activated! Distance filtering is now Live. ✨");
        }, (err) => {
            alert("Location access denied. Please allow it for local discovery.");
            setShowLocationModal(false);
        });
    }
  };

  const fetchMyOrders = async () => {
    try {
        const { data: rawOrders, error } = await supabase.from('orders').select('*').eq('buyer_id', user.id).order('created_at', { ascending: false });
        
        if (error) {
            console.error("Order fetch error:", error);
            return;
        }

        // Fetch products manually
        const productIds = [...new Set(rawOrders.map(o => o.product_id).filter(Boolean))];
        const { data: products } = await supabase.from('products').select('*').in('id', productIds);
        const productsMap = {};
        if (products) products.forEach(p => productsMap[p.id] = p);

        // Fetch farmers manually
        const farmerIds = [...new Set(rawOrders.map(o => o.farmer_id).filter(Boolean))];
        const { data: profiles } = await supabase.from('profiles').select('id, first_name, last_name, phone_number').in('id', farmerIds);
        const profilesMap = {};
        if (profiles) profiles.forEach(p => profilesMap[p.id] = p);

        const mergedOrders = rawOrders.map(o => ({
            ...o,
            product: productsMap[o.product_id] || {},
            farmer: profilesMap[o.farmer_id] || {}
        }));

        setOrders(mergedOrders || []);
    } catch (err) {
        console.error("Farmer Orders catch:", err);
        const { data: fallback } = await supabase.from('orders').select('*').eq('buyer_id', user.id);
        if (fallback) setOrders(fallback);
    }
  };

  const handleLogout = async (e) => {
    e.preventDefault();
    await signOut();
    navigate('/login');
  };

  const handleBuyProduct = (product) => {
    setSelectedProduct(product);
    setOrderQuantity(1);
    setOrderUnit(product.unit || 'kg');
    setDeliveryAddress(profile?.address || '');
    setPhoneNumber(profile?.phone_number || profile?.phone || '');
    setIsEditingAddress(false);
    setIsEditingPhone(false);
    setOrderStep(1);
    setShowOrderModal(true);
  };

  const handlePlaceOrder = async () => {
    if (!deliveryAddress) {
        alert("Please provide a delivery address.");
        return;
    }
    
    // Price handling (1 Quintal = 100 kg)
    const basePrice = selectedProduct.user_price;
    const finalTotal = orderUnit === 'quintal' ? (orderQuantity * 100 * basePrice) : (orderQuantity * basePrice);
    
    // Inventory check before order
    const orderInKg = orderUnit === 'quintal' ? (orderQuantity * 100) : orderQuantity;
    if (orderInKg > selectedProduct.quantity) {
        alert(`🚨 Not Enough Stock: Farmer only has ${selectedProduct.quantity} KG available. Please reduce your quantity.`);
        return;
    }

    setIsOrdering(true);
    try {
        const { error } = await supabase.from('orders').insert([{
            product_id: selectedProduct.id,
            buyer_id: user.id,
            farmer_id: selectedProduct.farmer_id || selectedProduct.farmer?.id,
            farmer_name: selectedProduct.farmer?.first_name || 'Merchant',
            farmer_phone: selectedProduct.farmer?.phone_number || '',
            quantity: orderQuantity,
            unit_at_order: orderUnit,
            total_price: finalTotal,
            status: 'pending',
            delivery_address: deliveryAddress,
            buyer_phone: phoneNumber
        }]);

        if (error) throw error;
        
        // Success Transition (Animated, no intrusive alert)
        setOrderStep(3);
        
        setTimeout(() => {
            setShowOrderModal(false);
            setActiveTab('My Orders');
            fetchMyOrders();
        }, 2500);
    } catch (err) {
        alert("Order Failed: " + err.message);
    } finally {
        setIsOrdering(false);
    }
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
            setStatusMessage({ show: true, type: 'success', text: 'Success! Payment Released to Farmer. 🌾✅' });
            fetchMyOrders();
            setTimeout(() => setStatusMessage({ show: false, type: 'success', text: '' }), 4000);
        } else {
            throw new Error(data.error || "Update failed");
        }
    } catch (err) { 
        setStatusMessage({ show: true, type: 'error', text: "Error: " + err.message });
        setTimeout(() => setStatusMessage({ show: false, type: 'error', text: '' }), 4000);
    }
  };

  const filteredProducts = products.filter(p => {
    const matchesSearch = p.name.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesCategory = selectedCategory === 'All' || p.category === selectedCategory;
    return matchesSearch && matchesCategory;
  });

    const renderStats = () => {
        const totalSpent = orders.reduce((acc, curr) => acc + curr.total_price, 0) || 0;
        const pendingCount = orders.filter(o => o.status === 'pending').length;
        const confirmedCount = orders.filter(o => o.status === 'confirmed').length;

        return (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 mb-10 text-left">
                {/* Total Spent Card */}
                <div 
                    onClick={() => navigate('/spent-analysis')}
                    className="bg-white p-6 rounded-2xl shadow-sm border border-transparent hover:border-amber transition-all group cursor-pointer hover:scale-[1.02] active:scale-95"
                >
                    <div className="flex justify-between items-start mb-4">
                        <span className="text-2xl">🛒</span>
                        <span className="text-[10px] font-black text-amber opacity-0 group-hover:opacity-100 transition-opacity uppercase">See Details →</span>
                    </div>
                    <p className="text-xs text-gray-400 font-bold uppercase tracking-wider mb-1">Total Spent</p>
                    <h3 className="text-2xl font-black text-green-deep mb-2">₹{totalSpent}</h3>
                    <span className="text-xs text-amber font-bold">{orders.length} orders total</span>
                </div>

                {/* Combined Orders Card */}
                <div className="bg-white p-6 rounded-2xl shadow-sm border border-transparent hover:border-green-fresh transition-all group overflow-hidden">
                    <div className="flex justify-between items-start mb-4">
                        <span className="text-2xl">📦</span>
                        <p className="text-xs text-gray-400 font-bold uppercase tracking-widest">Your Orders</p>
                    </div>
                    
                    <div className="flex flex-col gap-2">
                        <button 
                            onClick={() => { setActiveTab('My Orders'); setOrderFilter('confirmed'); }}
                            className="flex justify-between items-center bg-green-fresh/10 hover:bg-green-fresh/20 p-2.5 rounded-xl transition-all"
                        >
                            <span className="text-xs font-black text-green-fresh uppercase">Confirmed</span>
                            <span className="bg-green-fresh text-white text-[10px] font-black px-2 py-0.5 rounded-lg">{confirmedCount}</span>
                        </button>
                        <button 
                            onClick={() => { setActiveTab('My Orders'); setOrderFilter('pending'); }}
                            className="flex justify-between items-center bg-amber/10 hover:bg-amber/20 p-2.5 rounded-xl transition-all"
                        >
                            <span className="text-xs font-black text-amber uppercase">Pending</span>
                            <span className="bg-amber text-white text-[10px] font-black px-2 py-0.5 rounded-lg">{pendingCount}</span>
                        </button>
                    </div>
                </div>

                {/* Static Stats Cards */}
                <div 
                    onClick={() => navigate('/reward-points')}
                    className="bg-white p-6 rounded-2xl shadow-sm border border-transparent hover:border-amber transition-all group cursor-pointer hover:scale-[1.02] active:scale-95"
                >
                    <div className="flex justify-between items-start mb-4">
                        <span className="text-2xl">✨</span>
                        <p className="text-[10px] font-black text-amber opacity-0 group-hover:opacity-100 transition-opacity uppercase">See Rewards →</p>
                    </div>
                    <p className="text-xs text-gray-400 font-bold uppercase tracking-wider mb-1">Reward Points</p>
                    <h3 className="text-2xl font-black text-green-deep mb-2">
                        {orders.filter(o => o.status === 'confirmed' || o.status === 'delivered').reduce((acc, curr) => acc + (10 + Math.floor(curr.total_price/100)), 0)}
                    </h3>
                    <span className="text-xs text-amber font-bold">Milestone: 500 PX</span>
                </div>

                <div 
                    onClick={() => navigate('/community-deals')}
                    className="bg-white p-6 rounded-2xl shadow-sm border border-transparent hover:border-amber transition-all group cursor-pointer hover:scale-[1.02] active:scale-95 lg:col-span-1"
                >
                    <div className="flex justify-between items-start mb-4">
                        <span className="text-2xl">🤝</span>
                        <p className="text-[10px] font-black text-amber opacity-0 group-hover:opacity-100 transition-opacity uppercase">Scan Deals →</p>
                    </div>
                    <p className="text-xs text-gray-400 font-bold uppercase tracking-wider mb-1">Community Deals</p>
                    <h3 className="text-2xl font-black text-green-deep mb-2">12 Active</h3>
                    <span className="text-xs text-amber font-bold">Join now</span>
                </div>
            </div>
        );
    };

  const renderContent = () => {
    switch (activeTab) {
      case 'Dashboard':
        return (
          <div className="space-y-10">
            {renderStats()}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-10">
                {/* Recent Activity - Orders */}
                <section className="bg-white rounded-[32px] p-8 shadow-sm border border-cream-dark">
                    <div className="flex justify-between items-center mb-8">
                        <h2 className="font-playfair text-xl font-bold text-green-deep">Recent Activity</h2>
                        <Link to="/buyer-dashboard" onClick={() => setActiveTab('My Orders')} className="text-[10px] font-black uppercase text-amber hover:underline">View All Orders →</Link>
                    </div>
                    <div className="space-y-4">
                        {orders.slice(0, 4).map(order => (
                            <div key={order.id} className="flex items-center justify-between p-4 bg-cream/10 rounded-2xl border border-cream-dark/50">
                                <div className="flex items-center gap-4">
                                    <div className="w-10 h-10 rounded-xl bg-amber/10 flex items-center justify-center text-xl">📦</div>
                                    <div>
                                        <p className="text-sm font-bold text-green-deep">Ordered {order.product?.name}</p>
                                        <p className="text-[10px] text-gray-400 uppercase font-black">{new Date(order.created_at).toLocaleDateString()}</p>
                                    </div>
                                </div>
                                <span className={`px-3 py-1 rounded-full text-[10px] font-black uppercase ${order.status === 'pending' ? 'bg-amber/20 text-amber' : 'bg-green-fresh/20 text-green-fresh'}`}>
                                    {order.status}
                                </span>
                            </div>
                        ))}
                        {orders.length === 0 && <p className="text-center py-20 text-gray-400 italic">No recent activity yet.</p>}
                    </div>
                </section>

                {/* Fresh Arrivals - Integrated Here */}
                <section className="bg-white rounded-[32px] p-8 shadow-sm border border-cream-dark">
                    <div className="flex justify-between items-center mb-8">
                        <h2 className="font-playfair text-xl font-bold text-green-deep">Fresh Arrivals</h2>
                        <Link to="/buyer-dashboard" onClick={() => setActiveTab('Marketplace')} className="text-[10px] font-black uppercase text-amber hover:underline">Full Market →</Link>
                    </div>
                    <div className="space-y-4">
                        {products.slice(0, 4).map(p => (
                            <div key={p.id} className="flex items-center justify-between p-4 bg-green-fresh/5 rounded-2xl border border-green-fresh/10">
                                <div className="flex items-center gap-4">
                                    <img src={p.image_url_1} className="w-12 h-12 rounded-xl object-cover border border-green-fresh/10" />
                                    <div>
                                        <p className="text-sm font-bold text-green-deep">{p.name}</p>
                                        <p className="text-[9px] text-green-mid uppercase font-black tracking-widest leading-none">Harvest by {p.farmer?.first_name || 'Agro Farmer'}</p>
                                        <p className="text-[8px] font-black text-amber uppercase mt-1.5 truncate max-w-[120px]">📍 {p.address || 'Local Field'}</p>
                                    </div>
                                </div>
                                <div className="text-right">
                                    <p className="text-md font-black text-green-deep">₹{p.user_price}</p>
                                    <button 
                                        onClick={() => handleBuyProduct(p)} 
                                        className="mt-2 text-[9px] font-black uppercase text-amber bg-amber/10 px-3 py-1 rounded-xl hover:bg-amber hover:text-white transition-all shadow-sm border border-amber/10"
                                    >
                                        Request →
                                    </button>
                                </div>
                            </div>
                        ))}
                        {products.length === 0 && <p className="text-center py-20 text-gray-400 italic">Fetching fresh harvests...</p>}
                    </div>
                </section>
            </div>
          </div>
        );
      case 'Marketplace':
        return (
            <div className="space-y-6">
                <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4">
                    <h2 className="font-playfair text-2xl font-bold text-green-deep">Fresh Marketplace</h2>
                    <div className="flex flex-wrap gap-2 w-full lg:w-auto">
                        <input 
                            type="text" 
                            placeholder="Find fresh crops..."
                            className="bg-white border border-cream-dark rounded-full px-6 py-2 text-sm outline-none focus:border-amber flex-1"
                            value={searchQuery}
                            onChange={e => setSearchQuery(e.target.value)}
                        />
                        <select 
                            className="bg-white border border-cream-dark rounded-full px-4 py-2 text-sm font-bold outline-none cursor-pointer"
                            value={selectedCategory}
                            onChange={e => setSelectedCategory(e.target.value)}
                        >
                            <option>All</option>
                            <option>Vegetables</option>
                            <option>Fruits</option>
                            <option>Grains</option>
                            <option>Pulses</option>
                        </select>
                    </div>
                </div>
                
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {filteredProducts.map(p => (
                        <div key={p.id} className="bg-white rounded-2xl overflow-hidden shadow-sm border border-cream-dark group hover:shadow-xl transition-all">
                            <div className="h-48 bg-cream overflow-hidden relative">
                                <img 
                                    src={p.image_url_1 || `https://source.unsplash.com/800x600/?${encodeURIComponent(p.name)},agriculture&sig=${p.id}`} 
                                    alt={p.name} 
                                    className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-500" 
                                    onError={(e) => { e.target.src = `https://source.unsplash.com/800x600/?crop,field&sig=${p.id}`; }}
                                />
                                <div className="absolute top-4 right-4 bg-white/90 backdrop-blur px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-wider text-green-deep">
                                    {p.category}
                                </div>
                                <div className="absolute bottom-3 left-3 bg-green-deep/90 backdrop-blur-md px-3 py-1.5 rounded-xl text-[9px] font-black text-white uppercase flex items-center gap-2 shadow-lg border border-white/10">
                                    <span className="text-[12px]">👨‍🌾</span> {p.farmer?.first_name ? `${p.farmer.first_name} ${p.farmer.last_name || ''}` : `ID: ${p.farmer_id?.substring(0, 8)}...`}
                                </div>
                            </div>
                            <div className="p-5">
                                <div className="flex justify-between items-start mb-4">
                                    <h3 className="font-bold text-green-deep text-lg">{p.name}</h3>
                                    {p.distance && (
                                        <span className="bg-green-fresh/10 text-green-fresh text-[8px] font-black uppercase px-2 py-1 rounded-full whitespace-nowrap">{p.distance.toFixed(1)} km</span>
                                    )}
                                </div>

                                <div className="space-y-1 mb-4 flex flex-col items-start bg-cream/30 p-3 rounded-2xl border border-cream-dark/50">
                                    <p className="text-[9px] font-black uppercase text-gray-400 tracking-tighter">Current Market Price</p>
                                    <div className="flex items-center gap-2">
                                        <h4 className="text-xl font-black text-green-deep">₹{p.user_price}</h4>
                                        <span className="text-[9px] text-amber font-black uppercase bg-white px-2 py-0.5 rounded border border-amber/20">per {p.unit}</span>
                                    </div>
                                </div>

                                <div className="flex justify-between items-center pt-4 border-t border-cream-dark">
                                    <div className="flex flex-col">
                                        <p className="text-[8px] font-black uppercase text-gray-300 tracking-widest leading-none mb-1">Available Yield</p>
                                        <p className={`text-xs font-black uppercase ${p.quantity <= 10 ? 'text-red-500 animate-pulse' : 'text-green-fresh'}`}>
                                            {p.quantity > 0 ? `${p.quantity} KG` : 'Sold Out!'}
                                        </p>
                                    </div>
                                    <button 
                                        disabled={p.quantity <= 0}
                                        onClick={() => handleBuyProduct(p)}
                                        className={`px-6 py-3 rounded-xl font-black text-[10px] uppercase transition-all shadow-md group ${p.quantity <= 0 ? 'bg-gray-100 text-gray-400 cursor-not-allowed' : 'bg-green-deep text-white hover:bg-green-fresh hover:scale-105 active:scale-95'}`}
                                    >
                                        {p.quantity <= 0 ? 'Restocking' : 'Order Now →'}
                                    </button>
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        );
      case 'My Orders':
        const filteredOrders = orders.filter(o => {
            if (orderFilter === 'All') return true;
            if (orderFilter === 'History') return o.status === 'delivered' || o.status === 'cancelled';
            return o.status === orderFilter;
        });

        return (
            <div className="space-y-6">
                <div className="flex justify-between items-center bg-white p-4 rounded-2xl shadow-sm border border-cream-dark">
                    <h2 className="font-playfair text-xl font-black text-green-deep">Order History</h2>
                    <div className="flex gap-2">
                        {['All', 'pending', 'confirmed', 'History'].map(f => (
                            <button 
                                key={f} 
                                onClick={() => setOrderFilter(f)}
                                className={`px-4 py-1.5 rounded-lg text-[10px] font-black uppercase transition-all ${orderFilter === f ? 'bg-green-deep text-white shadow-lg' : 'bg-cream text-gray-400 hover:bg-amber/10 hover:text-amber'}`}
                            >
                                {f}
                            </button>
                        ))}
                    </div>
                </div>

                <div className="bg-white rounded-3xl shadow-sm border border-cream-dark overflow-hidden">
                    <div className="max-h-[650px] overflow-y-auto custom-scrollbar overflow-x-auto">
                        <table className="w-full text-left">
                            <thead className="bg-cream/50 text-[10px] font-black uppercase tracking-widest text-gray-400 sticky top-0 z-10">
                                <tr>
                                    <th className="p-6">Product</th>
                                    <th className="p-6">Farmer</th>
                                    <th className="p-6">Details</th>
                                    <th className="p-6">Status</th>
                                    <th className="p-6 text-right">Action</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-cream-dark">
                                {filteredOrders.map(order => (
                                    <tr key={order.id} className="hover:bg-cream/10 transition-colors">
                                        <td className="p-6">
                                            <div className="flex items-center gap-3">
                                                <div className="w-12 h-12 bg-cream rounded-xl p-1 overflow-hidden border border-cream-dark shrink-0">
                                                    <img src={order.product?.image_url_1} className="w-full h-full object-cover" />
                                                </div>
                                                <div className="min-w-[120px]">
                                                    <p className="text-sm font-black text-green-deep">{order.product?.name}</p>
                                                    <p className="text-[10px] text-gray-400 font-bold uppercase">{new Date(order.created_at).toLocaleDateString()} at {new Date(order.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
                                                </div>
                                            </div>
                                        </td>
                                        <td className="p-6">
                                            <div className="min-w-[140px]">
                                                <p className="text-sm font-black text-green-deep uppercase tracking-tighter">🌾 {order.farmer_name || order.farmer?.first_name || 'Agro-Farmer'}</p>
                                                {order.status === 'pending' ? (
                                                    <p className="text-[10px] text-amber font-black tracking-widest mt-1 italic animate-pulse">📞 Contact on Approval</p>
                                                ) : (
                                                    <p className="text-[11px] text-green-fresh font-black tracking-widest mt-0.5">📞 {order.farmer_phone || order.farmer?.phone_number || order.farmer?.phone || 'No Phone provided'}</p>
                                                )}
                                            </div>
                                        </td>
                                        <td className="p-6">
                                            <div className="min-w-[120px]">
                                                <p className="text-sm font-black text-green-deep">₹{order.total_price}</p>
                                                <div className="flex flex-col gap-0.5 mt-1">
                                                    <p className="text-[9px] text-green-mid font-black uppercase">Qty: {order.quantity} {order.unit_at_order || order.product?.unit}</p>
                                                    <p className="text-[8px] text-gray-400 font-bold uppercase truncate max-w-[120px]">🏠 {order.delivery_address}</p>
                                                </div>
                                            </div>
                                        </td>
                                        <td className="p-6">
                                            <div className="flex flex-col items-start gap-1 min-w-[100px]">
                                                <span className={`px-3 py-1 rounded-full text-[9px] font-black uppercase ${
                                                    order.status === 'pending' ? 'bg-amber/20 text-amber animate-pulse' : 
                                                    order.status === 'confirmed' ? 'bg-amber text-white shadow-lg' : 
                                                    order.status === 'delivered' || order.status === 'COMPLETED' ? 'bg-green-deep text-white border border-green-fresh/30 shadow-lg' : 
                                                    order.status === 'declined' ? 'bg-red-500 text-white' :
                                                    'bg-green-fresh/20 text-green-fresh'
                                                }`}>
                                                    {order.status === 'pending' ? '⏳ Waiting Farmer Approval' : 
                                                     order.status === 'confirmed' ? '✅ Approved - Ready to Pay' :
                                                     order.status === 'declined' ? '❌ Product Declined by Farmer' :
                                                     order.status}
                                                </span>
                                            </div>
                                        </td>
                                        <td className="p-6 text-right">
                                            {order.status === 'confirmed' && (
                                                <button 
                                                   onClick={() => {
                                                        const orderParams = new URLSearchParams({
                                                            orderId: order.id,
                                                            productId: order.product?.id || '',
                                                            buyerId: user.id,
                                                            sellerId: order.farmer_id || '',
                                                            amount: order.total_price,
                                                            productName: order.product?.name || 'Product',
                                                            quantity: order.quantity,
                                                            unit: order.unit_at_order || 'kg',
                                                            deliveryAddress: order.delivery_address || '',
                                                            buyerPhone: order.buyer_phone || ''
                                                        });
                                                        window.location.href = `/escrow-test?${orderParams.toString()}`;
                                                   }}
                                                   className="bg-green-fresh text-white text-[10px] font-black uppercase px-6 py-3 rounded-2xl shadow-xl hover:scale-105 active:scale-95 transition-all flex items-center gap-2 mx-auto lg:ml-auto"
                                                >
                                                    💳 Pay Securely ₹{order.total_price} →
                                                </button>
                                            )}
                                            {(order.status === 'PAID' || order.status === 'delivered' || order.status === 'SHIPPED') && (
                                                <button 
                                                    onClick={() => setConfirmModal({ show: true, orderId: order.id })}
                                                    className="bg-green-deep text-white text-[9px] font-black uppercase px-4 py-2 rounded-xl shadow-lg hover:scale-105 active:scale-95 transition-all"
                                                >
                                                    Confirm Received ✅
                                                </button>
                                            )}
                                            {(order.status === 'delivered' || order.status === 'COMPLETED') && (
                                                <span className="text-[10px] font-black text-green-fresh uppercase italic flex items-center justify-end gap-1">
                                                    <span>✨</span> Order Completed
                                                </span>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    {filteredOrders.length === 0 && <div className="p-20 text-center text-gray-400 italic font-bold">No orders found in this category. 🌿</div>}
                </div>
            </div>
        );
      case 'Payment Track':
        return (
          <div className="space-y-6">
            <div className="bg-white p-6 rounded-3xl shadow-sm border border-cream-dark">
              <h2 className="font-playfair text-2xl font-black text-green-deep mb-2">Escrow Payment Tracker 🛡️</h2>
              <p className="text-gray-400 text-sm font-bold">Monitor where your money is held in real-time.</p>
            </div>
            
            <div className="grid grid-cols-1 gap-6">
              {orders.filter(o => o.status !== 'cancelled' && o.status !== 'pending').length === 0 ? (
                <div className="py-20 text-center bg-white rounded-3xl border border-cream-dark text-gray-400 font-bold italic">
                  No active secured payments to track. 🌿
                </div>
              ) : (
                orders.filter(o => o.status !== 'cancelled' && o.status !== 'pending' && o.status !== 'declined').map(order => (
                  <div key={order.id} className="bg-white p-8 rounded-[32px] shadow-sm border border-cream-dark group hover:border-amber transition-all">
                    <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
                      <div className="flex items-center gap-5">
                        <div className="w-16 h-16 bg-cream rounded-2xl p-1 overflow-hidden shrink-0 border border-cream-dark">
                          <img src={order.product?.image_url_1} className="w-full h-full object-cover" />
                        </div>
                        <div>
                          <h4 className="text-lg font-black text-green-deep">{order.product?.name}</h4>
                          <p className="text-xs text-gray-400 font-bold uppercase tracking-widest">Order Amount: ₹{order.total_price}</p>
                        </div>
                      </div>

                      {/* Tracker Visual */}
                      <div className="flex-1 max-w-lg">
                        <div className="relative flex justify-between items-center px-4">
                          {/* Line */}
                          <div className="absolute top-1/2 left-0 w-full h-[2px] bg-cream-dark -translate-y-1/2" />
                          <div 
                            className="absolute top-1/2 left-0 h-[3px] bg-green-fresh -translate-y-1/2 transition-all duration-1000"
                            style={{ width: (order.status === 'delivered' || order.status === 'COMPLETED') ? '100%' : '50%' }}
                          />
                          
                          {/* Steps */}
                          <div className="relative z-10 flex flex-col items-center">
                            <div className="w-8 h-8 rounded-full bg-green-fresh text-white flex items-center justify-center text-xs shadow-lg ring-4 ring-green-fresh/10">💰</div>
                            <p className="text-[10px] font-black text-green-fresh uppercase mt-2">Paid</p>
                          </div>
                          
                          <div className="relative z-10 flex flex-col items-center">
                            <div className={`w-10 h-10 rounded-full flex items-center justify-center text-lg transition-all ${(order.status !== 'delivered' && order.status !== 'COMPLETED') ? 'bg-amber text-white shadow-[0_0_20px_rgba(245,158,11,0.3)]' : 'bg-green-fresh text-white'}`}>
                              {(order.status !== 'delivered' && order.status !== 'COMPLETED') ? '🛡️' : '✅'}
                            </div>
                            <p className={`text-[10px] font-black uppercase mt-2 ${(order.status !== 'delivered' && order.status !== 'COMPLETED') ? 'text-amber animate-pulse' : 'text-green-fresh'}`}>
                              {(order.status !== 'delivered' && order.status !== 'COMPLETED') ? 'Held in Escrow' : 'Released'}
                            </p>
                          </div>
                          
                          <div className="relative z-10 flex flex-col items-center">
                            <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs transition-all ${(order.status === 'delivered' || order.status === 'COMPLETED') ? 'bg-green-fresh text-white shadow-lg ring-4 ring-green-fresh/10' : 'bg-cream-dark text-gray-400'}`}>👨‍🌾</div>
                            <p className={`text-[10px] font-black uppercase mt-2 ${(order.status === 'delivered' || order.status === 'COMPLETED') ? 'text-green-fresh' : 'text-gray-400'}`}>Farmer Paid</p>
                          </div>
                        </div>
                      </div>

                      <div className="bg-cream/20 p-5 rounded-2xl border border-cream-dark/50 text-center lg:text-right min-w-[200px]">
                        <p className="text-[10px] font-black text-gray-400 uppercase tracking-tighter mb-1">Current Fund Location</p>
                        <p className={`text-sm font-black uppercase ${(order.status !== 'delivered' && order.status !== 'COMPLETED') ? 'text-amber' : 'text-green-fresh'}`}>
                          {(order.status !== 'delivered' && order.status !== 'COMPLETED') ? '🔒 Locked in Agro-Vault' : '💸 Disbursed to Farmer'}
                        </p>
                        {(order.status !== 'delivered' && order.status !== 'COMPLETED') && (
                          <button 
                            onClick={() => setConfirmModal({ show: true, orderId: order.id })}
                            className="mt-3 w-full bg-green-deep text-white text-[9px] font-black py-2.5 rounded-xl uppercase hover:bg-green-fresh transition-all shadow-md"
                          >
                            I Received Product →
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        );
      case 'Settings':
        return (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-10">
                {/* Profile Card */}
                <div className="lg:col-span-1 bg-white rounded-[40px] p-8 shadow-sm border border-cream-dark text-center flex flex-col items-center">
                    <div className="relative group mb-6">
                        <div className="w-32 h-32 rounded-full bg-cream border-4 border-amber ring-4 ring-amber/10 flex items-center justify-center overflow-hidden shadow-2xl transition-all group-hover:scale-105">
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
                                         const fileName = `buyer-${user.id}-${Date.now()}`;
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
                    <h3 className="text-2xl font-black text-green-deep">{profile?.first_name} {profile?.last_name}</h3>
                    <p className="text-xs font-black uppercase text-amber tracking-widest mt-1">Verified Agro-Buyer</p>
                    
                    <div className="w-full mt-10 space-y-4 border-t border-cream-dark pt-8 text-left">
                        <div>
                            <p className="text-[10px] font-black uppercase text-gray-400">Email Address</p>
                            <p className="text-sm font-bold text-green-deep truncate">{profile?.email_address}</p>
                        </div>
                        <div>
                            <p className="text-[10px] font-black uppercase text-gray-400">Phone</p>
                            <p className="text-sm font-bold text-green-deep">+91 {profile?.phone_number}</p>
                        </div>
                    </div>
                </div>

                {/* Edit Section */}
                <div className="lg:col-span-2 bg-white rounded-[40px] p-10 shadow-sm border border-cream-dark">
                    <h3 className="text-xl font-bold text-green-deep mb-8">Personal Information</h3>
                    <form className="space-y-6" onSubmit={async (e) => {
                        e.preventDefault();
                        const formData = new FormData(e.target);
                        const address = formData.get('address')?.trim();

                        if (!address) {
                            alert("📍 Verification Required: Please enter your delivery address to proceed.");
                            return;
                        }

                        const updates = {
                            first_name: formData.get('first_name'),
                            last_name: formData.get('last_name'),
                            address: address,
                        };
                        try {
                            const { error } = await supabase.from('profiles').update(updates).eq('id', user.id);
                            if (error) throw error;
                            alert("Profile updated successfully! ✨");
                            window.location.reload();
                        } catch (err) { alert(err.message); }
                    }}>
                        <div className="grid grid-cols-2 gap-6">
                            <div className="space-y-1.5 text-left">
                                <label className="text-xs font-bold uppercase text-gray-400 ml-1">First Name</label>
                                <input name="first_name" defaultValue={profile?.first_name} className="w-full bg-cream/50 border border-transparent focus:border-amber focus:bg-white px-5 py-3 rounded-2xl outline-none transition-all font-bold" />
                            </div>
                            <div className="space-y-1.5 text-left">
                                <label className="text-xs font-bold uppercase text-gray-400 ml-1">Last Name</label>
                                <input name="last_name" defaultValue={profile?.last_name} className="w-full bg-cream/50 border border-transparent focus:border-amber focus:bg-white px-5 py-3 rounded-2xl outline-none transition-all font-bold" />
                            </div>
                        </div>
                        <div className="space-y-1.5 text-left">
                            <label className="text-[10px] font-black uppercase text-gray-400 ml-1 tracking-widest">Delivery Address</label>
                            <textarea name="address" defaultValue={profile?.address} placeholder="House No, Landmark, Road, City, State..." className="w-full bg-cream/50 border border-transparent focus:border-amber focus:bg-white px-5 py-4 rounded-2xl outline-none transition-all font-bold min-h-[120px] resize-none" />
                        </div>
                        <button className="bg-green-deep text-white px-10 py-4 rounded-2xl font-black text-sm shadow-xl hover:scale-105 active:scale-95 transition-all">
                            Save Profile Securely
                        </button>
                    </form>
                </div>
            </div>
        );
      default:
        return <div className="text-center py-20 text-gray-400 italic">Coming Soon...</div>;
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-cream flex items-center justify-center font-dmsans">
        <p className="text-green-deep font-bold animate-pulse">Setting up Marketplace...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-cream flex flex-col md:flex-row font-dmsans">
      {/* Sidebar - Specific to Buyer */}
      <aside className="w-full md:w-64 bg-amber text-green-deep p-6 md:min-h-screen flex flex-col relative z-20">
        <div className="mb-10">
            <Link to="/" className="font-playfair text-[1.5rem] font-black cursor-pointer inline-block mb-6">
                <span>Agro</span>
                <span className="text-white">Buyer</span>
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
                    <p className="text-xs font-black truncate">{profile?.first_name} {profile?.last_name}</p>
                    <p className="text-[10px] opacity-60 font-bold uppercase tracking-wider">Premium Buyer</p>
                </div>
            </Link>
        </div>
        <nav className="space-y-2">
          {tabs.map((tab) => (
            <button key={tab} onClick={() => setActiveTab(tab)} className={`w-full text-left px-4 py-3 rounded-xl text-sm font-bold transition-all ${activeTab === tab ? 'bg-green-deep text-white shadow-lg' : 'hover:bg-green-deep/5 text-green-deep/70'}`}>
              {tab}
            </button>
          ))}
        </nav>
        <div className="mt-auto pt-10 border-t border-green-deep/10">
          <button onClick={handleLogout} className="flex items-center gap-2 text-green-deep/50 hover:text-green-deep text-sm font-bold">Logout →</button>
        </div>
      </aside>

      <main className="flex-1 p-6 md:p-10 relative z-10">
        <header className="mb-10 flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
            <div className="flex items-center gap-6">
                 {/* Dashboard Photo Circle */}
                 <div className="w-16 h-16 rounded-full bg-white border-2 border-amber shadow-lg overflow-hidden flex items-center justify-center text-green-deep font-black group transition-all hover:scale-105">
                     {profile?.photo_url ? <img src={profile.photo_url} className="w-full h-full object-cover" /> : profile?.first_name?.charAt(0)}
                 </div>
                 <div>
                    <div className="flex items-center gap-2 mb-1">
                        <h1 className="font-playfair text-3xl font-black text-green-deep">{activeTab}</h1>
                        <span className="bg-amber/20 text-amber text-[10px] font-black uppercase px-2 py-1 rounded">Buyer Account</span>
                         <button 
                            onClick={() => setShowLocationModal(true)}
                            className={`flex items-center gap-1.5 ml-4 px-3 py-1.5 rounded-full border shadow-sm overflow-hidden max-w-[200px] transition-all hover:scale-105 active:scale-95 ${locationName === 'Set Delivery Area' ? 'bg-amber text-white border-amber animate-pulse' : 'bg-white/50 border-cream-dark text-green-deep'}`}
                         >
                             <span className="text-xs">📍</span>
                             <span className="text-[10px] font-black truncate">{locationName}</span>
                         </button>
                    </div>
                    <p className="text-gray-500 text-sm font-medium">Hello, {profile?.first_name}! What's on your kitchen list today?</p>
                 </div>
            </div>
            <button onClick={() => setActiveTab('Marketplace')} className="bg-green-deep text-white px-8 py-3 rounded-xl text-sm font-bold shadow-xl hover:scale-105 transition-all">Go to Marketplace</button>
        </header>
        {renderContent()}
      </main>

      {/* Location Search Failover Modal (Already exists) */}
      
      {/* PROFESSIONAL ORDER MODAL */}
      {showOrderModal && selectedProduct && (
          <div className="fixed inset-0 bg-green-deep/95 backdrop-blur-xl z-[200] flex items-center justify-center p-4 transition-all animate-in fade-in duration-300">
              <div className="bg-white w-full max-w-lg rounded-[40px] shadow-2xl overflow-hidden border-4 border-amber/10 flex flex-col relative max-h-[95vh]">
                  {/* Step Header */}
                  <div className="bg-amber p-6 text-green-deep flex justify-between items-center">
                      <div>
                          <h2 className="text-2xl font-playfair font-black uppercase tracking-tight">
                              {orderStep === 1 ? 'Your Harvest' : 'Final Step'}
                          </h2>
                          <div className="flex gap-1 mt-1">
                              <div className={`h-1 w-8 rounded-full ${orderStep === 1 ? 'bg-green-deep' : 'bg-green-deep/20'}`}></div>
                              <div className={`h-1 w-8 rounded-full ${orderStep === 2 ? 'bg-green-deep' : 'bg-green-deep/20'}`}></div>
                          </div>
                      </div>
                      <button onClick={() => setShowOrderModal(false)} className="text-green-deep/40 hover:text-green-deep text-2xl transition-colors">×</button>
                  </div>

                  <div className="p-8 overflow-y-auto custom-scrollbar flex-1">
                      {orderStep === 1 ? (
                          <div className="space-y-8 animate-in slide-in-from-right-4 duration-300">
                              <div className="bg-cream/30 p-5 rounded-[32px] border border-cream-dark flex flex-col gap-4">
                                  <div className="flex items-center gap-6">
                                      <div className="w-20 h-20 rounded-2xl overflow-hidden border-2 border-white shadow-md">
                                          <img src={selectedProduct.image_url_1} className="w-full h-full object-cover" alt={selectedProduct.name} />
                                      </div>
                                      <div>
                                          <h3 className="text-xl font-black text-green-deep leading-tight">{selectedProduct.name}</h3>
                                          <p className="text-green-mid font-black uppercase text-[10px] tracking-widest mt-1">₹{selectedProduct.user_price} per {selectedProduct.unit}</p>
                                      </div>
                                  </div>

                                  <div className="pt-4 border-t border-cream-dark/50 flex items-center gap-3">
                                      <div className="w-8 h-8 rounded-full bg-green-deep text-white flex items-center justify-center text-[10px] font-black shadow-lg ring-2 ring-white">
                                          {selectedProduct.farmer?.first_name?.charAt(0) || 'F'}
                                      </div>
                                      <div className="flex-1">
                                          <div className="flex justify-between items-center">
                                              <p className="text-[9px] font-black uppercase text-gray-400">
                                                  Sold By {selectedProduct.farmer?.first_name || 'Agro'} {selectedProduct.farmer?.last_name || 'Farmer'}
                                              </p>
                                              <span className="text-[8px] font-black text-amber bg-white px-2 py-0.5 rounded-full border border-amber/10 shadow-sm uppercase">
                                                  ID: AGRO-{selectedProduct.farmer_id?.substring(0, 8).toUpperCase() || 'PRO'}
                                              </span>
                                          </div>
                                          <p className="text-sm font-black text-green-deep tracking-tight">{selectedProduct.farmer?.first_name} {selectedProduct.farmer?.last_name || ''}</p>
                                      </div>
                                  </div>
                              </div>

                              <div className="flex justify-between items-center bg-cream/50 p-4 rounded-3xl border border-cream-dark">
                                  <div className="flex flex-col gap-1">
                                      <label className="text-[9px] font-black uppercase text-gray-400 tracking-widest">Unit</label>
                                      <select 
                                          value={orderUnit} 
                                          onChange={(e) => setOrderUnit(e.target.value)}
                                          className="bg-transparent font-black text-green-deep outline-none uppercase text-xs cursor-pointer"
                                      >
                                          <option value="kg">kilogram (kg)</option>
                                          <option value="quintal">quintal (qtl)</option>
                                      </select>
                                  </div>
                                  <div className="flex flex-col items-end gap-1">
                                      <label className="text-[9px] font-black uppercase text-gray-400 tracking-widest text-right">Quantity</label>
                                      <div className="flex items-center gap-4 bg-white rounded-full px-4 py-2 border border-cream-dark shadow-sm">
                                          <button 
                                              onClick={() => setOrderQuantity(Math.max(1, orderQuantity - 1))}
                                              className="text-xl font-black text-green-deep hover:text-amber transition-colors"
                                          >-</button>
                                          <input 
                                              type="number"
                                              min="1"
                                              value={orderQuantity}
                                              onChange={(e) => setOrderQuantity(Math.max(1, parseInt(e.target.value) || 1))}
                                              className="w-[50px] bg-transparent border-none text-center font-black text-green-deep text-sm focus:outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                                          />
                                          <button 
                                              onClick={() => setOrderQuantity(orderQuantity + 1)}
                                              className="text-xl font-black text-green-deep hover:text-amber transition-colors"
                                          >+</button>
                                      </div>
                                  </div>
                              </div>

                              <div className={`bg-green-deep/5 p-6 rounded-3xl border border-dashed transition-all ${isEditingPhone ? 'border-amber ring-4 ring-amber/5' : 'border-green-deep/20'}`}>
                                  <div className="flex justify-between items-center mb-4">
                                      <span className="text-xs font-black uppercase text-gray-400">Buyer Contact Number</span>
                                      <button 
                                          onClick={() => setIsEditingPhone(!isEditingPhone)}
                                          className={`text-[10px] font-black uppercase px-2 py-1 rounded-lg transition-all ${isEditingPhone ? 'bg-amber text-white' : 'text-amber hover:bg-amber/10'}`}
                                      >
                                          {isEditingPhone ? 'Save ✅' : 'Change ✏️'}
                                      </button>
                                  </div>
                                  
                                  {isEditingPhone ? (
                                      <input 
                                          type="tel"
                                          autoFocus
                                          className="w-full bg-white border border-cream-dark rounded-xl p-4 text-xs font-bold text-green-deep outline-none focus:ring-2 ring-amber/20"
                                          value={phoneNumber}
                                          onChange={(e) => setPhoneNumber(e.target.value)}
                                          placeholder="Enter your phone number..."
                                      />
                                  ) : (
                                      <p className="text-sm font-black text-green-deep tracking-wider">
                                          {phoneNumber || '📞 Click change to add phone number...'}
                                      </p>
                                  )}
                              </div>

                              <div className={`bg-green-deep/5 p-6 rounded-3xl border border-dashed transition-all ${isEditingAddress ? 'border-amber ring-4 ring-amber/5' : 'border-green-deep/20'}`}>
                                  <div className="flex justify-between items-center mb-4">
                                      <span className="text-xs font-black uppercase text-gray-400">Delivery Address</span>
                                      <button 
                                          onClick={() => setIsEditingAddress(!isEditingAddress)}
                                          className={`text-[10px] font-black uppercase px-2 py-1 rounded-lg transition-all ${isEditingAddress ? 'bg-amber text-white' : 'text-amber hover:bg-amber/10'}`}
                                      >
                                          {isEditingAddress ? 'Done ✅' : 'Change ✏️'}
                                      </button>
                                  </div>
                                  
                                  {isEditingAddress ? (
                                      <textarea 
                                          autoFocus
                                          className="w-full bg-white border border-cream-dark rounded-xl p-4 text-xs font-bold text-green-deep outline-none focus:ring-2 ring-amber/20 min-h-[100px] resize-none"
                                          value={deliveryAddress}
                                          onChange={(e) => setDeliveryAddress(e.target.value)}
                                          placeholder="Enter full delivery address..."
                                      />
                                  ) : (
                                      <p className="text-sm font-bold text-green-deep leading-relaxed">
                                          {deliveryAddress || '📍 Click edit to provide address...'}
                                      </p>
                                  )}
                              </div>

                              <div className="pt-4 border-t border-cream-dark flex justify-between items-center">
                                  <div>
                                      <p className="text-[10px] font-black uppercase text-gray-400 tracking-tighter">Approx. Total Bill</p>
                                      <h4 className="text-3xl font-black text-green-deep">
                                          ₹{orderUnit === 'quintal' ? (orderQuantity * 100 * selectedProduct.user_price) : (orderQuantity * selectedProduct.user_price)}
                                      </h4>
                                  </div>
                                  <button 
                                      onClick={() => setOrderStep(2)}
                                      className="bg-green-deep text-white px-10 py-5 rounded-[24px] font-black text-xs shadow-xl hover:scale-105 active:scale-95 transition-all uppercase tracking-widest"
                                  >
                                      Send Order Request →
                                  </button>
                              </div>
                          </div>
                      ) : orderStep === 2 ? (
                          <div className="space-y-8 animate-in slide-in-from-right-4 duration-300">
                              <div className="text-center">
                                  <div className="w-16 h-16 bg-green-fresh/10 text-green-fresh rounded-full flex items-center justify-center mx-auto mb-4 text-3xl animate-bounce">🛡️</div>
                                  <h3 className="text-xl font-black text-green-deep uppercase tracking-tight">Confirm Details</h3>
                                  <div className="bg-amber/10 p-5 rounded-3xl border border-amber/20 mt-6 text-left">
                                      <p className="text-[10px] font-black text-amber uppercase mb-2">🚚 Delivery to:</p>
                                      <p className="text-xs font-bold text-green-deep">{deliveryAddress}</p>
                                      <p className="text-[10px] font-black text-gray-400 mt-3 uppercase">Phone: {phoneNumber}</p>
                                  </div>

                                  <div className="bg-cream/30 p-5 rounded-3xl border border-dashed border-gray-200 mt-4">
                                      <p className="text-[10px] font-bold text-gray-400 italic leading-relaxed">
                                          "By sending this request, the farmer will be notified to set aside your stock. Once approved, you can complete the secure escrow payment."
                                      </p>
                                  </div>
                              </div>

                              <div className="flex gap-4">
                                  <button 
                                      onClick={() => setOrderStep(1)}
                                      className="flex-1 border-2 border-cream-dark text-green-deep py-5 rounded-[28px] font-black text-xs uppercase tracking-widest hover:bg-cream transition-all"
                                  >
                                      Back
                                  </button>
                                  <button 
                                      disabled={isOrdering}
                                      onClick={handlePlaceOrder}
                                      className="flex-[2] bg-green-deep text-white py-5 rounded-[28px] font-black text-xs shadow-2xl hover:scale-105 active:scale-95 transition-all uppercase tracking-widest disabled:opacity-50"
                                  >
                                      {isOrdering ? '📡 Sending Request...' : 'Send Secure Request →'}
                                  </button>
                              </div>
                              
                              <p className="text-center text-[10px] font-black text-gray-300 uppercase tracking-tighter">
                                  By clicking confirm, you agree to AgroConnect Farmer terms.
                              </p>
                          </div>
                      ) : (
                          <div className="py-12 text-center animate-in zoom-in-95 duration-500">
                              <div className="w-24 h-24 bg-green-fresh text-white rounded-full flex items-center justify-center mx-auto mb-8 text-5xl shadow-[0_0_40px_rgba(16,185,129,0.3)]">✨</div>
                              <h3 className="text-2xl font-black text-green-deep uppercase tracking-tight">Request Sent!</h3>
                              <p className="text-gray-400 font-bold mt-2">Farmer will review and approve your order shortly.<br/>Check 'My Orders' for the payment link once approved. 📑</p>
                              
                              <div className="mt-10 flex justify-center gap-2">
                                  {[1,2,3].map(i => <div key={i} className="w-2 h-2 bg-green-fresh rounded-full animate-bounce" style={{ animationDelay: `${i * 0.1}s` }} />)}
                              </div>
                          </div>
                      )}
                  </div>
              </div>
          </div>
      )}

      {showLocationModal && (
      <div className="fixed inset-0 bg-green-deep/90 backdrop-blur-md z-[100] flex items-center justify-center p-4">
          <div className="bg-white w-full max-w-lg rounded-[48px] p-10 shadow-2xl text-center border-4 border-amber/20 overflow-hidden relative">
              <div className="relative z-10">
                  <div className="w-20 h-20 bg-amber text-white text-3xl flex items-center justify-center rounded-full mx-auto mb-6 shadow-xl ring-8 ring-amber/10">🏠</div>
                  <h2 className="text-2xl font-playfair font-black text-green-deep mb-4 uppercase tracking-tight">Set Delivery Location</h2>
                  <p className="text-xs text-gray-500 font-bold mb-8 leading-relaxed px-4">
                      Tell us your <span className="text-amber">City or State name</span> to discover fresh harvests within your region or a <span className="text-green-fresh">50km radius</span>.
                  </p>
                  
                  <form onSubmit={async (e) => {
                      e.preventDefault();
                      const address = e.target.address.value;
                      if (!address) return;
                      
                      try {
                          let lat = null; let lng = null;
                          if (window.google && window.google.maps && window.google.maps.Geocoder) {
                              const geocoder = new window.google.maps.Geocoder();
                              const res = await new Promise((resolve) => {
                                  geocoder.geocode({ address: address }, (r, status) => {
                                      if (status === 'OK' && r[0]) resolve(r[0].geometry.location);
                                      else resolve(null);
                                  });
                              });
                              if (res) { lat = res.lat(); lng = res.lng(); }
                          } else {
                              const apiKey = 'AIzaSyBB7MHzXVXJVyBfuWfd5zvVI1KSLOcNM1A';
                              const r = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${apiKey}`);
                              const data = await r.json();
                              if (data.results?.[0]) { lat = data.results[0].geometry.location.lat; lng = data.results[0].geometry.location.lng; }
                          }

                          if (lat && lng) {
                            await supabase.from('profiles').update({ address, latitude: lat, longitude: lng }).eq('id', user.id);
                            setUserLocation({ lat, lng });
                            reverseGeocode(lat, lng);
                            setShowLocationModal(false);
                            alert("📍 Home Address Saved! Local marketplace is now live. ✨");
                            fetchMarketplaceProducts(lat, lng);
                          } else {
                            alert("Could not pin address. Please be more specific (City, Area).");
                          }
                      } catch (err) { alert(err.message); }
                  }}>
                      <div className="mb-6 relative">
                        <input 
                            name="address" 
                            required 
                            autoComplete="off"
                            onChange={(e) => handleSearchSuggestions(e.target.value)}
                            placeholder="Type City or State (e.g. Mathura, UP)..." 
                            className="w-full bg-cream rounded-2xl p-5 text-sm font-bold border-2 border-transparent focus:border-amber focus:bg-white outline-none h-[60px] shadow-inner transition-all"
                        />
                        {suggestions.length > 0 && (
                            <div className="absolute top-full left-0 right-0 bg-white shadow-2xl rounded-2xl mt-2 overflow-hidden z-[110] border border-cream-dark animate-slideDown">
                                {suggestions.map((loc, i) => (
                                    <button 
                                        key={i}
                                        onClick={() => handleSelectLocation(loc)}
                                        className="w-full px-5 py-4 text-left text-xs font-bold text-gray-600 hover:bg-green-fresh hover:text-white transition-colors border-b last:border-0"
                                    >
                                        📍 {loc.name}
                                    </button>
                                ))}
                            </div>
                        )}
                        {isSearching && <div className="absolute right-4 top-[18px] text-[10px] font-black text-amber animate-pulse uppercase">Searching...</div>}
                      </div>
                      <button 
                          type="submit"
                          className="w-full bg-green-deep text-white py-5 rounded-[28px] font-black text-xs shadow-2xl hover:scale-105 active:scale-95 transition-all uppercase tracking-widest"
                      >
                          Set Delivery Radius
                      </button>
                      
                      <div className="mt-6 pt-6 border-t border-cream-dark flex flex-col gap-4">
                        <button 
                            type="button" 
                            onClick={handleEnableLocation}
                            className="text-[10px] font-black uppercase text-amber hover:underline"
                        >
                            Or Use Browser Geolocation →
                        </button>
                         <button 
                             type="button"
                             onClick={() => {
                                 sessionStorage.setItem('locationDismissed', 'true');
                                 setShowLocationModal(false);
                             }}
                             className="text-[10px] font-black uppercase text-gray-300 hover:text-red-400 transition-colors tracking-widest"
                         >
                             Dismiss (Show All)
                         </button>
                      </div>
                  </form>
              </div>
          </div>
      </div>
  )}

      {/* 🛡️ Premium Custom Confirmation Modal */}
      {confirmModal.show && (
          <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
              <div className="absolute inset-0 bg-green-deep/80 backdrop-blur-md" onClick={() => setConfirmModal({ show: false, orderId: null })} />
              <div className="relative bg-white w-full max-w-sm rounded-[40px] p-8 shadow-2xl text-center border-b-8 border-amber animate-in zoom-in-95 duration-300">
                  <div className="w-20 h-20 bg-amber/10 text-amber text-4xl flex items-center justify-center rounded-3xl mx-auto mb-6">📦</div>
                  <h3 className="text-xl font-black text-green-deep uppercase tracking-tight mb-2">Confirm Receipt?</h3>
                  <p className="text-xs text-gray-500 font-bold mb-8 leading-relaxed">
                      Is your product delivered? Once confirmed, your held payment will be <span className="text-green-fresh">released to the farmer</span> immediately.
                  </p>
                  <div className="flex gap-3">
                      <button 
                          onClick={() => setConfirmModal({ show: false, orderId: null })}
                          className="flex-1 py-4 rounded-2xl font-black text-[10px] uppercase border-2 border-cream-dark text-gray-400 hover:bg-cream transition-all"
                      >
                          Wait
                      </button>
                      <button 
                          onClick={() => handleConfirmDelivery(confirmModal.orderId)}
                          className="flex-2 bg-green-deep text-white px-8 py-4 rounded-2xl font-black text-[10px] uppercase shadow-lg shadow-green-deep/20 hover:scale-105 active:scale-95 transition-all"
                      >
                          Yes, Release Now →
                      </button>
                  </div>
              </div>
          </div>
      )}

      {/* ✨ Floating Status Toast */}
      {statusMessage.show && (
          <div className={`fixed bottom-10 left-1/2 -translate-x-1/2 z-[300] px-8 py-4 rounded-2xl shadow-2xl text-xs font-black uppercase tracking-widest flex items-center gap-3 animate-in slide-in-from-bottom-10 duration-500 ${statusMessage.type === 'success' ? 'bg-green-fresh text-white' : 'bg-red-500 text-white'}`}>
              <span>{statusMessage.type === 'success' ? '✅' : '❌'}</span>
              {statusMessage.text}
          </div>
      )}
    </div>
  );
};

export default BuyerDashboard;
