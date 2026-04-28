/**
 * 前端构建配置
 * 将 Koishi 控制台扩展入口打包到 dist 目录
 */
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import unocss from 'unocss/vite'
import mini from 'unocss/preset-mini'
import yaml from './vite-yaml'

export default defineConfig({
  build: {
    lib: {
      entry: 'client/index.ts',
      formats: ['es'],
      fileName: 'index',
    },
    outDir: 'dist',
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: {
      external: [
        'vue',
        'vue-router',
        '@vueuse/core',
        '@koishijs/client',
        '@koishijs/plugin-config',
      ],
      output: {
        format: 'es',
        entryFileNames: '[name].js',
        assetFileNames: 'style.css',
      },
    },
  },
  plugins: [
    vue(),
    yaml(),
    unocss({
      presets: [
        mini({
          preflight: false,
        }),
      ],
    }),
  ],
  css: {
    preprocessorOptions: {
      scss: {
        api: 'modern-compiler',
      },
    },
  },
  resolve: {
    alias: {
      'vue-i18n': '@koishijs/client',
      '@koishijs/components': '@koishijs/client',
    },
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
})
