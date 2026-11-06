import { enterScratchFixtureCopy } from './cli/scratchFixture.js';

// Each test file works on its own copy of the demo fixture, never on target-repo/ itself.
enterScratchFixtureCopy('test');

// Tests never depend on a model running on the developer's machine: RAG uses feature hashing
// and the Ollama endpoint refuses connections, unless a test points these at a fake server.
process.env.LEXCOMPILER_EMBEDDING_MODEL = 'none';
process.env.OLLAMA_HOST = 'http://127.0.0.1:9';
// Nor on the network: the regulatory feed serves its offline items (feed tests pass their own fetch).
process.env.LEXCOMPILER_REGULATORY_FEED = 'offline';
