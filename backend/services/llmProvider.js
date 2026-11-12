'use strict';
// LLM provider adapter (Stage 8, module G) — interface + Groq stub.
//
// The provider choice is a HUMAN decision (Rishabh): which provider,
// which model, which key, and whether the assistant may ever call an
// LLM at all. Until he decides and supplies a key, there is NO
// provider — this stub is the only adapter, and it fails closed.
//
// The structured core pipeline (assistantService) NEVER calls this
// adapter: answers are built from the platform's own data with
// templates, never generated. This file exists so that, if Rishabh
// later wants free-text help (e.g. drafting a message), the wiring
// point is one adapter — not a new dependency scattered through the
// service layer.
//
// The stub makes NO network call, imports NO SDK (no new dependency),
// and reads NO credential: there is no key to read. Wiring a real
// Groq adapter means: a human supplies the key through the normal
// env-var flow, the adapter reads it once, and generate() calls the
// Groq API — none of that exists here on purpose.
const { AppError } = require('../utils/errors');

function notConfigured() {
  return new AppError(
    503,
    'LLM_NOT_CONFIGURED',
    'No AI provider is configured. Ask Rishabh to choose a provider and supply a key.',
  );
}

// The single adapter interface every provider must satisfy.
class GroqStubProvider {
  constructor() {
    this.name = 'groq-stub';
  }

  isConfigured() {
    return false;
  }

  // Never returns a fabricated answer — rejects, always.
  async generate(/* prompt */) {
    throw notConfigured();
  }
}

// One provider for the whole process. Today that is always the stub.
function getLlmProvider() {
  return new GroqStubProvider();
}

module.exports = { getLlmProvider, GroqStubProvider };
