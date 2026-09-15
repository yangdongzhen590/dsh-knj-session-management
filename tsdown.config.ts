/**
 * Browser client bundle for the dsh-knj-session-management plugin, mirroring the
 * DeepSeek Harness client preset: a closure-factory artifact that calls
 * window.__ModuleLoader__.load({ id, factory }) and resolves externals
 * through the injected require (loader module table).
 */
import { defineConfig } from 'tsdown'

const id = 'dsh-knj-session-management'

/**
 * 构建标记（见 src/client/build-info.ts，面板显示在提示行末尾）。
 * client bundle 是页面加载时取的，改了 bundle 必须刷新页面才生效；有标记才能一眼判断
 * 当前界面是哪一版产物，而不是在"代码没写对"和"页面没刷新"之间猜。
 */
const buildStamp = new Date().toLocaleString('sv-SE').slice(0, 16)

/** Externals resolved from the loader module table at runtime. */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  '@deepseek-ai/dsh-client-ui-primitives',
]

export default defineConfig({
  entry: { client: 'src/client/index.ts' },
  outDir: 'client',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: [...CLIENT_EXTERNALS],
    alwaysBundle: (source: string) => (CLIENT_EXTERNALS.includes(source) ? undefined : true),
  },
  define: {
    __KNJ_SM_BUILD__: JSON.stringify(buildStamp),
    'process.env.NODE_ENV': JSON.stringify('production'),
    'import.meta.env.MODE': JSON.stringify('production'),
    'import.meta.env': JSON.stringify({ MODE: 'production' }),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
