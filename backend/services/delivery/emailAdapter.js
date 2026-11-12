'use strict';
// Email delivery adapter (Stage 9, module H) — interface + Brevo stub.
//
// NO DELIVERY PROVIDER IS ASSUMED. Brevo is the ready hook (the
// agency already uses Brevo; the provider choice is Rishabh's human
// decision) but it is NOT wired: there is no Brevo key in this
// codebase, no Brevo SDK dependency, and this stub makes no network
// call. Until he supplies a key through the normal env-var flow, every
// email send fails closed with PROVIDER_NOT_CONFIGURED — never a fake
// "sent". Wiring the real adapter means: read the key once, call the
// Brevo HTTP API, and return { ok: true } only on a real provider
// acceptance — none of that exists here on purpose.
//
// The single adapter interface every email provider must satisfy:
//   isConfigured() -> boolean
//   send({ notification, to }) -> { ok: boolean, code?: string }
// `notification` is the notifications row (id, type, title, body,
// payload); `to` is the recipient's email address from profiles.

class BrevoStubAdapter {
  constructor() {
    this.name = 'brevo-stub';
  }

  isConfigured() {
    return false;
  }

  // Never claims a send — returns the honest failure, always.
  async send(/* { notification, to } */) {
    return { ok: false, code: 'PROVIDER_NOT_CONFIGURED' };
  }
}

// One adapter for the whole process. Today that is always the stub.
const adapter = new BrevoStubAdapter();

function getEmailAdapter() {
  return adapter;
}

module.exports = adapter;
module.exports.BrevoStubAdapter = BrevoStubAdapter;
module.exports.getEmailAdapter = getEmailAdapter;
