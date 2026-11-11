# Execution Flow Map

This is a high-level map based on the repository structure documented in the root README. Verify exact function names and call sites in source before changing a flow.

## Application topology
1. Browser loads the React/Vite application from Vercel.
2. React pages/components render marketplace, auth, buyer, farmer, and checkout experiences.
3. Frontend uses Supabase client for authentication and direct database-backed marketplace/profile operations.
4. Payment-related requests go to the Express API hosted on Render.
5. Express routes delegate to controllers, which use service-layer logic for Razorpay and Supabase operations.
6. Supabase Auth/Postgres/RLS hold identity and application data.

## Payment/order path — verify in code before editing
- Buyer selects a product and creates an order request.
- Farmer reviews and confirms the order; stock reservation must be atomic with approval.
- Buyer proceeds to checkout for an approved order.
- Backend creates a Razorpay order using stored order/product data and authenticated buyer identity.
- Razorpay returns payment outcome; backend verifies signature, captured state, amount, and binding to the internal order.
- Backend records payment and updates the order state idempotently.
- Shipment/completion/refund paths must enforce valid state transitions and authorization.

## Change-tracing checklist
For any change, record:
- Entry point (page, component, route, trigger).
- Caller and callee chain.
- Database tables/views/RPCs touched.
- Authenticated role and authorization checks at each boundary.
- External systems involved (Supabase, Razorpay, Vercel, Render).
- Failure paths, retries, idempotency, and concurrency behavior.
- Tests covering the complete path.

Do not infer that a UI label, database status, or README statement proves an external payment settlement occurred.
