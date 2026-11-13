import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Tests must never touch the real network. Any test that needs fetch stubs it.
    restoreMocks: true,
  },
});
