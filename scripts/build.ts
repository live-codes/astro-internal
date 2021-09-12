import esbuild from 'esbuild';
import path from 'path';
import { globby } from 'globby';
import { WEB_WORKER } from './plugins/worker';

const ESBUILD_OPTS: esbuild.BuildOptions = {
    target: ["es2018"],
    platform: "browser",
    outdir: "dist",

    mainFields: ['esbuild', 'browser', 'module', 'main'],

    assetNames: "[name]",
    entryNames: '[name].min',

    bundle: true,
    minify: true,
    color: true,
    format: "esm",
    sourcemap: true,
    splitting: true,
    keepNames: true,

    loader: {
        '.ttf': 'file',
        '.wasm': 'file'
    },

    inject: ["./scripts/shims/node.js"],

    plugins: [
        WEB_WORKER(),
    ]
};

async function build() {
    const isWatch = !!process.argv.find(arg => arg === '--watch');
    const entryPoints = await globby([
        `src/index.ts`,
        `src/editor/*.ts`,
        `src/@astro/*.ts`,
        `!src/editor/**/*.d.ts`
    ], { absolute: true })

    entryPoints.push(path.resolve(`node_modules/esbuild-wasm/esbuild.wasm`));
    await esbuild.build({
        ...ESBUILD_OPTS,
        entryPoints,
        watch: isWatch,
    });

    await esbuild.build({ 
        ...ESBUILD_OPTS,
        entryPoints: [
            "src/@astro/internal/index.ts"
        ],
        outdir: undefined,
        splitting: false,
        outfile: "dist/@astro/internal.js",
    });

    // for (const err of result.errors) {
    //     console.error(err);
    // }

    // for (const warn of result.warnings) {
    //     console.warn(warn);
    // }
}


// Run the build
build();
