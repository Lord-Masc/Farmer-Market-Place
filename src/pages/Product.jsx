import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import Navbar from '../components/Navbar';
import Footer from '../components/Footer';
import { productService } from '../services/productService';

const Products = () => {
  const [activeCategory, setActiveCategory] = useState('All');
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);

  const categories = ['All', 'Vegetables', 'Fruits', 'Grains', 'Dairy', 'Organic'];
  
  useEffect(() => {
    const fetchProducts = async () => {
      setLoading(true);
      try {
        const data = await productService.getAllProducts();
        setProducts(data || []);
      } catch (error) {
        console.error("Error fetching products:", error.message);
        // No fallback data: an empty catalogue is shown honestly.
        setProducts([]);
      } finally {
        setLoading(false);
      }
    };

    fetchProducts();
  }, []);

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
        {loading ? (
            <div className="flex flex-col items-center justify-center py-20">
                <div className="w-12 h-12 border-4 border-green-mid border-t-transparent rounded-full animate-spin mb-4"></div>
                <p className="text-green-mid font-medium italic">Harvesting fresh produce...</p>
            </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
            {filteredProducts.map(product => (
              <div 
                key={product.id}
                className="bg-white rounded-[24px] p-6 shadow-sm border border-transparent hover:border-green-fresh hover:shadow-[0_20px_50px_rgba(45,106,79,0.08)] transition-all duration-300 group"
              >
                {product.image_url_1 ? (
                  <img src={product.image_url_1} alt={product.name} className="w-full h-40 object-cover rounded-[20px] mb-6 group-hover:scale-105 transition-transform duration-300" />
                ) : (
                  <div className="w-full h-40 bg-cream-dark rounded-[20px] flex items-center justify-center text-6xl mb-6 group-hover:scale-105 transition-transform duration-300">
                    🌾
                  </div>
                )}
                
                <div className="flex justify-between items-start mb-1">
                  <span className="text-xs font-bold text-green-mid uppercase tracking-wider">{product.category}</span>
                </div>
                
                <h3 className="font-playfair text-xl font-bold text-green-deep mb-1">{product.name}</h3>
                {product.address && <p className="text-xs text-gray-500 mb-4 tracking-wide">📍 {product.address}</p>}
                
                <div className="flex items-center justify-between mt-auto">
                  <div>
                    <span className="text-xl font-black text-green-deep">₹{product.user_price ?? product.price}</span>
                    <span className="text-xs text-gray-400 font-medium ml-1">/{product.unit}</span>
                  </div>
                  
                  {product.farmer_id && <Link to={`/checkout?productId=${product.id}`} className="px-4 py-2 bg-green-deep text-white rounded-full font-bold text-sm hover:bg-green-mid transition-all shadow-md">Buy Now</Link>}
                </div>
              </div>
            ))}
          </div>
        )}

        {!loading && filteredProducts.length === 0 && (
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
