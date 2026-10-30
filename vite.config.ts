import { readFileSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Ships the licences of the bundled @fontsource fonts (SIL OFL) next to the
// app as /third-party-licenses.txt.
function fontLicenses(): Plugin {
  const read = (path: string) =>
    readFileSync(new URL(path, import.meta.url), 'utf8')
  return {
    name: 'font-licenses',
    apply: 'build',
    generateBundle() {
      const { dependencies } = JSON.parse(read('./package.json'))
      const notices = Object.keys(dependencies)
        .filter((name) => name.startsWith('@fontsource'))
        .map((name) => {
          const dir = `./node_modules/${name}/`
          const { version, license } = JSON.parse(read(`${dir}package.json`))
          return `${name} ${version} (${license})\n\n${read(`${dir}LICENSE`).trim()}\n`
        })
      if (!notices.length) this.error('no @fontsource dependencies found')
      this.emitFile({
        type: 'asset',
        fileName: 'third-party-licenses.txt',
        source: [
          'Fonts bundled with this app, and their licences.\n',
          ...notices,
        ].join(`\n${'='.repeat(72)}\n\n`),
      })
    },
  }
}

export default defineConfig({
  plugins: [tailwindcss(), react(), fontLicenses()],
  server: {
    port: Number(process.env.LLM_WIKI_DEV_PORT ?? 3102),
    strictPort: true,
    proxy: {
      '/api': process.env.LLM_WIKI_API_URL ?? 'http://127.0.0.1:3002',
      '/auth': process.env.LLM_WIKI_API_URL ?? 'http://127.0.0.1:3002',
    },
  },
  build: { chunkSizeWarningLimit: 900 },
})
