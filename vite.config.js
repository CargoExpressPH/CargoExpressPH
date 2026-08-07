import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'

// Stamps a unique build version into sw.js so browsers detect new deploys,
// and injects the list of hashed entry assets so the service worker can
// precache a bootable app shell during install (not lazily on first fetch).
function swVersionPlugin() {
  let precacheAssets = []

  return {
    name: 'sw-version-stamp',

    // Walk the entry chunk's STATIC import graph. Route chunks reached only via
    // dynamic import (lazyWithRetry) are deliberately excluded — precaching all
    // 77 chunks would pull ~3 MB, including the 985 KB html2pdf bundle that most
    // sessions never touch. Static imports alone boot the real UI offline.
    generateBundle(_options, bundle) {
      const collected = new Set()

      const visit = (fileName) => {
        if (collected.has(fileName)) return
        const chunk = bundle[fileName]
        if (!chunk) return
        collected.add(fileName)

        // CSS Vite emitted for this chunk
        for (const css of chunk.viteMetadata?.importedCss || []) collected.add(css)
        // Static imports only — chunk.dynamicImports is intentionally ignored
        for (const imported of chunk.imports || []) visit(imported)
      }

      for (const chunk of Object.values(bundle)) {
        if (chunk.type === 'chunk' && chunk.isEntry) visit(chunk.fileName)
      }

      precacheAssets = [...collected].map((file) => `/${file}`)
    },

    closeBundle() {
      const swPath = resolve('dist', 'sw.js')
      try {
        const version = `v${Date.now()}`
        let content = readFileSync(swPath, 'utf-8')

        content = content.replace('__BUILD_VERSION__', version)
        // Replaced as a JSON *string* so sw.js can JSON.parse it — in dev the
        // placeholder stays a plain string and parses to an empty list.
        content = content.replace(
          "'__PRECACHE_ASSETS__'",
          JSON.stringify(JSON.stringify(precacheAssets)),
        )

        writeFileSync(swPath, content, 'utf-8')
        console.log(`[sw-version] Stamped ${version} into sw.js`)
        console.log(`[sw-precache] Injected ${precacheAssets.length} entry assets:`)
        for (const asset of precacheAssets) console.log(`             ${asset}`)
      } catch { /* sw.js not in dist — dev mode, skip */ }
    },
  }
}

// Automatically rewrites lucide-react barrel imports into direct ESM per-icon imports
function lucideTreeShakePlugin() {
  function toKebab(str) {
    return str
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .replace(/([a-zA-Z])([0-9])/g, '$1-$2')
      .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
      .toLowerCase()
  }

  return {
    name: 'lucide-treeshake-plugin',
    transform(code, id) {
      if (!id.endsWith('.js') && !id.endsWith('.jsx') && !id.endsWith('.tsx') && !id.endsWith('.ts')) return null
      if (!code.includes('lucide-react')) return null

      const regex = /import\s*\{([^}]+)\}\s*from\s*['"]lucide-react['"]/g
      let hasMatch = false
      const transformed = code.replace(regex, (_, specifiers) => {
        hasMatch = true
        return specifiers
          .split(',')
          .map(s => s.trim())
          .filter(Boolean)
          .map(spec => {
            const parts = spec.split(/\s+as\s+/)
            const name = parts[0].trim()
            const alias = parts[1] ? parts[1].trim() : name
            const kebab = toKebab(name)
            return `import ${alias} from 'lucide-react/dist/esm/icons/${kebab}.mjs'`
          })
          .join(';\n') + ';'
      })

      return hasMatch ? { code: transformed, map: null } : null
    },
  }
}

export default defineConfig({
  plugins: [lucideTreeShakePlugin(), react(), swVersionPlugin()],
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
        },
      },
    },
  },
})
