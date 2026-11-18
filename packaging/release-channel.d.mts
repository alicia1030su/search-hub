export interface ReleaseChannel {
  channel: "stable" | "prerelease";
  prerelease: boolean;
  version: string;
  name: string;
  major: number;
  minor: number;
  patch: number;
  pre: string | null;
}

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  pre: string | null;
}

export declare function classifyTag(rawTag: string): ReleaseChannel;
export declare function parseVersion(value: string): ParsedVersion | null;
export declare function compareVersions(a: ParsedVersion, b: ParsedVersion): number;
