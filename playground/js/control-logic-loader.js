/**
 * ESM adapter for the Shelly control-logic.js (ES5).
 *
 * Loads the real Shelly control logic at runtime so the simulator
 * always runs the exact same decision code as the deployed hardware.
 * The ES5 source uses `var` / `function` declarations and a guarded
 * `module.exports` block that is harmless in the browser.
 */

let _module;

async function load() {
  if (_module) return _module;
  const resp = await fetch('shelly/control-logic.js');
  const src = await resp.text();

  // Provide a `module` shim so the CommonJS export block works
  const module = { exports: {} };
  // eslint-disable-next-line no-new-func
  const fn = new Function('module', src);
  fn(module);

  _module = module.exports;
  return _module;
}

export { load };
