import { defineConfig, type Plugin } from 'vite-plus';

/**
 * Vite plugin to handle Bun-style `import x from '...' with { type: 'text' }`.
 * Rolldown resolves these to the actual file path; we intercept based on .md/.yml extensions
 * when they appear in the module graph.
 */
function bunTextImportPlugin(): Plugin {
  return {
    name: 'bun-text-import',
    enforce: 'pre',
    transform(code, id) {
      if (id.endsWith('.md') || id.endsWith('.yml') || id.endsWith('.yaml')) {
        return {
          code: `export default ${JSON.stringify(code)};`,
          map: null,
        };
      }
    },
  };
}

export default defineConfig({
  fmt: {
    singleQuote: true,
    semi: true,
    trailingComma: 'all',
    tabWidth: 2,
    printWidth: 120,
    sortPackageJson: false,
    ignorePatterns: ['dist/', 'node_modules/', 'pnpm-lock.yaml', 'CHANGELOG.md'],
  },
  lint: {
    ignorePatterns: ['tests/fixtures/**'],
    options: {
      typeAware: false,
      typeCheck: false,
    },
    rules: {
      'no-unused-expressions': 'off',
      'no-control-regex': 'off',
    },
  },
  plugins: [bunTextImportPlugin()],
  test: {
    globals: true,
    environment: 'node',
    // Workers run under Bun (forks spawn via process.execPath = bun), giving
    // specs a native `Bun` global. `threads` is unreliable under Bun — keep forks.
    pool: 'forks',
    include: ['src/__tests__/**/*.spec.ts', 'test/e2e/**/*.e2e.spec.ts'],
    setupFiles: ['./src/__tests__/setup-mocks.ts'],
    restoreMocks: true,
    // `bun:*` builtins (bun:sqlite, etc.) aren't resolvable by Vite's bundler.
    // Externalize them so the Bun worker resolves them natively at runtime.
    server: { deps: { external: [/^bun:/] } },
  },
  build: {
    target: 'node22',
    outDir: 'dist',
    lib: {
      entry: './src/index.ts',
      formats: ['es'],
      fileName: 'index',
    },
    rollupOptions: {
      external: /^[^./]/,
    },
    assetsDir: '',
    copyPublicDir: false,
  },
});
