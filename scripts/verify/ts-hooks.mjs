const CANDIDATES = ['.ts', '.tsx', '/index.ts', '/index.tsx', '.mjs', '.js'];

export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (err) {
    if (err?.code !== 'ERR_MODULE_NOT_FOUND' && err?.code !== 'ERR_UNSUPPORTED_DIR_IMPORT') throw err;
    const relative = specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('file:');
    if (!relative) throw err;
    for (const ext of CANDIDATES) {
      try { return await next(specifier + ext, context); } catch { /* try next */ }
    }
    throw err;
  }
}

export async function load(url, context, next) {
  // CSS imports from renderer code are irrelevant in Node.
  if (url.endsWith('.css')) return { format: 'module', source: 'export default {};', shortCircuit: true };
  return next(url, context);
}
