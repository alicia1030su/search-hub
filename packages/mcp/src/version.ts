import rootPackage from "../../../package.json";

declare const __SHUB_VERSION__: string | undefined;

/** MCP package version, injected at build time with the root manifest fallback. */
export const MCP_VERSION =
  typeof __SHUB_VERSION__ === "string" && __SHUB_VERSION__.length > 0
    ? __SHUB_VERSION__
    : rootPackage.version;
