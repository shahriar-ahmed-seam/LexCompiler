import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Server tests run in Node; UI tests (src/**/*.test.tsx) opt into jsdom with a
    // `// @vitest-environment jsdom` comment.
    environment: 'node',
    testTimeout: 30000,
    // Many tests start Python, Z3 and PGlite. One worker per core oversubscribes the CPU on
    // machines with many cores (12 on a laptop ran heavy tests past the timeout); 4 is also what
    // GitHub's runners have, and the suite finishes sooner than with 11 workers.
    maxWorkers: 4,
    include: ['server/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['server/test-setup.ts'],
    // Builds a real compliance report (Z3 included) once, in a child process, for the UI tests.
    globalSetup: ['src/test/globalSetup.ts'],
  },
});
