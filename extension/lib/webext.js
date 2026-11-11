// Cross-browser WebExtension namespace fallback.
//
// Chrome / Edge / Safari expose `chrome`. Firefox exposes `browser` (Promise
// based) and, since Firefox 101, a `chrome` compatibility alias that honours
// both callback and Promise styles. The rest of the codebase deliberately
// stays on `chrome.*` because Safari's Web Extension shim implements only that
// namespace; this module merely guarantees the namespace exists in every
// extension context, so a Firefox build without the alias still boots.
//
// Import for its side effect from each extension entry point, before any other
// module is evaluated.

const fallback = globalThis.browser?.runtime;
if (!globalThis.chrome && fallback?.id) globalThis.chrome = globalThis.browser;

export const webext = globalThis.chrome;
export default webext;
