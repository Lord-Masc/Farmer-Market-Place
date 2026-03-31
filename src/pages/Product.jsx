import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import Navbar from '../components/Navbar';
import Footer from '../components/Footer';

const Products = () => {
  const [activeCategory, setActiveCategory] = useState('All');

  const categories = ['All', 'Vegetables', 'Fruits', 'Grains', 'Dairy', 'Organic'];
  
  const products = [
    { id: 1, emoji: '🍅', name: 'Desi Tomatoes', price: 45, unit: 'kg', farm: 'Ramesh Farm', category: 'Vegetables', rating: 4.8 },
    { id: 2, emoji: '🥕', name: 'Crunchy Carrots', price: 35, unit: 'kg', farm: 'Green Valley', category: 'Vegetables', rating: 4.5 },
    { id: 3, emoji: '🥭', name: 'Alphonso Mangoes', price: 120, unit: 'kg', farm: 'Suresh Farms', category: 'Fruits', rating: 4.9 },
    { id: 4, emoji: '🌽', name: 'Golden Maize', price: 22, unit: 'kg', farm: 'Punjab Fields', category: 'Grains', rating: 4.7 },
    { id: 5, emoji: '🥛', name: 'Pure Cow Milk', price: 65, unit: 'L', farm: 'Dairy Delight', category: 'Dairy', rating: 4.6 },
    { id: 6, emoji: '🧅', name: 'Red Onions', price: 25, unit: 'kg', farm: 'Mohan Ki Khet', category: 'Vegetables', rating: 4.4 },
    { id: 7, emoji: '🥦', name: 'Fresh Broccoli', price: 80, unit: 'kg', farm: 'Devi Agro', category: 'Vegetables', rating: 4.8 },
    { id: 8, emoji: '🍎', name: 'Shimla Apples', price: 150, unit: 'kg', farm: 'Himachal Orchard', category: 'Fruits', rating: 4.9 },
  ];

  const filteredProducts = activeCategory === 'All' 
    ? products 
    : products.filter(p => p.category === activeCategory);

  return (
    <div className="min-h-screen font-dmsans bg-cream">
      <Navbar />

      <main className="pt-32 pb-20 px-[5%] max-w-[1400px] mx-auto">
        <header className="mb-12">
          <h1 className="font-playfair text-4xl font-black text-green-deep mb-4">Fresh Produce Marketplace</h1>
          <p className="text-[#4a4a4a] text-lg max-w-[600px]">Browse and order directly from local farms. No middlemen, just fresh food at fair prices.</p>
        </header>

        {/* Filter and Search Bar */}
        <div className="flex flex-col lg:flex-row gap-6 justify-between items-start lg:items-center mb-10">
          <div className="flex flex-wrap gap-2">
            {categories.map(cat => (
              <button 
                key={cat}
                onClick={() => setActiveCategory(cat)}
                className={`px-6 py-2.5 rounded-full text-sm font-semibold transition-all duration-300 ${activeCategory === cat ? 'bg-green-deep text-white shadow-md' : 'bg-cream-dark text-[#4a4a4a] hover:bg-green-mid hover:text-white'}`}
              >
                {cat}
              </button>
            ))}
          </div>

          <div className="w-full lg:w-[400px] relative">
            <input 
              type="text" 
              placeholder="Search fruits, vegetables, grains..." 
              className="w-full bg-white rounded-full pl-12 pr-6 py-3.5 text-sm shadow-sm border border-transparent focus:border-green-fresh focus:outline-none transition-all"
            />
            <span className="absolute left-5 top-1/2 -translate-y-1/2 text-lg">🔍</span>
          </div>
        </div>

        {/* Product Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
          {filteredProducts.map(product => (
            <div 
              key={product.id}
              className="bg-white rounded-[24px] p-6 shadow-sm border border-transparent hover:border-green-fresh hover:shadow-[0_20px_50px_rgba(45,106,79,0.08)] transition-all duration-300 group"
            >
              <div className="w-full h-40 bg-cream-dark rounded-[20px] flex items-center justify-center text-6xl mb-6 group-hover:scale-105 transition-transform duration-300">
                {product.emoji}
              </div>
              
              <div className="flex justify-between items-start mb-1">
                <span className="text-xs font-bold text-green-mid uppercase tracking-wider">{product.category}</span>
                <span className="text-sm font-bold text-amber">⭐ {product.rating}</span>
              </div>
              
              <h3 className="font-playfair text-xl font-bold text-green-deep mb-1">{product.name}</h3>
              <p className="text-xs text-gray-500 mb-4 tracking-wide">📍 {product.farm}</p>
              
              <div className="flex items-center justify-between mt-auto">
                <div>
                  <span className="text-xl font-black text-green-deep">₹{product.price}</span>
                  <span className="text-xs text-gray-400 font-medium ml-1">/{product.unit}</span>
                </div>
                
                <button className="w-10 h-10 bg-green-deep text-white rounded-full flex items-center justify-center font-bold text-xl hover:bg-green-mid hover:-translate-y-1 transition-all shadow-md">
                  +
                </button>
              </div>
            </div>
          ))}
        </div>

        {filteredProducts.length === 0 && (
          <div className="py-20 text-center">
            <span className="text-6xl mb-6 block">🚫</span>
            <p className="text-gray-500 font-medium">No products found for this category.</p>
          </div>
        )}
      </main>

      <Footer />
    </div>
  );
};

export default Products;
