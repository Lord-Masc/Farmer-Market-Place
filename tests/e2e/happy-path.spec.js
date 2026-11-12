// Happy path (a): signup -> list -> order -> pay -> ship -> deliver -> release.
//
// UI-flow verification only — see tests/e2e/mock.js for the scope note.
// Every network call is intercepted; no live Supabase, Razorpay, or
// backend is involved. The farmer and the buyer are two browser contexts
// sharing one in-memory mock store (one marketplace).
import { test, expect } from '@playwright/test';
import { createStore, installMocks, signupAs, dismissFarmerLocationModal, dismissBuyerLocationModal, PNG_1X1 } from './mock.js';

test('signup -> list -> order -> pay -> ship -> deliver -> release', async ({ browser }) => {
  const store = createStore();
  const farmerCtx = await browser.newContext();
  const buyerCtx = await browser.newContext();
  const farmer = await farmerCtx.newPage();
  const buyer = await buyerCtx.newPage();
  await installMocks(farmer, store);
  await installMocks(buyer, store);

  // 1. Farmer signs up through the real form.
  await signupAs(farmer, {
    firstName: 'Ramu', lastName: 'Kumar', email: 'farmer@mock.local',
    phone: '9876500001', password: 'mockpass1', role: 'farmer',
  });
  await dismissFarmerLocationModal(farmer);
  await expect(farmer).toHaveURL(/\/farmer-dashboard/);

  // 2. Farmer lists a crop (2 photos required by the form).
  await farmer.getByRole('button', { name: '+ List New Crop' }).click();
  await farmer.getByPlaceholder('Wheat...').fill('Wheat');
  await farmer.locator('form').locator('input[type="number"]').first().fill('100');
  await farmer.getByPlaceholder('₹').fill('25');
  await farmer.getByPlaceholder('Specific field location, village, or warehouse address...').fill('Village Rampur, Mathura');
  const photoInputs = farmer.locator('input[type="file"]');
  await photoInputs.nth(0).setInputFiles({ name: 'crop1.png', mimeType: 'image/png', buffer: PNG_1X1 });
  await photoInputs.nth(1).setInputFiles({ name: 'crop2.png', mimeType: 'image/png', buffer: PNG_1X1 });
  await farmer.getByRole('button', { name: 'List Harvest' }).click();
  await expect(farmer.getByText('Your harvest is LIVE in the marketplace!')).toBeVisible();
  expect(store.products).toHaveLength(1);
  const product = store.products[0];
  expect(product.name).toBe('Wheat');
  expect(product.user_price).toBe(25);

  // 3. Buyer signs up and orders 10 kg of the listing.
  await signupAs(buyer, {
    firstName: 'Meera', lastName: 'Sharma', email: 'buyer@mock.local',
    phone: '9876500002', password: 'mockpass1', role: 'buyer',
  });
  await dismissBuyerLocationModal(buyer);
  await expect(buyer).toHaveURL(/\/buyer-dashboard/);
  await buyer.goto('/buyer-dashboard?tab=Marketplace');
  await expect(buyer.getByText('Wheat', { exact: true }).first()).toBeVisible({ timeout: 15000 });
  await buyer.getByRole('button', { name: 'Order Now →' }).first().click();
  // Quantity defaults to 1; raise it to 10 kg with the + stepper.
  for (let i = 0; i < 9; i++) {
    await buyer.getByRole('button', { name: '+', exact: true }).click();
  }
  // Delivery address is empty for a fresh profile: use the Change button.
  await buyer.getByRole('button', { name: 'Change ✏️' }).nth(1).click();
  await buyer.getByPlaceholder('Enter full delivery address...').fill('12 MG Road, Mathura, UP');
  await buyer.getByRole('button', { name: 'Send Order Request →' }).click();
  await buyer.getByRole('button', { name: 'Send Secure Request →' }).click();
  await expect(buyer.getByText('Request Sent!')).toBeVisible();
  expect(store.orders).toHaveLength(1);
  const order = store.orders[0];
  expect(order.status).toBe('PENDING');
  expect(order.total_price).toBe(250); // 10 kg x Rs 25

  // 4. Farmer approves the order.
  await farmer.goto('/farmer-dashboard?tab=Orders');
  await expect(farmer.getByText('Wheat').first()).toBeVisible();
  await farmer.getByRole('button', { name: 'Approve' }).first().click();
  await expect(farmer.getByText('Waiting for Payment...').first()).toBeVisible();
  expect(order.status).toBe('CONFIRMED');

  // 5. Buyer pays (Razorpay Checkout is stubbed; the handler fires with
  // fake ids and the mocked backend verifies + holds the payment).
  await buyer.goto('/buyer-dashboard?tab=My Orders');
  await buyer.getByRole('button', { name: /Pay Securely ₹250/ }).click();
  await expect(buyer).toHaveURL(/\/checkout\?orderId=/);
  await buyer.getByRole('button', { name: '🔒 Pay ₹250 Securely' }).click();
  await expect(buyer.getByText('Your Razorpay payment has been verified and recorded.')).toBeVisible({ timeout: 15000 });
  expect(order.status).toBe('PAID');
  expect(store.payments[0]?.status).toBe('HELD');

  // 6. Farmer ships without a transporter (self-delivery path).
  await farmer.goto('/farmer-dashboard?tab=Orders');
  await farmer.getByRole('button', { name: 'Mark Shipped' }).first().click();
  await farmer.getByRole('button', { name: 'Ship Without Transporter' }).click();
  await expect.poll(() => order.status).toBe('SHIPPED');

  // 7. Buyer confirms delivery -> order COMPLETED, payment RELEASED.
  await buyer.goto('/buyer-dashboard?tab=My Orders');
  await buyer.getByRole('button', { name: 'Confirm Received ✅' }).click();
  await buyer.getByRole('button', { name: 'Confirm Delivery →' }).click();
  await expect(buyer.getByText('Order completed successfully.')).toBeVisible();
  expect(order.status).toBe('COMPLETED');
  expect(store.payments[0]?.status).toBe('RELEASED');

  await farmerCtx.close();
  await buyerCtx.close();
});
