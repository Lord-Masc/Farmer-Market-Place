'use strict';
// SMS delivery adapter (Stage 9, module H) — interface + httpSMS stub.
//
// NO DELIVERY PROVIDER IS ASSUMED. httpSMS is the ready hook (its key
// is a known pending item on Rishabh's side — see the roadmap Stage 9
// notes) but it is NOT wired: there is no httpSMS key in this
// codebase, no httpSMS SDK dependency, and this stub makes no network
// call. Until he supplies a key through the normal env-var flow, every
// SMS send fails closed with PROVIDER_NOT_CONFIGURED — never a fake
// "sent". Wiring the real adapter means: read the key once, call the
// httpSMS HTTP API, and return { ok: true } only on a real provider
// acceptance — none of that exists here on purpose.
//
// The single adapter interface every SMS provider must satisfy:
//   isConfigured() -> boolean
//   send({ notification, to }) -> { ok: boolean, code?: string }
// `notification` is the notifications row (id, type, title, body,
// payload); `to` is the recipient's phone number from profiles.

class HttpSmsStubAdapter {
  constructor() {
    this.name = 'httpsms-stub';
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
const adapter = new HttpSmsStubAdapter();

function getSmsAdapter() {
  return adapter;
}

module.exports = adapter;
module.exports.HttpSmsStubAdapter = HttpSmsStubAdapter;
module.exports.getSmsAdapter = getSmsAdapter;
