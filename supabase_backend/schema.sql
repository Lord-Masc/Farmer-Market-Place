-- Create a table for Public Profiles
CREATE TABLE public.profiles (
  id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  phone_number TEXT NOT NULL,
  role TEXT CHECK (role IN ('buyer', 'farmer')) NOT NULL,
  state TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Enable Row Level Security (RLS) for public.profiles
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Profiles: Anyone can view profiles (useful for seeing farmers or buyers)
CREATE POLICY "Public profiles are viewable by everyone."
  ON public.profiles FOR SELECT
  USING ( true );

-- Profiles: Users can insert their own profile upon signup
CREATE POLICY "Users can insert their own profile."
  ON public.profiles FOR INSERT
  WITH CHECK ( auth.uid() = id );

-- Profiles: Users can update their own profile
CREATE POLICY "Users can update own profile."
  ON public.profiles FOR UPDATE
  USING ( auth.uid() = id );

-- Create a table for Products
CREATE TABLE public.products (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  farmer_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  price NUMERIC NOT NULL,
  unit TEXT NOT NULL DEFAULT 'kg',
  stock NUMERIC NOT NULL DEFAULT 0,
  image_url TEXT,
  status TEXT CHECK (status IN ('Active', 'Out of Stock')) DEFAULT 'Active',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Enable RLS for public.products
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;

-- Products: Viewable by everyone
CREATE POLICY "Products are viewable by everyone."
  ON public.products FOR SELECT
  USING ( true );

-- Products: Only farmers can insert products
CREATE POLICY "Farmers can insert their own products."
  ON public.products FOR INSERT
  WITH CHECK ( auth.uid() = farmer_id );

-- Products: Farmers can update their own products
CREATE POLICY "Farmers can update own products."
  ON public.products FOR UPDATE
  USING ( auth.uid() = farmer_id );

-- Create a table for Orders
CREATE TABLE public.orders (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  buyer_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE NOT NULL,
  product_id UUID REFERENCES public.products(id) ON DELETE SET NULL,
  amount NUMERIC NOT NULL,
  status TEXT CHECK (status IN ('Pending', 'Shipped', 'Delivered', 'Cancelled')) DEFAULT 'Pending',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Enable RLS for public.orders
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;

-- Orders: Buyers can see their own orders
CREATE POLICY "Buyers can view their own orders."
  ON public.orders FOR SELECT
  USING ( auth.uid() = buyer_id );

-- Orders: Farmers can see orders for their products
CREATE POLICY "Farmers can view orders for their products."
  ON public.orders FOR SELECT
  USING (
    auth.uid() IN (
      SELECT farmer_id FROM public.products WHERE id = product_id
    )
  );

-- Orders: Buyers can create orders
CREATE POLICY "Buyers can insert their own orders."
  ON public.orders FOR INSERT
  WITH CHECK ( auth.uid() = buyer_id );

-- Orders: Farmers can update the status of orders for their products
CREATE POLICY "Farmers can update the status of their orders."
  ON public.orders FOR UPDATE
  USING (
    auth.uid() IN (
      SELECT farmer_id FROM public.products WHERE id = product_id
    )
  );
