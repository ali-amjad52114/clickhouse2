import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
        proxy: {
      '/api': {
        target: `http://localhost:${process.env.API_PORT || 8797}`,
        changeOrigin: true,
      },
    },
  },
});
