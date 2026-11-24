import type { TypegenIncludeTarget, TypegenResult } from "./typegen/types";

export interface CliIO {
  stdout(message: string): void;
  stderr(message: string): void;
  cwd?: string;
}

export type CliFlagValue = string | boolean | readonly string[];

export interface ParsedCliArgs {
  readonly command?: string;
  readonly positionals: readonly string[];
  readonly flags: Readonly<Record<string, CliFlagValue>>;
}

export interface CliResult<T = unknown> {
  readonly exitCode: number;
  readonly output?: T;
}

export type SchematicType =
  | "application"
  | "class"
  | "configuration"
  | "controller"
  | "decorator"
  | "dto"
  | "endpoint"
  | "filter"
  | "gateway"
  | "guard"
  | "interceptor"
  | "interface"
  | "library"
  | "middleware"
  | "module"
  | "pipe"
  | "provider"
  | "resolver"
  | "resource"
  | "service"
  | "sub-app";

export interface GeneratedFile {
  readonly path: string;
  readonly relativePath: string;
  readonly content: string;
  readonly action: "create" | "overwrite" | "dry-run";
}

export interface SpawnResult {
  readonly exitCode: number;
}

export type SpawnFn = (
  cmd: string[],
  options: { cwd: string; env?: Record<string, string | undefined> },
) => Promise<SpawnResult>;

export interface CreateProjectOptions {
  readonly projectName: string;
  readonly dir?: string;
  readonly cwd?: string;
  readonly skipInstall?: boolean;
  readonly skipGit?: boolean;
  readonly strict?: boolean;
  readonly packageManager?: "bun" | "npm" | "yarn" | "pnpm" | string;
  readonly dryRun?: boolean;
  readonly force?: boolean;
  readonly spawn?: SpawnFn;
}

export interface CreateProjectResult {
  readonly projectName: string;
  readonly targetDir: string;
  readonly files: readonly GeneratedFile[];
  readonly installed: boolean;
  readonly gitInitialized?: boolean;
  readonly packageManager?: string;
  readonly dryRun: boolean;
}

export type ResourceTransportType =
  | "rest"
  | "microservice"
  | "ws"
  | "graphql-code-first"
  | "graphql-schema-first";

export interface GenerateSchematicOptions {
  readonly schematic: string;
  readonly name: string;
  readonly dir?: string;
  readonly directory?: string;
  readonly sourceRoot?: string;
  readonly project?: string;
  readonly config?: string;
  readonly specFileSuffix?: string;
  readonly language?: string;
  readonly collection?: string;
  readonly strict?: boolean;
  readonly packageManager?: string;
  readonly minimal?: boolean;
  readonly type?: ResourceTransportType;
  readonly crud?: boolean;
  readonly skipImport?: boolean;
  readonly module?: string;
  readonly cwd?: string;
  readonly flat?: boolean;
  readonly spec?: boolean;
  readonly dryRun?: boolean;
  readonly force?: boolean;
}

export interface GenerateSchematicResult {
  readonly schematic: SchematicType;
  readonly name: string;
  readonly targetDir: string;
  readonly files: readonly GeneratedFile[];
  readonly dryRun: boolean;
}

export interface BuildArtifactSummary {
  readonly path: string;
  readonly relativePath: string;
  readonly size: number;
  readonly kind: string;
}

export interface BuildProjectOptions {
  readonly entry?: string;
  readonly entryFile?: string;
  readonly sourceRoot?: string;
  readonly outdir?: string;
  readonly config?: string;
  readonly path?: string;
  readonly cwd?: string;
  readonly target?: "bun" | "browser" | "node";
  readonly minify?: boolean;
  readonly sourcemap?: "none" | "linked" | "inline" | "external" | boolean;
  readonly external?: readonly string[];
  readonly watch?: boolean;
  readonly watchAssets?: boolean;
  readonly deleteOutDir?: boolean;
  readonly emitDeclarations?: boolean;
  readonly compile?: boolean;
  readonly silent?: boolean;
  readonly spawn?: SpawnFn;
}

export interface BuildProjectResult {
  readonly success: boolean;
  readonly entry: string;
  readonly outdir: string;
  readonly outputs: readonly BuildArtifactSummary[];
  readonly durationMs: number;
  readonly logs: readonly string[];
  readonly compiledExecutable?: string;
}

export interface DevServerOptions {
  readonly entry?: string;
  readonly sourceRoot?: string;
  readonly config?: string;
  readonly port?: number;
  readonly cwd?: string;
  readonly typegen?: boolean;
  readonly typegenOutDir?: string;
  readonly silent?: boolean;
  readonly spawn?: SpawnFn;
}

export interface DevServerResult {
  readonly exitCode: number;
  readonly command: readonly string[];
  readonly entry: string;
  readonly port?: number;
  readonly typegen?: TypegenResult;
}

export interface StartCommandOptions {
  readonly entry?: string;
  readonly entryFile?: string;
  readonly sourceRoot?: string;
  readonly config?: string;
  readonly path?: string;
  readonly watch?: boolean;
  readonly debug?: boolean | string;
  readonly envFile?: string | readonly string[];
  readonly preserveWatchOutput?: boolean;
  readonly silent?: boolean;
  readonly exec?: string;
  readonly port?: number;
  readonly cwd?: string;
  readonly typegen?: boolean;
  readonly typegenOutDir?: string;
  readonly spawn?: SpawnFn;
}

export interface StartCommandResult {
  readonly exitCode: number;
  readonly command: readonly string[];
  readonly entry: string;
  readonly watch: boolean;
  readonly debug?: boolean | string;
  readonly envFiles: readonly string[];
  readonly typegen?: TypegenResult;
}

export interface TypegenCommandOptions {
  readonly cwd?: string;
  readonly sourceRoot?: string;
  readonly outdir?: string;
  readonly fileName?: string;
  readonly tsconfig?: string;
  readonly config?: string;
  readonly envFile?: string | readonly string[];
  readonly include?: readonly TypegenIncludeTarget[];
  readonly includeGlobalNamespace?: boolean;
  readonly watch?: boolean;
  readonly check?: boolean;
  readonly dryRun?: boolean;
  readonly silent?: boolean;
  readonly debounceMs?: number;
  readonly signal?: AbortSignal;
}

export interface TypegenCommandResult {
  readonly exitCode: number;
  readonly watch: boolean;
  readonly result: TypegenResult;
}

export interface AddLibraryOptions {
  readonly library: string;
  readonly dryRun?: boolean;
  readonly skipInstall?: boolean;
  readonly project?: string;
  readonly cwd?: string;
  readonly spawn?: SpawnFn;
}

export interface AddLibraryResult {
  readonly library: string;
  readonly installed: boolean;
  readonly dryRun: boolean;
  readonly command: readonly string[];
  readonly exitCode: number;
}

export interface UpgradeProjectOptions {
  readonly dryRun?: boolean;
  readonly skipInstall?: boolean;
  readonly tag?: string;
  readonly observe?: boolean;
  readonly collection?: string;
  readonly cwd?: string;
  readonly spawn?: SpawnFn;
}

export interface UpgradeProjectResult {
  readonly packages: readonly string[];
  readonly upgraded: boolean;
  readonly dryRun: boolean;
  readonly command: readonly string[];
  readonly exitCode: number;
}

export interface DeployProjectOptions {
  readonly entry?: string;
  readonly entryFile?: string;
  readonly outdir?: string;
  readonly config?: string;
  readonly compile?: boolean;
  readonly dryRun?: boolean;
  readonly silent?: boolean;
  readonly cwd?: string;
  readonly spawn?: SpawnFn;
}

export interface DeployProjectResult {
  readonly success: boolean;
  readonly dryRun: boolean;
  readonly target: "bundle" | "compile" | "custom";
  readonly command?: readonly string[];
  readonly outdir: string;
  readonly exitCode: number;
}

export interface ReplCommandOptions {
  readonly entry?: string;
  readonly cwd?: string;
  readonly spawn?: SpawnFn;
}

export interface ReplCommandResult {
  readonly exitCode: number;
  readonly command: readonly string[];
  readonly entry: string;
}

export interface EnvironmentInfo {
  readonly bunestVersion: string;
  readonly bunVersion: string;
  readonly bunRevision: string;
  readonly platform: NodeJS.Platform;
  readonly osRelease: string;
  readonly arch: string;
  readonly cpuModel: string;
  readonly cpuCores: number;
  readonly totalMemoryBytes: number;
  readonly freeMemoryBytes: number;
  readonly packages?: Readonly<Record<string, string>>;
}
