import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'

const { version: appVersion } = JSON.parse(
  readFileSync(resolve('package.json'), 'utf-8'),
)

// Stamps a unique build version into sw.js so browsers detect new deploys,
// and injects the list of hashed entry assets so the service worker can
// precache a bootable app shell during install (not lazily on first fetch).
function swVersionPlugin() {
  let precacheAssets = []

  return {
    name: 'sw-version-stamp',

    // Cache every emitted JS/CSS chunk. The app has many lazy routes, and a
    // cached entry bundle alone cannot render a route whose chunk was never
    // visited. A complete code cache is intentionally a few MB: it makes every
    // installed-PWA screen bootable after a successful update. Live data still
    // remains network-dependent and is handled by each screen's offline state.
    generateBundle(_options, bundle) {
      const collected = new Set()

      const visit = (fileName) => {
        if (collected.has(fileName)) return
        const chunk = bundle[fileName]
        if (!chunk) return
        collected.add(fileName)

        // CSS Vite emitted for this chunk
        for (const css of chunk.viteMetadata?.importedCss || []) collected.add(css)
        // Static imports are visited for completeness; dynamic chunks are
        // collected by the outer bundle walk below.
        for (const imported of chunk.imports || []) visit(imported)
      }

      for (const chunk of Object.values(bundle)) {
        if (chunk.type === 'chunk') visit(chunk.fileName)
        if (chunk.type === 'asset' && chunk.fileName.endsWith('.css')) {
          collected.add(chunk.fileName)
        }
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
        console.log(`[sw-precache] Injected ${precacheAssets.length} app assets:`)
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
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(appVersion),
  },
  plugins: [lucideTreeShakePlugin(), react(), swVersionPlugin()],
  server: {
    port: 5173,
    open: true,
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('react') || id.includes('react-dom') || id.includes('react-router-dom')) {
              return 'vendor-react';
            }
            if (id.includes('@supabase')) {
              return 'vendor-supabase';
            }
            if (id.includes('firebase')) {
              return 'vendor-firebase';
            }
            if (id.includes('framer-motion')) {
              return 'vendor-motion';
            }
            if (id.includes('@dnd-kit')) {
              return 'vendor-dndkit';
            }
            if (id.includes('html2pdf.js') || id.includes('jspdf') || id.includes('html2canvas')) {
              return 'vendor-pdf';
            }
            if (id.includes('browser-image-compression')) {
              return 'vendor-image';
            }
          }
        },
      },
    },
  },
})
