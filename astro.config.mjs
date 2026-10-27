import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://bus.wanyc.xyz',
  output: 'static',
  build: { format: 'directory' },
});
