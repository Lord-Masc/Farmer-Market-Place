import React, { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '../services/supabase';
import { validateName, validatePhone, validateEmail } from '../utils/helper';

const SignUp = () => {
  const [searchParams] = useSearchParams();
  const [role, setRole] = useState(searchParams.get('role') === 'farmer' ? 'farmer' : 'buyer');
  const navigate = useNavigate();

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [state, setState] = useState('');
  const [agreed, setAgreed] = useState(false);
  
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  // Clear errors when switching roles
  React.useEffect(() => {
    setError(null);
  }, [role]);

  const handleSignUp = async (e) => {
    e.preventDefault();
    setError(null);

    // Validation
    if (!validateName(firstName) || !validateName(lastName)) {
      setError('Name should only contain characters.');
      return;
    }
    if (!validatePhone(phone)) {
      setError('Please enter a valid 10-digit phone number.');
      return;
    }
    if (!validateEmail(email)) {
      setError('Please enter a valid email address.');
      return;
    }
    if (!agreed) {
      setError('You must agree to the terms and conditions.');
      return;
    }

    setLoading(true);

    try {
      // Step 1: Check if user already exists (Global Email Check)
      const { data: existingUser } = await supabase
        .from('profiles')
        .select('id, role')
        .eq('email_address', email)
        .limit(1)
        .maybeSingle();

      if (existingUser) {
        setError(`This email is already registered as a ${existingUser.role}. Please use a different email or log in.`);
        setLoading(false);
        return;
      }

      // Step 2: Sign up with Supabase Auth
      const { data, error: signUpError } = await supabase.auth.signUp({
        email,
        password,
      });

      if (signUpError) {
        if (signUpError.message.includes('already registered')) {
          setError('This email is already in use by another account.');
        } else if (signUpError.message.includes('rate limit')) {
          setError('Too many sign-up attempts. Please wait a few minutes.');
        } else {
          setError(signUpError.message);
        }
        setLoading(false);
        return;
      }
      
      const userId = data?.user?.id;

      if (userId) {
        // Step 3: Insert or update the role profile
        const { error: profileError } = await supabase
          .from('profiles')
          .insert([
            {
              id: userId,
              first_name: firstName,
              last_name: lastName,
              email_address: email,
              phone_number: phone,
              role: role,
              state: role === 'farmer' ? state : null,
            }
          ]);
          
        if (profileError) {
            if (profileError.code === '23505') { // Unique constraint violation
                setError(`You already have a ${role} profile with this account.`);
                setLoading(false);
                return;
            }
          console.error("Profile creation error:", profileError);
          setError(profileError.message);
          setLoading(false);
          return;
        }
        
        // Redirect to dashboard after successful signup and profile creation
        navigate(`/${role}-dashboard`);
      }

    } catch (err) {
      console.error(err);
      setError('An unexpected error occurred. Please try again.');
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen font-dmsans flex items-center justify-center bg-cream px-4 py-12 relative overflow-hidden">
      {/* Background blobs matching the hero section */}
      <div className="absolute top-[-10%] right-[-10%] w-[400px] h-[400px] bg-green-fresh blur-[80px] opacity-15 rounded-full animate-float z-0" />
      <div className="absolute bottom-[-10%] left-[-5%] w-[350px] h-[350px] bg-amber blur-[80px] opacity-15 rounded-full animate-float z-0" style={{ animationDelay: '-3s' }} />

      <div className="w-full max-w-[480px] bg-white rounded-[24px] p-8 sm:p-10 shadow-[0_20px_50px_rgba(26,58,42,0.08)] relative z-10 animate-fadeIn">
        
        <div className="text-center mb-8">
          <Link to="/" className="font-playfair text-[1.8rem] font-black cursor-pointer inline-block mb-6">
            <span className="text-green-deep">Agro</span>
            <span className="text-amber">Connect</span>
          </Link>
          <h2 className="font-playfair text-2xl font-bold text-green-deep mb-2">Create Your Account</h2>
          <p className="text-[#4a4a4a] text-sm">Join the network connecting field to fork</p>
        </div>

        {/* Role Selector */}
        <div className="flex bg-cream-dark p-1 rounded-xl mb-8">
          <button 
            type="button"
            onClick={() => setRole('buyer')}
            className={`flex-1 py-2.5 text-sm font-bold rounded-lg transition-all duration-300 ${role === 'buyer' ? 'bg-white text-green-deep shadow-sm' : 'text-gray-500'}`}
          >
            🛒 I'm a Buyer
          </button>
          <button 
            type="button"
            onClick={() => setRole('farmer')}
            className={`flex-1 py-2.5 text-sm font-bold rounded-lg transition-all duration-300 ${role === 'farmer' ? 'bg-white text-green-deep shadow-sm' : 'text-gray-500'}`}
          >
            👨‍🌾 I'm a Farmer
          </button>
        </div>

        {error && (
          <div className="mb-6 p-3 bg-red-50 border border-red-200 text-red-600 text-sm rounded-xl font-medium text-center">
            {error}
          </div>
        )}

        <form className="grid grid-cols-1 sm:grid-cols-2 gap-5" onSubmit={handleSignUp}>
          <div className="space-y-1.5 text-left">
            <label className="text-sm font-medium text-green-deep block">First Name</label>
            <input 
              type="text" 
              required
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              placeholder="First Name" 
              className="w-full bg-cream-dark rounded-xl px-4 py-3 text-sm text-[#4a4a4a] border border-transparent focus:border-green-fresh focus:bg-white focus:outline-none transition-all duration-300 placeholder-gray-400"
            />
          </div>

          <div className="space-y-1.5 text-left">
            <label className="text-sm font-medium text-green-deep block">Last Name</label>
            <input 
              type="text" 
              required
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              placeholder="Last Name" 
              className="w-full bg-cream-dark rounded-xl px-4 py-3 text-sm text-[#4a4a4a] border border-transparent focus:border-green-fresh focus:bg-white focus:outline-none transition-all duration-300 placeholder-gray-400"
            />
          </div>

          <div className="space-y-1.5 text-left sm:col-span-2">
            <label className="text-sm font-medium text-green-deep block">Email Address</label>
            <input 
              type="email" 
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@example.com" 
              className="w-full bg-cream-dark rounded-xl px-4 py-3 text-sm text-[#4a4a4a] border border-transparent focus:border-green-fresh focus:bg-white focus:outline-none transition-all duration-300 placeholder-gray-400"
            />
          </div>

          <div className="space-y-1.5 text-left sm:col-span-2">
            <label className="text-sm font-medium text-green-deep block">Phone Number</label>
            <div className="flex gap-2">
              <span className="bg-cream-dark rounded-xl px-3 py-3 text-sm text-gray-500 font-medium">+91</span>
              <input 
                type="tel" 
                required
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="10-digit mobile number" 
                className="flex-1 bg-cream-dark rounded-xl px-4 py-3 text-sm text-[#4a4a4a] border border-transparent focus:border-green-fresh focus:bg-white focus:outline-none transition-all duration-300 placeholder-gray-400"
              />
            </div>
          </div>

          <div className="space-y-1.5 text-left sm:col-span-2 relative">
            <label className="text-sm font-medium text-green-deep block">Password</label>
            <div className="relative">
              <input 
                type={showPassword ? "text" : "password"} 
                required
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Create a strong password (min 6 chars)" 
                className="w-full bg-cream-dark rounded-xl px-4 py-3 text-sm text-[#4a4a4a] border border-transparent focus:border-green-fresh focus:bg-white focus:outline-none transition-all duration-300 placeholder-gray-400 pr-12"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-4 top-1/2 -translate-y-1/2 text-lg opacity-50 hover:opacity-100 transition-opacity"
              >
                {showPassword ? '👁️' : '🔒'}
              </button>
            </div>
          </div>

          {role === 'farmer' && (
            <div className="space-y-1.5 text-left sm:col-span-2 animate-slideDown">
              <label className="text-sm font-medium text-green-deep block">Farm Location (UP District)</label>
              <select 
                required
                value={state}
                onChange={(e) => setState(e.target.value)}
                className="w-full bg-cream-dark rounded-xl px-4 py-3 text-sm text-[#4a4a4a] border border-transparent focus:border-green-fresh focus:bg-white focus:outline-none transition-all duration-300 h-[50px] overflow-y-auto"
              >
                <option value="">Select District</option>
                <option value="Agra">Agra</option>
                <option value="Aligarh">Aligarh</option>
                <option value="Prayagraj">Prayagraj (Allahabad)</option>
                <option value="Ambedkar Nagar">Ambedkar Nagar</option>
                <option value="Amethi">Amethi</option>
                <option value="Amroha">Amroha</option>
                <option value="Auraiya">Auraiya</option>
                <option value="Azamgarh">Azamgarh</option>
                <option value="Baghpat">Baghpat</option>
                <option value="Bahraich">Bahraich</option>
                <option value="Ballia">Ballia</option>
                <option value="Balrampur">Balrampur</option>
                <option value="Banda">Banda</option>
                <option value="Barabanki">Barabanki</option>
                <option value="Bareilly">Bareilly</option>
                <option value="Basti">Basti</option>
                <option value="Bhadohi">Bhadohi</option>
                <option value="Bijnor">Bijnor</option>
                <option value="Budaun">Budaun</option>
                <option value="Bulandshahr">Bulandshahr</option>
                <option value="Chandauli">Chandauli</option>
                <option value="Chitrakoot">Chitrakoot</option>
                <option value="Deoria">Deoria</option>
                <option value="Etah">Etah</option>
                <option value="Etawah">Etawah</option>
                <option value="Ayodhya">Ayodhya (Faizabad)</option>
                <option value="Farrukhabad">Farrukhabad</option>
                <option value="Fatehpur">Fatehpur</option>
                <option value="Firozabad">Firozabad</option>
                <option value="Gautam Buddha Nagar">Gautam Buddha Nagar (Noida)</option>
                <option value="Ghaziabad">Ghaziabad</option>
                <option value="Ghazipur">Ghazipur</option>
                <option value="Gonda">Gonda</option>
                <option value="Gorakhpur">Gorakhpur</option>
                <option value="Hamirpur">Hamirpur</option>
                <option value="Hapur">Hapur</option>
                <option value="Hardoi">Hardoi</option>
                <option value="Hathras">Hathras</option>
                <option value="Jalaun">Jalaun</option>
                <option value="Jaunpur">Jaunpur</option>
                <option value="Jhansi">Jhansi</option>
                <option value="Kannauj">Kannauj</option>
                <option value="Kanpur Dehat">Kanpur Dehat</option>
                <option value="Kanpur Nagar">Kanpur Nagar</option>
                <option value="Kasganj">Kasganj</option>
                <option value="Kaushambi">Kaushambi</option>
                <option value="Kushinagar">Kushinagar</option>
                <option value="Lakhimpur Kheri">Lakhimpur Kheri</option>
                <option value="Lalitpur">Lalitpur</option>
                <option value="Lucknow">Lucknow</option>
                <option value="Maharajganj">Maharajganj</option>
                <option value="Mahoba">Mahoba</option>
                <option value="Mainpuri">Mainpuri</option>
                <option value="Mathura">Mathura</option>
                <option value="Mau">Mau</option>
                <option value="Meerut">Meerut</option>
                <option value="Mirzapur">Mirzapur</option>
                <option value="Moradabad">Moradabad</option>
                <option value="Muzaffarnagar">Muzaffarnagar</option>
                <option value="Pilibhit">Pilibhit</option>
                <option value="Pratapgarh">Pratapgarh</option>
                <option value="Raebareli">Raebareli</option>
                <option value="Rampur">Rampur</option>
                <option value="Saharanpur">Saharanpur</option>
                <option value="Sambhal">Sambhal</option>
                <option value="Sant Kabir Nagar">Sant Kabir Nagar</option>
                <option value="Shahjahanpur">Shahjahanpur</option>
                <option value="Shamli">Shamli</option>
                <option value="Shravasti">Shravasti</option>
                <option value="Siddharthnagar">Siddharthnagar</option>
                <option value="Sitapur">Sitapur</option>
                <option value="Sonbhadra">Sonbhadra</option>
                <option value="Sultanpur">Sultanpur</option>
                <option value="Unnao">Unnao</option>
                <option value="Varanasi">Varanasi</option>
              </select>
            </div>
          )}

          <div className="sm:col-span-2 flex items-start gap-2 mt-2">
            <input 
              type="checkbox" 
              required 
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
              className="mt-1 accent-green-deep" 
            />
            <span className="text-xs text-gray-500 leading-normal">
              I agree to the <a href="#" className="text-green-deep font-bold hover:underline">Terms of Service</a> and <a href="#" className="text-green-deep font-bold hover:underline">Privacy Policy</a>
            </span>
          </div>

          <button 
            type="submit" 
            disabled={loading || !agreed}
            className={`sm:col-span-2 w-full bg-green-deep text-white rounded-xl py-3.5 text-sm font-bold shadow-md hover:bg-green-mid transition-all duration-300 mt-2 ${loading || !agreed ? 'opacity-50 cursor-not-allowed' : 'hover:-translate-y-[1px] hover:shadow-[0_6px_20px_rgba(45,106,79,0.35)]'}`}
          >
            {loading ? 'Creating Account...' : `Create ${role.charAt(0).toUpperCase() + role.slice(1)} Account`}
          </button>
        </form>

        <div className="mt-8 pt-6 border-t border-gray-100 text-center text-sm">
          <p className="text-gray-500">
            Already have an account?{' '}
            <Link to="/login" className="font-bold text-green-deep hover:text-amber transition-colors duration-200 ml-1">
              Sign In
            </Link>
          </p>
        </div>
      </div>
      
      {/* Absolute back button */}
      <Link to="/" className="absolute top-6 left-6 flex items-center gap-2 text-green-deep text-sm font-semibold hover:text-amber transition-colors duration-200 z-20">
        <span>←</span> Back to Home
      </Link>
    </div>
  );
};

export default SignUp;
