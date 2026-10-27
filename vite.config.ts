import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { remotePlugin } from './tools/remote-plugin.ts';

// `npm run dev` : http://localhost:5173 (WebGPU accepte localhost).
// `npm run dev:phone` : HTTPS auto-signé sur le réseau local (SPLATCAM_HTTPS=1, --host) pour le téléphone.
export default defineConfig({
  plugins: [remotePlugin(), ...(process.env.SPLATCAM_HTTPS ? [basicSsl()] : [])],
  build: { rollupOptions: { input: { main: 'index.html', remote: 'remote.html' } } },
});
