// Minimal type for the one node:crypto function api/ uses. @types/node is not installed for api/
// (no package.json here on purpose), and .d.ts files are never deployed as functions.
declare module 'node:crypto' {
  export function timingSafeEqual(a: ArrayBufferView, b: ArrayBufferView): boolean
}
