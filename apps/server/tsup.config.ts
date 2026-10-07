import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  sourcemap: true,
  clean: true,
  // Workspace packages are TypeScript sources; bundle them. npm packages stay in node_modules.
  noExternal: [/^@autoflow\//],
  // node:sqlite only exists with the "node:" prefix, which the bundler would otherwise strip.
  external: ['node:sqlite'],
  removeNodeProtocol: false,
});
