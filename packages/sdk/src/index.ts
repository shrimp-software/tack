import { Tack as TackInstance } from "./client.js";
import type { TackOptions, TackToolsFor } from "./types.js";

/** An instance follows the selected tool tree, defaulting to the default config's
 * binding (dynamic when unregistered). Constructor selectors are not its identity. */
export type Tack<Options extends TackOptions | undefined = undefined> = TackInstance<TackToolsFor<Options>>;

/** Direct live client; infer project tool types without user-supplied generics. */
export const Tack: {
  // Keep no-argument construction separate from direct supplied-options inference.
  new<const Options extends TackOptions | undefined = undefined>(...args: undefined extends Options ? [] : never): Tack<Options>;
  new<const Options extends TackOptions | undefined>(options: Options): Tack<Options>;
} = TackInstance;

export { TackError, type TackErrorCode } from "./errors.js";
export type * from "./types.js";
