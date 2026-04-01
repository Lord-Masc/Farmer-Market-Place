# Supabase Backend Setup

This folder contains the database schema required for the `Farmer-Market-Place` project to function successfully.
Since the frontend uses `@supabase/supabase-js`, the "backend" for this project is hosted on Supabase and primarily consists of SQL tables and authentication settings.

## Instructions to Setup the Backend

1. **Create a Supabase Project:**
   Go to [Supabase](https://supabase.com/) and create a new project.

2. **Run the SQL Schema:**
   - On the Supabase Dashboard, go to the **SQL Editor** on the left menu.
   - Click **New Query**.
   - Copy and paste the contents of `schema.sql` found in this `supabase_backend` directory.
   - Click **Run**. This will create your `profiles`, `products`, and `orders` tables along with the security rules so that farmers and buyers can only access what they are supposed to.

3. **Configure Authentication:**
   - Go to **Authentication -> Providers** and make sure Email/Password signups are enabled.
   - By default Supabase requires email verifications. If you want to test easily without confirming emails, go to **Authentication -> Providers -> Email** and toggle OFF "Confirm email".

4. **Connect Frontend to Backend:**
   - Go to **Project Settings -> API**.
   - Copy the **Project URL** and the **anon `public` key**.
   - Open `.env.local` inside the root directory and paste them:

   ```env
   VITE_SUPABASE_URL=your-project-url-here
   VITE_SUPABASE_ANON_KEY=your-anon-key-here
   ```

5. **Restart Development Server:**
   ```bash
   npm run dev
   ```

You are now ready to test the Signup, Login, and Dashboard features as a fully functional fullstack application!
