import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import fs from 'fs'

const stockfishSource = path.resolve(__dirname, 'node_modules/stockfish/bin')
const stockfishPublic = path.resolve(__dirname, 'public/stockfish')
fs.mkdirSync(stockfishPublic, { recursive: true })
for (const file of ['stockfish-19-lite-single.js', 'stockfish-19-lite-single.wasm']) {
  const source = path.join(stockfishSource, file)
  if (!fs.existsSync(source)) throw new Error('Missing Stockfish engine asset: ' + source)
  fs.copyFileSync(source, path.join(stockfishPublic, file))
}

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})

