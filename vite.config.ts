import { defineConfig } from 'vite';

export default defineConfig({
  server: { host: true, port: 5173 },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        // Three.js 单独成 chunk：主业务包变小，浏览器可并行加载与长期缓存
        manualChunks: { three: ['three'] },
      },
    },
  },
});
