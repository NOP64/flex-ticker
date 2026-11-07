import commonjs from "@rollup/plugin-commonjs";
import nodeResolve from "@rollup/plugin-node-resolve";
import terser from "@rollup/plugin-terser";
import path from "node:path";
import url from "node:url";
import json from '@rollup/plugin-json';
import { glob } from 'glob'
const isWatching = !!process.env.ROLLUP_WATCH;
const flexPlugin = "com.nop64.flexticker.plugin";

/**
 * @type {import('rollup').RollupOptions}
 */
const config = {
  input: "src/plugin.js",
  output: {
    file: `${flexPlugin}/backend/plugin.cjs`,
    format: "cjs",
    sourcemap: isWatching,
    sourcemapPathTransform: (relativeSourcePath, sourcemapPath) => {
      return url.pathToFileURL(path.resolve(path.dirname(sourcemapPath), relativeSourcePath)).href;
    },
  },
  plugins: [
    json(),
    {
      name: "watch-externals",
      buildStart: function () {
        this.addWatchFile(`${flexPlugin}/manifest.json`);
        const vueFiles = glob.sync(`${flexPlugin}/ui/*.vue`);
        vueFiles.forEach((file) => {
          this.addWatchFile(file);
        });
      },
    },
    nodeResolve({
      browser: false,
      exportConditions: ["node"],
      preferBuiltins: true
    }),
    commonjs(),
    !isWatching && terser(),
    {
      name: "emit-module-package-file",
      generateBundle() {
        // Native modules stay external and are installed into backend/ after build.
        const pkg = { name: "plugin-backend", private: true, dependencies: { "@napi-rs/canvas": "1.1.0", "@napi-rs/keyring": "2.1.2" } };
        this.emitFile({ fileName: "package.json", source: JSON.stringify(pkg, null, 2), type: "asset" });
      }
    }
  ],
  external: ['@napi-rs/canvas', '@napi-rs/keyring', /^node:/, /\.node$/]
};

export default config;
