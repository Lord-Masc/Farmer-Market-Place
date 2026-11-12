// Playwright config for the Stage 11 regression happy paths.
//
// The specs run against the LOCAL vite dev server. All env values here
// are DUMMY: the app is pointed at https://mock.supabase.co (answered by
// the route-interception mock in ./mock.js — no real Supabase project,
// no real anon key) and at a mock escrow API origin that is likewise
// intercepted. The Razorpay key is a dummy: Checkout is stubbed with
// window.Razorpay and no gateway script is ever loaded. Nothing in this
// run touches production Supabase, Razorpay, or any live endpoint.
//
// Run from the repo root: npx playwright test --config tests/e2e/playwright.config.js
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  timeout: 60 * 1000,
  expect: { timeout: 10 * 1000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
  },
  webServer: {
    // cwd defaults to the config file's directory (tests/e2e/) — vite
    // must run from the repo root or it serves the wrong directory.
    cwd: new URL('../..', import.meta.url).pathname,
    command: './node_modules/.bin/vite --host 127.0.0.1 --port 5173',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: false,
    timeout: 60 * 1000,
    env: {
      VITE_SUPABASE_URL: 'https://mock.supabase.co',
      VITE_SUPABASE_ANON_KEY: 'mock-anon-key-not-a-real-secret',
      VITE_ESCROW_API_URL: 'http://127.0.0.1:5001',
      VITE_RAZORPAY_KEY_ID: 'rzp_test_mock',
    },
  },
});
