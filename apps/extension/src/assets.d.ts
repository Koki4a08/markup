/** Font files are bundled as raw bytes (esbuild `binary` loader in build.mjs). */
declare module '*.woff2' {
  const bytes: Uint8Array<ArrayBuffer>;
  export default bytes;
}
