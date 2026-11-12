import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../services/supabase';
import { uploadImage } from '../services/escrowApi';
import { validateImageFile } from '../utils/fileValidation';

const UserProfile = () => {
    const { user } = useAuth();
    const navigate = useNavigate();
    const [loading, setLoading] = useState(true);
    const [profile, setProfile] = useState(null);

    useEffect(() => {
        if (!user) {
            navigate('/login');
            return;
        }
        fetchProfile();
    }, [user]);

    const fetchProfile = async () => {
        setLoading(true);
        try {
            const { data, error } = await supabase
                .from('profiles')
                .select('*')
                .eq('id', user.id)
                .single();

            if (error) throw error;
            setProfile(data);
        } catch (err) {
            console.error(err);
        } finally {
            setLoading(false);
        }
    };

    if (loading) return <div className="min-h-screen bg-cream flex justify-center items-center font-bold italic text-green-deep">Loading your identity...</div>;

    return (
        <div className="min-h-screen bg-cream font-dmsans p-6 md:p-12">
            <div className="max-w-4xl mx-auto">
                <Link 
                    to={profile?.role === 'farmer' ? '/farmer-dashboard' : '/buyer-dashboard'} 
                    className="inline-flex items-center gap-2 text-green-deep font-black mb-10 hover:text-amber transition-colors group"
                >
                    <span className="group-hover:-translate-x-1 transition-transform">←</span> Back to {profile?.role === 'farmer' ? 'Farmer' : 'Buyer'} Dashboard
                </Link>

                <div className="grid grid-cols-1 lg:grid-cols-3 gap-10">
                    {/* Left: Identity Card */}
                    <div className="lg:col-span-1 bg-white rounded-[48px] p-10 shadow-sm border border-cream-dark text-center flex flex-col items-center">
                        <div className="relative group mb-8">
                            <div className="w-40 h-40 rounded-full bg-cream border-4 border-amber ring-8 ring-amber/5 flex items-center justify-center overflow-hidden shadow-2xl transition-all group-hover:scale-105">
                                 {profile?.photo_url ? (
                                     <img src={profile.photo_url} className="w-full h-full object-cover" />
                                 ) : (
                                     <span className="text-6xl font-black text-green-deep opacity-10">{profile?.first_name?.charAt(0)}</span>
                                 )}
                            </div>
                            <label className="absolute bottom-1 right-1 bg-green-deep text-white w-12 h-12 rounded-full flex items-center justify-center shadow-lg border-4 border-white cursor-pointer hover:bg-green-fresh transition-all transform hover:rotate-12">
                                 📸
                                 <input type="file" className="hidden" onChange={async (e) => {
                                     const file = e.target.files[0];
                                     if (file) {
                                         const validationError = validateImageFile(file);
                                         if (validationError) { alert(validationError); return; }
                                         try {
                                             const publicUrl = await uploadImage(file, 'profile');
                                             await supabase.from('profiles').update({ photo_url: publicUrl }).eq('id', user.id);
                                             window.location.reload();
                                         } catch (err) { alert(err.message); }
                                     }
                                 }} />
                            </label>
                        </div>
                        <h2 className="text-3xl font-playfair font-black text-green-deep">{profile?.first_name} {profile?.last_name}</h2>
                        
                        <div className="w-full mt-10 space-y-4 border-t border-cream-dark pt-10 text-left">
                            <div className="flex items-center gap-4 group p-4 bg-cream/30 rounded-[28px] border border-cream-dark/50 hover:border-amber transition-all">
                                <div className="w-10 h-10 rounded-xl bg-white flex items-center justify-center group-hover:scale-110 transition-transform shadow-sm">📧</div>
                                <div className="overflow-hidden flex-1">
                                    <p className="text-[10px] font-black uppercase text-gray-400 leading-tight">Email Address</p>
                                    <p className="text-[11px] font-black text-green-deep truncate">{profile?.email_address}</p>
                                </div>
                            </div>
                            <div className="flex items-center gap-4 group p-4 bg-cream/30 rounded-[28px] border border-cream-dark/50 hover:border-amber transition-all">
                                <div className="w-10 h-10 rounded-xl bg-white flex items-center justify-center group-hover:scale-110 transition-transform shadow-sm">📞</div>
                                <div>
                                    <p className="text-[10px] font-black uppercase text-gray-400 leading-tight">Phone Member</p>
                                    <p className="text-sm font-black text-green-deep">+91 {profile?.phone_number}</p>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Right: Detailed Fields */}
                    <div className="lg:col-span-2 space-y-8">
                        {/* Personal Tab */}
                        <div className="bg-white rounded-[48px] p-10 shadow-sm border border-cream-dark">
                            <h3 className="text-xl font-bold text-green-deep mb-10 flex items-center gap-2">
                                <span className="w-8 h-8 rounded-xl bg-green-fresh/10 text-green-fresh flex items-center justify-center text-sm">👤</span>
                                Your Personal Identity
                            </h3>
                            <form className="space-y-8" onSubmit={async (e) => {
                                e.preventDefault();
                                const formData = new FormData(e.target);
                                const address = formData.get('address')?.trim();
                                
                                if (!address) {
                                    alert("🚨 Mandatory Action Needed: Please provide your Full Harvest Address for secure logistics. We cannot safeguard your changes without it! ✨");
                                    return;
                                }

                                try {
                                    const { error } = await supabase.from('profiles').update({
                                        first_name: formData.get('first_name'),
                                        last_name: formData.get('last_name'),
                                        address: address,
                                    }).eq('id', user.id);
                                    if (error) throw error;
                                    alert("Identity Safeguarded Successfully! ✨");
                                } catch (err) { alert(err.message); }
                            }}>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                                    <div className="space-y-2">
                                        <label className="text-[10px] font-black uppercase text-gray-400 ml-1 tracking-widest">First Name</label>
                                        <input name="first_name" defaultValue={profile?.first_name} className="w-full bg-cream/30 border-2 border-transparent focus:border-amber focus:bg-white px-6 py-4 rounded-3xl outline-none transition-all font-bold text-green-deep" />
                                    </div>
                                    <div className="space-y-2">
                                        <label className="text-[10px] font-black uppercase text-gray-400 ml-1 tracking-widest">Last Name</label>
                                        <input name="last_name" defaultValue={profile?.last_name} className="w-full bg-cream/30 border-2 border-transparent focus:border-amber focus:bg-white px-6 py-4 rounded-3xl outline-none transition-all font-bold text-green-deep" />
                                    </div>
                                </div>
                                <div className="space-y-2">
                                    <label className="text-[10px] font-black uppercase text-gray-400 ml-1 tracking-widest">Full Harvest Address</label>
                                    <textarea name="address" defaultValue={profile?.address} placeholder="Mention House No, Street, Landmark and Pincode..." className="w-full bg-cream/30 border-2 border-transparent focus:border-amber focus:bg-white px-6 py-5 rounded-[40px] outline-none transition-all font-bold text-green-deep min-h-[160px] resize-none" />
                                </div>
                                <button className="w-full bg-green-deep text-white py-5 rounded-[32px] font-black text-sm shadow-2xl hover:bg-green-mid transform hover:-translate-y-1 active:scale-95 transition-all">
                                    Safeguard Changes
                                </button>
                            </form>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default UserProfile;
