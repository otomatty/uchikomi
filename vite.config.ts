import { defineConfig } from 'vite';
export default defineConfig({base:'./',build:{outDir:'dist',emptyOutDir:true,rollupOptions:{input:{app:'index.html',sidepanel:'sidepanel.html',offscreen:'offscreen.html'}},target:'es2022'},server:{port:5173,strictPort:true}});
