/**
 * Test runner. Plain Node, no framework — these are numerical checks on pure
 * functions, and a dependency-free repo is one less thing to break a deploy.
 */

const suites = [
  './trace.test.mjs',
  './metrics.test.mjs',
  './fontbuild.test.mjs',
  './draw.test.mjs',
  './ratelimit.test.mjs',
  './middleware.test.mjs',
  './docsearch.test.mjs',
  './eta.test.mjs',
  './routes.test.mjs',
  './leaving.test.mjs',
  './browsergate.test.mjs',
  './timings.test.mjs',
];

let total = 0;
let failed = 0;

for (const path of suites) {
  let mod;
  try {
    mod = await import(path);
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND') continue; // suite not written yet
    throw err;
  }
  if (typeof mod.run !== 'function') continue;
  const results = (await mod.run()) || [];
  total += results.length;
  failed += results.filter((r) => !r.pass).length;
}

console.log(`\n${total - failed}/${total} checks passed`);
if (failed) {
  console.log(`${failed} FAILED`);
  process.exitCode = 1;
}
