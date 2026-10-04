import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import { resolve } from 'node:path'
import { existsSync, mkdirSync, copyFileSync } from 'node:fs'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    tailwindcss(),
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    {
      name: 'spa-routes-generator',
      closeBundle() {
        const distDir = resolve(import.meta.dirname, 'dist')
        const indexHtml = resolve(distDir, 'index.html')
        if (existsSync(indexHtml)) {
          // Generate /chat/index.html so static servers directly resolve /chat
          const chatDir = resolve(distDir, 'chat')
          if (!existsSync(chatDir)) mkdirSync(chatDir, { recursive: true })
          copyFileSync(indexHtml, resolve(chatDir, 'index.html'))

          // Generate 404.html for GitHub Pages and static host SPA fallbacks
          copyFileSync(indexHtml, resolve(distDir, '404.html'))
        }
      },
    },
  ],
  appType: 'spa',
})
