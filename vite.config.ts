import { defineConfig } from 'vite';

export default defineConfig({
  base:'./',
  build:{
    outDir:'dist', emptyOutDir:true, target:'es2022',
    rollupOptions:{
      input:{app:'index.html',sidepanel:'sidepanel.html',offscreen:'offscreen.html'},
      // Only the plain-text parser is used. Its package entry also re-exports
      // an HTML formatter whose optional Node DOM would otherwise be bundled.
      treeshake:{moduleSideEffects:id=>!id.endsWith('/budoux/module/html_processor.js')},
    },
  },
  server:{port:5173,strictPort:true},
});
