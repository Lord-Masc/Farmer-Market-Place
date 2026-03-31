import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Home from './pages/Home';
import Login from './pages/Login';
import SignUp from './pages/SignUp';
import Products from './pages/Product';
import FarmerDashboard from './pages/FarmerDashboard';
import GroupBuying from './pages/GroupBuying';

function App() {
  return (
    <BrowserRouter>
      <div className="App">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<SignUp />} />
          <Route path="/products" element={<Products />} />
          <Route path="/dashboard" element={<FarmerDashboard />} />
          <Route path="/group-buying" element={<GroupBuying />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}

export default App;
