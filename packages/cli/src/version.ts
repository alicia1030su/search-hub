declare const __SHUB_VERSION__: string | undefined;

/** Kept in sync with package.json by the CLI build and the version unit test. */
export const CLI_VERSION =
  typeof __SHUB_VERSION__ === "string" && __SHUB_VERSION__.length > 0
    ? __SHUB_VERSION__
    : "0.1.15";
