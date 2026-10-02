import { defineConfig } from "tsdown"

export default defineConfig({
  entry: { fastboot: "src/index.ts" },
  format: "esm",
  platform: "browser",
  target: "chrome132",
  dts: true,
  sourcemap: true,
  clean: true,
})
