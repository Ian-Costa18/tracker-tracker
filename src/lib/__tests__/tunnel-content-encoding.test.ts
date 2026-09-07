// src/lib/__tests__/tunnel-content-encoding.test.ts
import zlib from "node:zlib"
import { describe, expect, it } from "vitest"
import { decodeBody } from "@/lib/tunnel"

// fetch() unwraps compression; https.request hands back the compressed bytes and
// says nothing, so an adapter parses `1f 8b …` as HTML and blames the page. A
// server may compress a response nobody asked it to: IPTorrents returns gzip to
// a request carrying no Accept-Encoding.
describe("decodeBody", () => {
  const HTML = '<html><div class="stats">…</div></html>'

  it("passes an unencoded body through untouched", () => {
    const raw = Buffer.from(HTML, "utf8")
    expect(decodeBody(raw, undefined)).toBe(raw)
    expect(decodeBody(raw, "identity").toString()).toBe(HTML)
  })

  it("gunzips a gzip body", () => {
    expect(decodeBody(zlib.gzipSync(Buffer.from(HTML)), "gzip").toString()).toBe(HTML)
  })

  it("reads the header case-insensitively and ignores surrounding space", () => {
    expect(decodeBody(zlib.gzipSync(Buffer.from(HTML)), " GZIP ").toString()).toBe(HTML)
  })

  it("takes the first value when node hands back an array", () => {
    expect(decodeBody(zlib.gzipSync(Buffer.from(HTML)), ["gzip"]).toString()).toBe(HTML)
  })

  // Both shapes appear in the wild; which one arrived is only discoverable by trying.
  it("inflates a zlib-wrapped deflate body", () => {
    expect(decodeBody(zlib.deflateSync(Buffer.from(HTML)), "deflate").toString()).toBe(HTML)
  })

  it("inflates a raw deflate body", () => {
    expect(decodeBody(zlib.deflateRawSync(Buffer.from(HTML)), "deflate").toString()).toBe(HTML)
  })

  it("decompresses brotli", () => {
    expect(decodeBody(zlib.brotliCompressSync(Buffer.from(HTML)), "br").toString()).toBe(HTML)
  })

  // Returning the bytes would hand the caller something that only looks like a
  // parse failure, which is the bug this function exists to end.
  it("refuses an encoding it cannot decode rather than returning the bytes", () => {
    expect(() => decodeBody(Buffer.from(HTML), "zstd")).toThrow("Unsupported Content-Encoding")
  })

  it("reports a corrupt body as a decode failure", () => {
    expect(() => decodeBody(Buffer.from("not gzip at all"), "gzip")).toThrow("Could not decode gzip")
  })
})
