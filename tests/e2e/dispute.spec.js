// Happy path (b): dispute -> resolve.
//
// UI-flow verification only — see tests/e2e/mock.js for the scope note.
// A buyer pays for an order (short version of the happy-path setup),
// files a dispute on it, and a seeded admin resolves it with a refund.
// The admin has no signup/login form in the app, so the admin user is
// seeded into the mock store and signed in via the stored session.
import { test, expect } from '@playwright/test';
import { createStore, installMocks, signupAs, dismissFarmerLocationModal, dismissBuyerLocationModal, seedAdmin, seedSession, PNG_1X1 } from './mock.js';

test('dispute -> resolve (refund)', async ({ browser }) => {
  const store = createStore();
  const farmerCtx = await browser.newContext();
  const buyerCtx = await browser.newContext();
  const adminCtx = await browser.newContext();
  const farmer = await farmerCtx.newPage();
  const buyer = await buyerCtx.newPage();
  const admin = await adminCtx.newPage();
  await installMocks(farmer, store);
  await installMocks(buyer, store);
  await installMocks(admin, store);
  seedAdmin(store);

  // Setup: farmer lists, buyer orders, farmer approves, buyer pays.
  await signupAs(farmer, {
    firstName: 'Ramu', lastName: 'Kumar', email: 'farmer@mock.local',
    phone: '9876500001', password: 'mockpass1', role: 'farmer',
  });
  await dismissFarmerLocationModal(farmer);
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

  await signupAs(buyer, {
    firstName: 'Meera', lastName: 'Sharma', email: 'buyer@mock.local',
    phone: '9876500002', password: 'mockpass1', role: 'buyer',
  });
  await dismissBuyerLocationModal(buyer);
  await buyer.goto('/buyer-dashboard?tab=Marketplace');
  await buyer.getByRole('button', { name: 'Order Now →' }).first().click();
  // Quantity defaults to 1; raise it to 10 kg with the + stepper.
  for (let i = 0; i < 9; i++) {
    await buyer.getByRole('button', { name: '+', exact: true }).click();
  }
  await buyer.getByRole('button', { name: 'Change ✏️' }).nth(1).click();
  await buyer.getByPlaceholder('Enter full delivery address...').fill('12 MG Road, Mathura, UP');
  await buyer.getByRole('button', { name: 'Send Order Request →' }).click();
  await buyer.getByRole('button', { name: 'Send Secure Request →' }).click();
  await expect(buyer.getByText('Request Sent!')).toBeVisible();
  const order = store.orders[0];

  await farmer.goto('/farmer-dashboard?tab=Orders');
  await farmer.getByRole('button', { name: 'Approve' }).first().click();
  await expect(farmer.getByText('Waiting for Payment...').first()).toBeVisible();

  await buyer.goto('/buyer-dashboard?tab=My Orders');
  await buyer.getByRole('button', { name: /Pay Securely ₹250/ }).click();
  await buyer.getByRole('button', { name: '🔒 Pay ₹250 Securely' }).click();
  await expect(buyer.getByText('Your Razorpay payment has been verified and recorded.')).toBeVisible({ timeout: 15000 });
  expect(order.status).toBe('PAID');

  // 1. Buyer files a dispute on the paid order.
  await buyer.goto('/disputes');
  const form = buyer.locator('form').first();
  await form.locator('select').first().selectOption(order.id);
  await form.locator('select').nth(1).selectOption('quality');
  await buyer.getByPlaceholder('Describe the problem with this order…').fill('The wheat arrived damp and half the sack was spoilt.');
  await buyer.getByRole('button', { name: 'File Dispute' }).click();
  await expect(buyer).toHaveURL(/\/disputes\/dispute-/);
  expect(store.disputes).toHaveLength(1);
  const dispute = store.disputes[0];
  expect(dispute.status).toBe('filed');
  await expect(buyer.getByText('The wheat arrived damp and half the sack was spoilt.').first()).toBeVisible();

  // 2. Admin resolves it with a full refund.
  await seedSession(admin, store, 'admin@mock.local');
  await admin.goto(`/disputes/${dispute.id}`);
  await expect(admin.getByText('Admin review')).toBeVisible();
  const adminForm = admin.locator('form', { hasText: 'Resolve Dispute' });
  await adminForm.locator('select').first().selectOption('refund');
  await admin.getByPlaceholder('Why this outcome…').fill('Quality failure confirmed by the buyer photos.');
  await admin.getByRole('button', { name: 'Resolve Dispute' }).click();
  await expect(admin.getByText('This dispute is resolved — the thread is closed.')).toBeVisible();
  expect(dispute.status).toBe('resolved');
  expect(dispute.resolution).toBe('refund');
  expect(order.status).toBe('REFUNDED');

  // 3. A resolved dispute cannot be re-resolved: the admin form is gone.
  await expect(admin.getByRole('button', { name: 'Resolve Dispute' })).toHaveCount(0);
  await expect(admin.getByText('Admin review')).toHaveCount(0);

  await farmerCtx.close();
  await buyerCtx.close();
  await adminCtx.close();
});
