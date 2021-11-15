import esbuild from 'esbuild';
import { WEB_WORKER } from './plugins/worker';
import { copyFile, rm } from 'fs/promises';

(async () => {
  const ESBUILD_OPTS: esbuild.BuildOptions = {
    target: ['es2018'],
    platform: 'browser',
    outdir: 'dist/play',

    mainFields: ['esbuild', 'browser', 'module', 'main'],

    assetNames: '[name]',
    entryNames: '[name].min',

    bundle: true,
    minify: true,
    color: true,
    format: 'esm',
    sourcemap: true,
    splitting: true,
    keepNames: true,

    loader: {
      '.ttf': 'file',
      '.wasm': 'file',
    },

    inject: ['./scripts/shims/node.js'],

    plugins: [WEB_WORKER()],
  };

  try {
    await rm('dist', { recursive: true });
  } catch (e) {}

  await esbuild.build({
    ...ESBUILD_OPTS,
    entryPoints: ['src/internal/index.ts'],
    outdir: undefined,
    splitting: false,
    outfile: 'dist/internal/index.js',
  });

  await esbuild.build({
    ...ESBUILD_OPTS,
    entryPoints: ['src/internal/compiler.ts'],
    outdir: undefined,
    splitting: false,
    outfile: 'dist/internal/compiler.js',
    format: 'iife',
    globalName: 'astroCompiler',
  });

  copyFile('src/internal/package.json', 'dist/internal/package.json');
})();
