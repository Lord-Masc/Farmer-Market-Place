import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../services/supabase';

const SpentAnalysis = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [orders, setOrders] = useState([]);
  
  const [stats, setStats] = useState({
    weekly: 0,
    monthly: 0,
    yearly: 0,
    total: 0
  });

  useEffect(() => {
    if (!user) {
      navigate('/login');
      return;
    }
    fetchOrderStats();
  }, [user]);

  const fetchOrderStats = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('orders')
        .select('total_price, created_at')
        .eq('buyer_id', user.id)
        // Only orders actually paid for count as spent — unpaid, cancelled
        // and refunded orders never were.
        .in('status', ['PAID', 'SHIPPED', 'DELIVERED', 'COMPLETED']);

      if (error) throw error;

      calculateBreakdown(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const calculateBreakdown = (data) => {
    const now = new Date();
    const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const oneMonthAgo = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate());
    const oneYearAgo = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());

    let weekly = 0, monthly = 0, yearly = 0, total = 0;

    data.forEach(order => {
      const orderDate = new Date(order.created_at);
      const price = parseFloat(order.total_price);
      
      total += price;
      if (orderDate >= oneWeekAgo) weekly += price;
      if (orderDate >= oneMonthAgo) monthly += price;
      if (orderDate >= oneYearAgo) yearly += price;
    });

    setStats({ weekly, monthly, yearly, total });
    setOrders(data);
  };

  if (loading) return <div className="min-h-screen bg-cream flex items-center justify-center font-black text-green-deep">Analyzing your spending...</div>;

  return (
    <div className="min-h-screen bg-cream font-dmsans p-6 md:p-12">
      <div className="max-w-4xl mx-auto">
        <Link to="/buyer-dashboard" className="inline-flex items-center gap-2 text-green-deep font-bold mb-8 hover:text-amber transition-colors">
          <span>←</span> Back to Dashboard
        </Link>
        
        <header className="mb-12">
          <h1 className="font-playfair text-4xl font-black text-green-deep mb-2">Spending Analysis</h1>
          <p className="text-gray-500">A detailed breakdown of your fresh harvest investments.</p>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 mb-12">
          {/* Weekly */}
          <div className="bg-white p-8 rounded-[32px] shadow-sm border-b-4 border-amber relative overflow-hidden group hover:shadow-xl transition-all">
            <span className="absolute top-4 right-4 text-4xl opacity-10 group-hover:opacity-20 transition-opacity">📅</span>
            <p className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2">Last 7 Days</p>
            <h2 className="text-3xl font-black text-green-deep">₹{stats.weekly}</h2>
            <p className="text-xs text-amber font-bold mt-2">Weekly Spending</p>
          </div>

          {/* Monthly */}
          <div className="bg-white p-8 rounded-[32px] shadow-sm border-b-4 border-green-fresh relative overflow-hidden group hover:shadow-xl transition-all">
             <span className="absolute top-4 right-4 text-4xl opacity-10 group-hover:opacity-20 transition-opacity">📊</span>
            <p className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2">This Month</p>
            <h2 className="text-3xl font-black text-green-deep">₹{stats.monthly}</h2>
            <p className="text-xs text-green-fresh font-bold mt-2">Monthly Spending</p>
          </div>

          {/* Yearly */}
          <div className="bg-white p-8 rounded-[32px] shadow-sm border-b-4 border-green-deep relative overflow-hidden group hover:shadow-xl transition-all">
            <span className="absolute top-4 right-4 text-4xl opacity-10 group-hover:opacity-20 transition-opacity">🏛️</span>
            <p className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2">This Year</p>
            <h2 className="text-3xl font-black text-green-deep">₹{stats.yearly}</h2>
            <p className="text-xs text-green-deep font-bold mt-2">Yearly Investment</p>
          </div>
        </div>

        <div className="bg-green-deep rounded-[32px] p-10 text-white flex flex-col md:flex-row justify-between items-center gap-6 shadow-2xl">
          <div>
            <h3 className="text-sm font-bold uppercase tracking-widest opacity-60 mb-2">Grand Total Spent</h3>
            <p className="text-5xl font-black">₹{stats.total}</p>
          </div>
          <div className="text-right">
            <p className="text-amber font-black text-xl mb-1">{orders.length} Total Orders</p>
            <p className="text-xs opacity-60">Avg. ₹{(stats.total / (orders.length || 1)).toFixed(2)} per order</p>
          </div>
        </div>

        <div className="mt-12 text-center">
            <p className="text-gray-400 text-sm italic">"Investing in local farmers is investing in health and community."</p>
        </div>
      </div>
    </div>
  );
};

export default SpentAnalysis;
