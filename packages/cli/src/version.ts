import rootPackage from "../../../package.json";

declare const __SHUB_VERSION__: string | undefined;

/**
 * CLI version injected by the standalone build, with the root release manifest
 * as the source-tree fallback. Workspace manifests are alignment-checked.
 */
export const CLI_VERSION =
  typeof __SHUB_VERSION__ === "string" && __SHUB_VERSION__.length > 0
    ? __SHUB_VERSION__
    : rootPackage.version;
