// Project Intelligence Index — deterministic, commit-bound facts about a repo.
// Per-file facts are cached by git blob hash, so re-indexing after a change
// only re-parses the files that actually changed.

export const INDEX_VERSION = 3;

export type Lang = 'ts' | 'js' | 'py' | 'prisma' | 'sql' | 'yaml' | 'json' | 'other';

export interface ImportFact {
  spec: string;
  /** Imported names; 'default' for default import, '*' for namespace/side-effect/require. */
  names: string[];
  typeOnly: boolean;
  /** `export { x } from` / `export * from` — the file re-exports what it imports. */
  reexport: boolean;
  line: number;
}

export interface Declaration {
  name: string;
  kind: 'function' | 'class' | 'const' | 'type' | 'interface' | 'enum' | 'method' | 'variable';
  exported: boolean;
  startLine: number;
  endLine: number;
}

export interface RouteFact {
  method: string;
  path: string;
  line: number;
  framework: string;
}

export interface PageFact {
  path: string;
  framework: string;
}

export interface TableFact {
  name: string;
  /** Model / variable name in code when it differs from the table (Prisma model, Drizzle const). */
  alias?: string;
  columns: string[];
  relations: string[];
  source: 'prisma' | 'sql' | 'drizzle' | 'typeorm' | 'django' | 'sqlalchemy';
  line: number;
}

export interface FileFacts {
  path: string;
  blob: string;
  lang: Lang;
  imports: ImportFact[];
  declarations: Declaration[];
  routes: RouteFact[];
  pages: PageFact[];
  envVars: string[];
  testTitles: string[];
  tables: TableFact[];
  /** Tables / models this file reads or writes (prisma.booking, from('bookings'), raw SQL). */
  tableRefs: string[];
  urls: string[];
  /** Unique identifiers used anywhere in the file (grep-like search coverage). */
  identifiers?: string[];
  /** For workflow files: job -> commands. */
  ci?: { job: string; run: string[] }[];
  /** For .env.example-like files. */
  envKeys?: string[];
  parseError?: string;
}

export interface WorkspacePackage {
  name: string;
  dir: string;
  entry?: string;
  scripts: Record<string, string>;
}

export interface ApiEndpoint extends RouteFact {
  file: string;
}

export interface ProjectIndex {
  version: number;
  commit: string;
  builtAt: string;
  files: string[];
  facts: Record<string, FileFacts>;
  packages: WorkspacePackage[];
  /** file -> resolved internal files it imports */
  imports: Record<string, string[]>;
  importedBy: Record<string, string[]>;
  /** `${file}#${symbol}` -> files importing that symbol ('*' = whole module). */
  symbolUsers: Record<string, string[]>;
  /** external package -> files importing it */
  externals: Record<string, string[]>;
  testFiles: string[];
  /** source file -> test files that (transitively) import it */
  testsFor: Record<string, string[]>;
  api: ApiEndpoint[];
  pages: (PageFact & { file: string })[];
  tables: (TableFact & { file: string })[];
  /** normalised table/model key -> files that reference it */
  tableUsers: Record<string, string[]>;
  env: Record<string, string[]>;
  ci: { file: string; jobs: { job: string; run: string[] }[] }[];
  /** integration name -> files */
  integrations: Record<string, string[]>;
  stats: { files: number; parsed: number; reused: number; ms: number };
}
