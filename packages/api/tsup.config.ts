import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  outDir: 'dist',
  clean: true,
  target: 'es2022',
  // @inventory/shared ships raw TypeScript (no build step — Vite and tsx read it
  // directly in dev), so the production bundle has to inline it.
  noExternal: ['@inventory/shared'],
});
