import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          // The Workspace Host runs as a separate utility process, one per project.
          host: resolve(__dirname, 'src/host/index.ts')
        }
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: {
        // y-monaco imports Monaco by a path that monaco-editor 0.57's package exports no longer
        // allow. Point it at the same file the main 'monaco-editor' import uses.
        'monaco-editor/esm/vs/editor/editor.api.js': resolve(__dirname, 'node_modules/monaco-editor/esm/vs/editor/editor.api.js')
      }
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') }
      }
    }
  }
})
