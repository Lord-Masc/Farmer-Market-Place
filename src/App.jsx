import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Home from './pages/Home';
import Login from './pages/Login';
import ResetPassword from './pages/ResetPassword';
import SignUp from './pages/SignUp';
import Products from './pages/Product';
import FarmerDashboard from './pages/FarmerDashboard';
import BuyerDashboard from './pages/BuyerDashboard';
import SpentAnalysis from './pages/SpentAnalysis';
import ConfirmedOrders from './pages/ConfirmedOrders';
import PendingOrders from './pages/PendingOrders';
import UserProfile from './pages/UserProfile';
import FarmerProfile from './pages/FarmerProfile';
import Requirements from './pages/Requirements';
import NegotiationThread from './pages/NegotiationThread';
import GroupBuys from './pages/GroupBuys';
import GroupBuyDetail from './pages/GroupBuyDetail';
import Transporters from './pages/Transporters';
import ShipmentTracking from './pages/ShipmentTracking';
import Disputes from './pages/Disputes';
import DisputeDetail from './pages/DisputeDetail';
import Assistant from './pages/Assistant';
import VerificationQueue from './pages/admin/VerificationQueue';
import Checkout from './pages/Checkout';
import EscrowTest from './pages/EscrowTest';
import { AuthProvider } from './context/AuthContext';

function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <div className="App">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/login" element={<Login />} />
            <Route path="/reset-password" element={<ResetPassword />} />
            <Route path="/signup" element={<SignUp />} />
            <Route path="/products" element={<Products />} />
            <Route path="/farmers/:id" element={<FarmerProfile />} />
            <Route path="/requirements" element={<Requirements />} />
            <Route path="/negotiations/:id" element={<NegotiationThread />} />
            <Route path="/group-buys" element={<GroupBuys />} />
            <Route path="/group-buys/:id" element={<GroupBuyDetail />} />
            <Route path="/transporters" element={<Transporters />} />
            <Route path="/shipments/:id/track" element={<ShipmentTracking />} />
            <Route path="/disputes" element={<Disputes />} />
            <Route path="/disputes/:id" element={<DisputeDetail />} />
            <Route path="/assistant" element={<Assistant />} />
            <Route path="/farmer-dashboard" element={<FarmerDashboard />} />
            <Route path="/buyer-dashboard" element={<BuyerDashboard />} />
            <Route path="/spent-analysis" element={<SpentAnalysis />} />
            <Route path="/confirmed-orders" element={<ConfirmedOrders />} />
            <Route path="/pending-orders" element={<PendingOrders />} />
            <Route path="/user-profile" element={<UserProfile />} />
            <Route path="/admin/verifications" element={<VerificationQueue />} />
            <Route path="/checkout" element={<Checkout />} />
            <Route path="/escrow-test" element={<EscrowTest />} />
            {/* Keeping /dashboard as a temporary redirect or landing page can be added later if needed */}
            <Route path="/dashboard" element={<FarmerDashboard />} />
          </Routes>
        </div>
      </BrowserRouter>
    </AuthProvider>
  );
}

export default App;
