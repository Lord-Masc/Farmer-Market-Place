import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../services/supabase';

const FarmerDashboard = () => {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Redirect if not logged in
    if (!user && !loading) {
      navigate('/login');
    }
  }, [user, loading, navigate]);

  useEffect(() => {
    const fetchProfile = async () => {
      if (user) {
        setLoading(true);
        const { data, error } = await supabase
          .from('profiles')
          .select('*')
          .eq('id', user.id)
          .single();

        if (error) {
          console.error('Error fetching profile:', error.message);
        } else {
          setProfile(data);
        }
        setLoading(false);
      }
    };

    fetchProfile();
  }, [user]);

  const handleLogout = async (e) => {
    e.preventDefault();
    await signOut();
    navigate('/login');
  };

  const stats = [
    { label: 'Total Earnings', value: '₹42,500', icon: '💰', trend: '+12% this week' },
    { label: 'Active Listings', value: '18', icon: '🌾', trend: '3 low on stock' },
    { label: 'Pending Orders', value: '7', icon: '📦', trend: '2 needs shipping' },
    { label: 'Profile Rating', value: '4.9', icon: '⭐', trend: '98 reviews' },
  ];

  const orders = [
    { id: '#8421', buyer: 'Sunil Kumar', product: 'Desi Tomatoes (10kg)', amount: '₹450', status: 'Pending', date: '2 mins ago' },
    { id: '#8420', buyer: 'Anita Devi', product: 'Fresh Spinach (5 units)', amount: '₹140', status: 'Shipped', date: '45 mins ago' },
    { id: '#8419', buyer: 'Radisson Hotel', product: 'Red Onions (100kg)', amount: '₹2,500', status: 'Delivered', date: '2 hours ago' },
  ];

  if (loading) {
    return (
      <div className="min-h-screen bg-cream flex items-center justify-center font-dmsans">
        <p className="text-green-deep font-bold animate-pulse">Loading dashboard...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-cream flex flex-col md:flex-row font-dmsans">
      {/* Sidebar */}
      <aside className="w-full md:w-64 bg-green-deep text-white p-6 md:min-h-screen flex flex-col">
        <Link to="/" className="font-playfair text-[1.5rem] font-black cursor-pointer inline-block mb-10">
          <span>Agro</span>
          <span className="text-amber">Connect</span>
        </Link>

        {profile && (
          <div className="mb-8 p-4 bg-white/10 rounded-xl">
            <p className="text-xs text-amber font-bold uppercase tracking-wider mb-1">{profile.role === 'farmer' ? 'Farmer' : 'Buyer'} Profile</p>
            <p className="text-sm font-medium">{profile.first_name} {profile.last_name}</p>
          </div>
        )}

        <nav className="space-y-2">
          {['Dashboard', 'My Products', 'Orders', 'Analytics', 'Settings'].map((item) => (
            <button key={item} className={`w-full text-left px-4 py-3 rounded-xl text-sm font-bold transition-all ${item === 'Dashboard' ? 'bg-amber text-green-deep' : 'hover:bg-white/10 text-white/70'}`}>
              {item}
            </button>
          ))}
        </nav>

        <div className="mt-auto pt-10 border-t border-white/10">
          <button onClick={handleLogout} className="flex items-center gap-2 text-white/50 hover:text-white text-sm font-bold">
            Logout →
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 p-6 md:p-10">
        <header className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-10">
          <div>
            <h1 className="font-playfair text-3xl font-black text-green-deep">
              {profile?.role === 'buyer' ? 'Buyer Dashboard' : 'Farmer Dashboard'}
            </h1>
            <p className="text-gray-500 text-sm">Welcome back, {profile?.first_name || 'User'}! Here's how your {profile?.role === 'buyer' ? 'orders are' : 'farm is'} performing.</p>
          </div>
          <button className="bg-green-deep text-white px-6 py-2.5 rounded-full text-sm font-bold hover:bg-green-mid transition-all shadow-md">
            {profile?.role === 'buyer' ? 'Browse Products' : '+ Add New Product'}
          </button>
        </header>

        {/* Stats Grid */}
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

        {/* Recent Orders Section */}
        <section className="bg-white rounded-3xl p-6 md:p-8 shadow-sm border border-cream-dark">
          <div className="flex justify-between items-center mb-6">
            <h2 className="font-playfair text-xl font-bold text-green-deep">Recent Orders</h2>
            <button className="text-sm font-bold text-green-mid hover:underline">View All Orders</button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-cream-dark">
                  {['Order ID', profile?.role === 'buyer' ? 'Seller' : 'Buyer', 'Product', 'Amount', 'Status', 'Date'].map(h => (
                    <th key={h} className="pb-4 text-xs font-bold text-gray-400 uppercase tracking-widest">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-cream-dark">
                {orders.map((o, idx) => (
                  <tr key={idx} className="group hover:bg-cream/50 transition-colors">
                    <td className="py-4 text-sm font-bold text-green-deep">{o.id}</td>
                    <td className="py-4 text-sm text-[#4a4a4a]">{o.buyer}</td>
                    <td className="py-4 text-sm text-[#4a4a4a] font-medium">{o.product}</td>
                    <td className="py-4 text-sm text-[#4a4a4a] font-bold">{o.amount}</td>
                    <td className="py-4">
                      <span className={`px-3 py-1 rounded-full text-[10px] font-black uppercase ${
                        o.status === 'Pending' ? 'bg-amber/10 text-amber' : 
                        o.status === 'Shipped' ? 'bg-blue-100 text-blue-600' : 'bg-green-100 text-green-mid'
                      }`}>
                        {o.status}
                      </span>
                    </td>
                    <td className="py-4 text-xs text-gray-400">{o.date}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Sales Chart Placeholder */}
        <div className="mt-10 bg-green-deep/5 rounded-3xl p-10 border-2 border-dashed border-green-deep/10 text-center">
            <p className="text-green-deep font-bold italic opacity-40">Monthly Analytics Visualization Placeholder</p>
        </div>
      </main>
    </div>
  );
};

export default FarmerDashboard;
