import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from '@earendil-works/pi-ai';
import * as piTui from '@earendil-works/pi-tui';
import * as piAgent from '@earendil-works/pi-coding-agent';
import install from './extension.mjs';

/**
 * The `/gate` panel draws with host terminal components, so the host modules have to be
 * imported **statically, here at the entry point**, and handed to the extension.
 *
 * This is not a style preference — it is the only way that resolves. pi loads
 * extensions through jiti with a map of host modules, and that map applies to **static**
 * imports (`pi-coding-agent/dist/core/extensions/loader.js:55-79`,
 * `virtual-modules.js:21,31`). A dynamic `await import('@earendil-works/pi-tui')` from
 * inside an extension falls through to Node's native resolver and dies with
 * `ERR_MODULE_NOT_FOUND` — same for `@earendil-works/pi-ai`. Verified against the
 * installed 1.1.0 by `scripts/smoke-panel.mjs`.
 *
 * `node --test` never loads this file: the suite imports `extension.mjs` / `menu.mjs`
 * directly and injects doubles through the `host` seam, so the tested modules stay free
 * of the host — which was the real point of the old "lazy import" rule.
 */
export default function (pi: ExtensionAPI) {
  install(pi, Type, { tui: piTui, agent: piAgent });
}
