/**
 * Types for `libheif-js`, which ships none.
 *
 * Only what `heicToJpeg` in lib/media.ts actually calls is declared, and it is
 * declared honestly rather than as `any`: the whole reason this module is here
 * is to turn an iPhone photo into pixels, and a wrong assumption about the
 * shape of `display` would be a silent black image rather than a type error.
 *
 * The `.js` in the specifier is not optional — the package has no `exports`
 * map, so NodeNext resolution needs the real filename, and `HeifDecoder` hangs
 * off the CommonJS default export rather than being a detected named one.
 */
declare module 'libheif-js/wasm-bundle.js' {
  /** One image inside a HEIF container. An iPhone photo has exactly one. */
  export interface HeifImage {
    get_width(): number
    get_height(): number
    /**
     * Renders into `image.data` as RGBA, then calls back.
     *
     * The callback receives the same object on success and `null` on failure —
     * it does NOT throw, which is why the caller wraps it in a promise that
     * rejects rather than letting a failure read as a blank photo.
     */
    display(
      image: { data: Buffer; width: number; height: number },
      callback: (result: { data: Buffer } | null) => void
    ): void
  }

  export class HeifDecoder {
    decode(buffer: Buffer): HeifImage[]
  }

  const libheif: { HeifDecoder: typeof HeifDecoder }
  export default libheif
}
