import { defineConfig, normalizePath } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { viteStaticCopy } from 'vite-plugin-static-copy';

export default defineConfig({
  resolve: {
    alias: {
      fs: fileURLToPath(new URL('./src/workers/node-shims/fs.ts', import.meta.url)),
      zlib: fileURLToPath(new URL('./src/workers/node-shims/zlib.ts', import.meta.url)),
      path: fileURLToPath(new URL('./src/workers/node-shims/path.ts', import.meta.url)),
      url: fileURLToPath(new URL('./src/workers/node-shims/url.ts', import.meta.url)),
    },
  },
  plugins: [
    react(),
    viteStaticCopy({
      targets: [
        {
          src: normalizePath(
            fileURLToPath(
            new URL(
              './node_modules/@mapbox/mapbox-gl-rtl-text/dist/mapbox-gl-rtl-text.js',
              import.meta.url,
            ),
            ),
          ),
          dest: 'assets',
          rename: { stripBase: true },
        },
      ],
    }),
  ],

  server: {
    watch: {
      ignored: [
        '**/src-tauri/target/**',
        '**/.git/**',
      ],
    },
  },
});
