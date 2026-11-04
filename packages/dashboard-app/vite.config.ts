import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({ plugins: [react()], base: '/console/dashboard/', build: { outDir: 'dist/console/dashboard' }, test: { environment: 'node' } });
