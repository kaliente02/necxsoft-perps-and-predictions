import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  // Served from necxsoft.com/perps-and-predictions/ in production (see `npm run build:web`).
  base: process.env.BASE_PATH ?? '/',
  // The Codama-generated client reads process.env.NODE_ENV for error messages.
  define: { 'process.env': { NODE_ENV: mode === 'production' ? 'production' : 'development' } },
}));
