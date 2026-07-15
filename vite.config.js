import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'

// Stamps a unique build version into sw.js so browsers detect new deploys
function swVersionPlugin() {
  return {
    name: 'sw-version-stamp',
    closeBundle() {
      const swPath = resolve('dist', 'sw.js')
      try {
        const version = `v${Date.now()}`
        let content = readFileSync(swPath, 'utf-8')
        content = content.replace('__BUILD_VERSION__', version)
        writeFileSync(swPath, content, 'utf-8')
        console.log(`[sw-version] Stamped ${version} into sw.js`)
      } catch { /* sw.js not in dist — dev mode, skip */ }
    },
  }
}

export default defineConfig({
  plugins: [react(), swVersionPlugin()],
  server: {
    port: 5173,
    open: true,
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          // React core — cached across all pages
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          // Supabase client — large dependency, rarely changes
          'vendor-supabase': ['@supabase/supabase-js'],
          // Lucide icons — shared across all pages
          'vendor-icons': ['lucide-react'],
        },
      },
    },
  },
})
