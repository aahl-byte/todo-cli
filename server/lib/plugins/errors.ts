// What the plugin store refuses, and how the API answers each.

/** The change itself is wrong; the API answers 400. */
export class PluginInputError extends Error {
  constructor(msg: string, readonly errors: string[] = [msg]) {
    super(msg);
  }
}

/** The change was made against something that has changed since; the API answers 409. */
export class PluginConflict extends Error {}
