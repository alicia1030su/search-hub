export interface ParsedSystemdUnit {
  env: Record<string, string>;
  workingDirectory: string;
  execStart: string[];
}

export interface ResolvedServiceConfig {
  dataDir: string;
  dbPath: string;
  port: number;
  unitName: string | null;
  unitPath: string | null;
  source: { dataDir: string; dbPath: string };
}

export function parseSystemdUnit(contents: string, baseDir?: string): ParsedSystemdUnit;
export function resolveServiceConfig(options?: {
  root: string;
  dataDirArg?: string;
  dbPathArg?: string;
  portArg?: string;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  unitName?: string;
}): ResolvedServiceConfig;
export function updateWorkRoot(dataDir: string): string;
