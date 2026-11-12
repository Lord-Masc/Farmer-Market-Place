// Happy path (c): group buy -> settle.
//
// UI-flow verification only — see tests/e2e/mock.js for the scope note.
// A seller lists wheat; a second farmer opens a group buy for 300 kg;
// the owner (200 kg) and a third farmer (100 kg) join to meet the
// threshold; the owner closes it direct against the seller's listing and
// the settlement table shows each participant's share of the pooled
// order total (largest-remainder split, integer paise).
import { test, expect } from '@playwright/test';
import { createStore, installMocks, signupAs, dismissFarmerLocationModal, PNG_1X1 } from './mock.js';

async function listWheat(farmer) {
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
}

test('group buy -> settle', async ({ browser }) => {
  const store = createStore();
  const sellerCtx = await browser.newContext();
  const ownerCtx = await browser.newContext();
  const joinerCtx = await browser.newContext();
  const seller = await sellerCtx.newPage();
  const owner = await ownerCtx.newPage();
  const joiner = await joinerCtx.newPage();
  await installMocks(seller, store);
  await installMocks(owner, store);
  await installMocks(joiner, store);

  // 1. Seller lists 100 kg of wheat at Rs 25/kg.
  await signupAs(seller, {
    firstName: 'Ramu', lastName: 'Kumar', email: 'seller@mock.local',
    phone: '9876500001', password: 'mockpass1', role: 'farmer',
  });
  await dismissFarmerLocationModal(seller);
  await listWheat(seller);
  const product = store.products[0];

  // 2. Owner opens a group buy: 300 kg of wheat, deadline tomorrow.
  await signupAs(owner, {
    firstName: 'Sita', lastName: 'Devi', email: 'owner@mock.local',
    phone: '9876500003', password: 'mockpass1', role: 'farmer',
  });
  await owner.goto('/group-buys');
  await owner.getByPlaceholder('Wheat...').fill('Wheat');
  await owner.getByPlaceholder('1000').fill('300');
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const local = new Date(tomorrow.getTime() - tomorrow.getTimezoneOffset() * 60000)
    .toISOString().slice(0, 16);
  await owner.locator('input[type="datetime-local"]').fill(local);
  await owner.getByRole('button', { name: 'Create Group Buy' }).click();
  await expect(owner.getByText('Wheat', { exact: true }).first()).toBeVisible();
  expect(store.groupBuys).toHaveLength(1);
  const group = store.groupBuys[0];
  expect(group.threshold_quantity).toBe(300);

  // 3. Owner joins with 200 kg, a second farmer joins with 100 kg.
  await owner.goto(`/group-buys/${group.id}`);
  await owner.getByPlaceholder('100').fill('200');
  await owner.getByRole('button', { name: 'Join Group Buy' }).click();
  await expect(owner.getByText('You have joined this group.')).toBeVisible();

  await signupAs(joiner, {
    firstName: 'Arjun', lastName: 'Singh', email: 'joiner@mock.local',
    phone: '9876500004', password: 'mockpass1', role: 'farmer',
  });
  await joiner.goto(`/group-buys/${group.id}`);
  await joiner.getByPlaceholder('100').fill('100');
  await joiner.getByRole('button', { name: 'Join Group Buy' }).click();
  await expect(joiner.getByText('You have joined this group.')).toBeVisible();
  expect(group.total_quantity).toBe(300);

  // 4. Owner closes direct against the seller's listing at the listing
  // price (Rs 25/kg): pooled order 300 kg = Rs 7,500.
  await owner.goto(`/group-buys/${group.id}`);
  await expect(owner.getByText('Close the group & place the pooled order')).toBeVisible();
  const closeForm = owner.locator('form', { hasText: 'Listing to buy from' });
  await closeForm.locator('select').first().selectOption(product.id);
  await owner.getByPlaceholder('Village, town, district…').fill('Mathura mandi, UP');
  await owner.getByRole('button', { name: 'Close Group & Place Pooled Order' }).click();
  // NOTE: handleCloseDirect sets a "Group closed — ..." note, but the
  // note renders inside the close section, which unmounts once the group
  // is closed (isOpen flips false) — so the note is never visible. The
  // settlement section below is the observable success signal.
  await expect(owner.getByText('Settlement')).toBeVisible({ timeout: 15000 });
  expect(group.status).toBe('closed');
  const order = store.orders.find((o) => o.id === group.order_id);
  expect(order?.total_price).toBe(7500);

  // 5. Settlement: owner's share Rs 5,000.00 (200/300), joiner's
  // Rs 2,500.00 (100/300); rows sum exactly to the pooled total.
  await expect(owner.getByText('Settlement')).toBeVisible();
  await expect(owner.getByText('Pooled order total: ₹7500.00')).toBeVisible();
  await expect(owner.getByText('₹5000.00')).toBeVisible();
  await expect(owner.getByText('₹2500.00')).toBeVisible();
  const totalPaise = store.settlements.reduce((s, r) => s + r.amount_paise, 0);
  expect(totalPaise).toBe(750000);
  expect(store.settlements).toHaveLength(2);

  await sellerCtx.close();
  await ownerCtx.close();
  await joinerCtx.close();
});
