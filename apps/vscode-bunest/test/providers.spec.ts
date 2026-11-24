import { afterEach, describe, expect, it, mock } from "bun:test";
import {
  BunestStaticAnalyzer,
  CUSTOM_MACROS_REGISTRY_SYMBOL,
  CUSTOM_ORM_OPERATORS_SYMBOL,
  GLOBAL_MACRO_DEFAULTS_SYMBOL,
  getRepositoryDerivedCompletions,
  resolveClassMacroMembers,
} from "@bunest/cli";
import {
  clearCustomMacros,
  dirname,
  existsSyncPath,
  join,
  mkdirSyncPath,
  readTextSync,
  removePath,
  resetGlobalMacroDefaults,
  writeTextSync,
} from "@bunest/core";

// ============================================================================
// Lightweight Headless VS Code API Mock (Zero `node:*` imports)
// ============================================================================

class MockPosition {
  constructor(
    public readonly line: number,
    public readonly character: number,
  ) {}
}

class MockRange {
  readonly start: MockPosition;
  readonly end: MockPosition;
  constructor(
    startOrLine: MockPosition | number,
    endOrCol: MockPosition | number,
    endLine?: number,
    endCol?: number,
  ) {
    if (typeof startOrLine === "number") {
      this.start = new MockPosition(startOrLine, Number(endOrCol));
      this.end = new MockPosition(endLine ?? startOrLine, endCol ?? Number(endOrCol));
    } else {
      this.start = startOrLine;
      this.end = endOrCol as MockPosition;
    }
  }
}

class MockLocation {
  constructor(
    public readonly uri: MockUri,
    public readonly range: MockRange,
  ) {}
}

class MockUri {
  constructor(public readonly fsPath: string) {}
  static file(p: string): MockUri {
    return new MockUri(p);
  }
}

class MockMarkdownString {
  value = "";
  isTrusted = false;
  constructor(initial = "") {
    this.value = initial;
  }
  appendMarkdown(text: string): this {
    this.value += text;
    return this;
  }
}

class MockHover {
  constructor(public readonly contents: MockMarkdownString) {}
}

class MockCodeLens {
  constructor(
    public readonly range: MockRange,
    public readonly command?: {
      title: string;
      command: string;
      arguments?: unknown[];
      tooltip?: string;
    },
  ) {}
}

class MockCompletionItem {
  detail?: string;
  sortText?: string;
  insertText?: string;
  range?: MockRange;
  filterText?: string;
  documentation?: MockMarkdownString;
  command?: { command: string; title: string };
  constructor(
    public readonly label: string,
    public readonly kind?: number,
  ) {}
}

class MockDiagnostic {
  code?: string | number;
  source?: string;
  constructor(
    public readonly range: MockRange,
    public readonly message: string,
    public readonly severity: number,
  ) {}
}

class MockWorkspaceEdit {
  readonly edits: Array<{
    readonly kind: "replace" | "insert";
    readonly uri: MockUri;
    readonly rangeOrPos: MockRange | MockPosition;
    readonly text: string;
  }> = [];
  replace(uri: MockUri, range: MockRange, newText: string): void {
    this.edits.push({ kind: "replace", uri, rangeOrPos: range, text: newText });
  }
  insert(uri: MockUri, pos: MockPosition, newText: string): void {
    this.edits.push({ kind: "insert", uri, rangeOrPos: pos, text: newText });
  }
}

class MockCodeAction {
  edit?: MockWorkspaceEdit;
  diagnostics?: MockDiagnostic[];
  isPreferred?: boolean;
  constructor(
    public readonly title: string,
    public readonly kind?: string,
  ) {}
}

class MockEventEmitter<T> {
  private readonly listeners = new Set<(e: T) => void>();
  readonly event = (listener: (e: T) => void) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  fire(data: T): void {
    for (const l of this.listeners) l(data);
  }
  dispose(): void {
    this.listeners.clear();
  }
}

let mockWorkspaceFolders: Array<{ uri: MockUri; name: string; index: number }> = [];
let mockConfigValues: Record<string, unknown> = {};
let mockOpenDocuments: Array<ReturnType<typeof createMockTextDocument>> = [];
const mockPublishedDiagnostics = new Map<string, MockDiagnostic[]>();
const mockDidChangeDocEmitter = new MockEventEmitter<{
  readonly document: ReturnType<typeof createMockTextDocument>;
  readonly contentChanges: ReadonlyArray<{ readonly text: string }>;
}>();
const mockDidSaveDocEmitter = new MockEventEmitter<
  ReturnType<typeof createMockTextDocument>
>();
const mockDidOpenDocEmitter = new MockEventEmitter<
  ReturnType<typeof createMockTextDocument>
>();
const mockDidCloseDocEmitter = new MockEventEmitter<
  ReturnType<typeof createMockTextDocument>
>();

mock.module("vscode", () => ({
  Position: MockPosition,
  Range: MockRange,
  Location: MockLocation,
  Uri: MockUri,
  MarkdownString: MockMarkdownString,
  Hover: MockHover,
  CodeLens: MockCodeLens,
  CompletionItem: MockCompletionItem,
  CompletionItemKind: {
    Method: 1,
    Field: 4,
    Keyword: 13,
    Operator: 24,
  },
  Diagnostic: MockDiagnostic,
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  WorkspaceEdit: MockWorkspaceEdit,
  CodeAction: MockCodeAction,
  CodeActionKind: {
    QuickFix: "quickfix",
    RefactorRewrite: "refactor.rewrite",
  },
  StatusBarAlignment: { Left: 1, Right: 2 },
  EventEmitter: MockEventEmitter,
  window: {
    createOutputChannel: () => ({
      appendLine: () => {},
      show: () => {},
      dispose: () => {},
    }),
    createStatusBarItem: () => ({
      text: "",
      tooltip: "",
      command: "",
      show: () => {},
      dispose: () => {},
    }),
  },
  languages: {
    createDiagnosticCollection: () => ({
      clear: () => mockPublishedDiagnostics.clear(),
      set: (uri: MockUri, diags: MockDiagnostic[]) => {
        mockPublishedDiagnostics.set(uri.fsPath, diags);
      },
      dispose: () => mockPublishedDiagnostics.clear(),
    }),
  },
  workspace: {
    get workspaceFolders() {
      return mockWorkspaceFolders;
    },
    get textDocuments() {
      return mockOpenDocuments;
    },
    getConfiguration: () => ({
      get: (key: string) => mockConfigValues[key],
    }),
    createFileSystemWatcher: () => ({
      onDidChange: () => ({ dispose: () => {} }),
      onDidCreate: () => ({ dispose: () => {} }),
      onDidDelete: () => ({ dispose: () => {} }),
      dispose: () => {},
    }),
    onDidSaveTextDocument: (cb: any) => mockDidSaveDocEmitter.event(cb),
    onDidChangeTextDocument: (cb: any) => mockDidChangeDocEmitter.event(cb),
    onDidOpenTextDocument: (cb: any) => mockDidOpenDocEmitter.event(cb),
    onDidCloseTextDocument: (cb: any) => mockDidCloseDocEmitter.event(cb),
    onDidCreateFiles: () => ({ dispose: () => {} }),
    onDidDeleteFiles: () => ({ dispose: () => {} }),
    onDidChangeWorkspaceFolders: () => ({ dispose: () => {} }),
  },
}));

const { BunestWorkspaceIndex } = await import("../src/workspace/workspace-index");
const { BunestHoverProvider } = await import("../src/providers/hover.provider");
const { BunestCodeLensProvider } = await import("../src/providers/codelens.provider");
const { BunestRepositoryCompletionProvider } = await import(
  "../src/providers/repository-completion.provider"
);
const { BunestDiagnosticsProvider } = await import(
  "../src/providers/diagnostics.provider"
);
const { BunestCodeActionsProvider } = await import(
  "../src/providers/code-actions.provider"
);

function createMockTextDocument(filePath: string, text: string) {
  const lines = text.split("\n");
  const lineStarts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }

  return {
    uri: MockUri.file(filePath),
    getText: () => text,
    lineAt: (line: number) => ({ text: lines[line] ?? "" }),
    positionAt: (posOffset: number) => {
      let line = 0;
      for (let i = 0; i < lineStarts.length; i++) {
        if (lineStarts[i]! <= posOffset) line = i;
        else break;
      }
      return new MockPosition(line, Math.max(0, posOffset - (lineStarts[line] ?? 0)));
    },
  };
}

const tempDirs: string[] = [];

function createTempWorkspace(files: Record<string, string>): string {
  const tmpBase = Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp";
  const dir = join(tmpBase, `vscode-bunest-${crypto.randomUUID().slice(0, 8)}`);
  mkdirSyncPath(dir, { recursive: true });
  tempDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSyncPath(dirname(abs), { recursive: true });
    writeTextSync(abs, content);
  }
  return dir;
}

afterEach(async () => {
  mockWorkspaceFolders = [];
  mockConfigValues = {};
  mockOpenDocuments = [];
  mockPublishedDiagnostics.clear();
  resetGlobalMacroDefaults();
  clearCustomMacros();
  const g = globalThis as unknown as Record<symbol, unknown>;
  delete g[GLOBAL_MACRO_DEFAULTS_SYMBOL];
  const macroMap = g[CUSTOM_MACROS_REGISTRY_SYMBOL];
  if (macroMap instanceof Map) macroMap.clear();
  const opMap = g[CUSTOM_ORM_OPERATORS_SYMBOL];
  if (opMap instanceof Map) opMap.clear();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await removePath(dir, { recursive: true, force: true });
  }
});

describe("vscode-bunest providers integration (headless analyzer + customizable magic)", () => {
  it("indexes routes, declarative repositories, class macros, and diagnostics for VS Code providers", () => {
    const dir = createTempWorkspace({
      ".env": "PORT=3000\nJWT_SECRET=super-secret-value\n",
      "src/user.entity.ts": `
        function Entity(_t?: string): ClassDecorator { return () => {}; }
        function Column(): PropertyDecorator { return () => {}; }
        function PrimaryGeneratedColumn(): PropertyDecorator { return () => {}; }
        function Data(): ClassDecorator { return () => {}; }
        function Builder(): ClassDecorator { return () => {}; }

        @Entity("users")
        @Data()
        @Builder()
        export class UserEntity {
          @PrimaryGeneratedColumn()
          id!: number;
          @Column()
          email!: string;
          @Column()
          active!: boolean;
        }
      `,
      "src/user.repository.ts": `
        import { UserEntity } from "./user.entity";
        function OrmRepository(_e?: any): ClassDecorator { return () => {}; }
        abstract class CrudRepository<T, K = number> {}

        @OrmRepository(UserEntity)
        export abstract class UserRepository extends CrudRepository<UserEntity, number> {
          abstract findByEmail(email: string): Promise<UserEntity | null>;
        }
      `,
    });

    const analyzer = new BunestStaticAnalyzer({ cwd: dir, sourceRoot: "src" });
    const snap = analyzer.analyze();

    expect(snap.entities.length).toBe(1);
    expect(snap.repositories.length).toBe(1);
    expect(snap.scan.envKeys.map((e) => e.key)).toContain("JWT_SECRET");
    expect(snap.scan.classMacros.length).toBe(1);

    const repo = snap.repositories[0]!;
    const completions = getRepositoryDerivedCompletions(repo, "findAllByEmail");
    expect(completions.some((c) => c.label === "Containing")).toBe(true);
    expect(completions.some((c) => c.label === "And")).toBe(true);

    const macroMembers = resolveClassMacroMembers(snap.scan.classMacros[0]!);
    expect(macroMembers.some((m) => m.name === "builder")).toBe(true);
    expect(macroMembers.some((m) => m.name === "equals")).toBe(true);
  });

  it("loads bunest.config.ts and surfaces custom macros/presets in Hover, CodeLens, and Delombok code actions", async () => {
    const modelSource = `function DomainEntity(): ClassDecorator { return () => {}; }
function Auditable(): ClassDecorator { return () => {}; }

@DomainEntity()
@Auditable()
export class AccountModel {
  id!: number;
  email!: string;
}
`;

    const dir = createTempWorkspace({
      "bunest.config.ts": `export default {
  macros: {
    defaults: {
      builder: { toBuilder: true, setterPrefix: "with" },
      fieldNameConstants: { uppercase: true, innerName: "KEYS" },
    },
    presets: {
      DomainEntity: ["Data", "Builder", "FieldNameConstants"],
    },
    plugins: [
      {
        name: "Auditable",
        fields: [{ name: "createdAt", type: "Date", readonly: true }],
        methods: {
          touchAudit: {
            signature: "(actor: string): this",
            delombokBody: "void actor;\\nreturn this;",
          },
        },
      },
    ],
  },
};
`,
      "src/account.model.ts": modelSource,
    });

    mockWorkspaceFolders = [{ uri: MockUri.file(dir), name: "app", index: 0 }];
    const index = new BunestWorkspaceIndex();
    await index.initialize();

    const modelPath = join(dir, "src/account.model.ts");
    const doc = createMockTextDocument(modelPath, modelSource);

    // 1. Hover table displays expanded preset + custom macro members
    const hoverProvider = new BunestHoverProvider(index);
    const hover = hoverProvider.provideHover(
      doc as unknown as import("vscode").TextDocument,
      new MockPosition(5, 16) as unknown as import("vscode").Position,
    ) as unknown as MockHover | undefined;
    expect(hover).toBeDefined();
    expect(hover!.contents.value).toContain("Expanded presets");
    expect(hover!.contents.value).toContain("@DomainEntity");
    expect(hover!.contents.value).toContain("touchAudit(actor: string): this");
    expect(hover!.contents.value).toContain("readonly createdAt: Date");
    expect(hover!.contents.value).toContain("toBuilder()");

    // 2. CodeLens counts preset + custom macro members
    const codeLensProvider = new BunestCodeLensProvider(index);
    const lenses = codeLensProvider.provideCodeLenses(
      doc as unknown as import("vscode").TextDocument,
    ) as unknown as MockCodeLens[];
    const macroLens = lenses.find((l) => l.command?.command === "bunest.delombokClass");
    expect(macroLens).toBeDefined();
    expect(macroLens!.command!.title).toContain("@DomainEntity");
    expect(macroLens!.command!.title).toContain("@Auditable");

    // 3. Delombok CodeAction expands both preset and custom macro
    const codeActionsProvider = new BunestCodeActionsProvider(index);
    const actions = codeActionsProvider.provideCodeActions(
      doc as unknown as import("vscode").TextDocument,
      new MockRange(5, 0, 5, 20) as unknown as import("vscode").Range,
      { diagnostics: [] } as unknown as import("vscode").CodeActionContext,
    ) as unknown as MockCodeAction[];
    const delombokAct = actions.find((a) => a.title.includes("Delombok"));
    expect(delombokAct).toBeDefined();
    const editText = delombokAct!.edit!.edits[0]!.text;
    expect(editText).not.toContain("@DomainEntity()");
    expect(editText).not.toContain("@Auditable()");
    expect(editText).toContain("static readonly KEYS =");
    expect(editText).toContain("touchAudit(actor: string): this {");
    expect(editText).toContain("readonly createdAt: Date;");

    index.dispose();
  });

  it("surfaces custom ORM query operators, @SoftDelete, @TenantScoped, @Projection, findPageBy*, and findCursorBy* in completions and SQL Hover", async () => {
    const repoSource = `import { ArticleEntity } from "./article.entity";
function OrmRepository(_e?: any): ClassDecorator { return () => {}; }
function SoftDelete(): ClassDecorator { return () => {}; }
function TenantScoped(): ClassDecorator { return () => {}; }
function IgnoreScope(..._names: string[]): MethodDecorator { return () => {}; }
function Projection(..._fields: string[]): MethodDecorator { return () => {}; }
abstract class CrudRepository<T, K = number> {}
interface Pageable { page: number; size: number; }
interface Page<T> { items: T[]; total: number; }
interface CursorPageable { cursor?: number; limit: number; }
interface CursorPage<T> { items: T[]; nextCursor: number | null; hasMore: boolean; }

@OrmRepository(ArticleEntity)
@SoftDelete()
@TenantScoped()
export abstract class ArticleRepository extends CrudRepository<ArticleEntity, number> {
  @Projection("id", "title")
  abstract findPageByBioMatches(pattern: string, pageable: Pageable): Promise<Page<Pick<ArticleEntity, "id" | "title">>>;

  @IgnoreScope("softDelete")
  abstract findCursorByTitle(title: string, cursor: CursorPageable): Promise<CursorPage<ArticleEntity>>;

  abstract findByBio
}
`;

    const dir = createTempWorkspace({
      "bunest.config.ts": `export default {
  orm: {
    queryOperators: [
      {
        suffix: "Matches",
        arity: 1,
        description: "Regex pattern match",
        toSql(ctx: any) {
          const p = ctx.nextPlaceholder();
          return {
            sql: ctx.dialect === "postgres" ? \`\${ctx.quotedColumn} ~ \${p}\` : \`\${ctx.quotedColumn} REGEXP \${p}\`,
          };
        },
      },
    ],
  },
};
`,
      "src/article.entity.ts": `function Entity(_t?: string): ClassDecorator { return () => {}; }
function PrimaryGeneratedColumn(): PropertyDecorator { return () => {}; }
function Column(): PropertyDecorator { return () => {}; }

@Entity("articles")
export class ArticleEntity {
  @PrimaryGeneratedColumn()
  id!: number;
  @Column()
  title!: string;
  @Column()
  bio!: string;
}
`,
      "src/article.repository.ts": repoSource,
    });

    mockWorkspaceFolders = [{ uri: MockUri.file(dir), name: "app", index: 0 }];
    const index = new BunestWorkspaceIndex();
    await index.initialize();

    const repoPath = join(dir, "src/article.repository.ts");
    const doc = createMockTextDocument(repoPath, repoSource);

    // 1. Repository autocomplete surfaces custom `Matches` operator + `findPageBy`/`findCursorBy`
    const completionProvider = new BunestRepositoryCompletionProvider(index);
    const items = completionProvider.provideCompletionItems(
      doc as unknown as import("vscode").TextDocument,
      new MockPosition(22, "  abstract findByBio".length) as unknown as import("vscode").Position,
    ) as unknown as MockCompletionItem[] | undefined;
    expect(items).toBeDefined();
    const matchesItem = items!.find((i) => i.label === "Matches");
    expect(matchesItem).toBeDefined();
    expect(matchesItem!.detail).toContain("Regex pattern match");

    // 2. SQL preview Hover surfaces custom operator SQL + @Projection + @SoftDelete + @TenantScoped + Page<T>
    const hoverProvider = new BunestHoverProvider(index);
    const pageHover = hoverProvider.provideHover(
      doc as unknown as import("vscode").TextDocument,
      new MockPosition(17, 15) as unknown as import("vscode").Position,
    ) as unknown as MockHover | undefined;
    expect(pageHover).toBeDefined();
    expect(pageHover!.contents.value).toContain('SELECT "id", "title" FROM "articles"');
    expect(pageHover!.contents.value).toContain('"bio" REGEXP ?');
    expect(pageHover!.contents.value).toContain('"deleted_at" IS NULL');
    expect(pageHover!.contents.value).toContain('"tenant_id" = ?');
    expect(pageHover!.contents.value).toContain("@Projection");
    expect(pageHover!.contents.value).toContain("Page<T>");

    // 3. Cursor pagination + @IgnoreScope("softDelete") Hover
    const cursorHover = hoverProvider.provideHover(
      doc as unknown as import("vscode").TextDocument,
      new MockPosition(20, 15) as unknown as import("vscode").Position,
    ) as unknown as MockHover | undefined;
    expect(cursorHover).toBeDefined();
    expect(cursorHover!.contents.value).toContain("CursorPage<T>");
    expect(cursorHover!.contents.value).toContain("@IgnoreScope");
    expect(cursorHover!.contents.value).not.toContain('"deleted_at" IS NULL');

    index.dispose();
  });

  it("publishes BUNEST_ARCH001, BUNEST_ARCH002, and custom rule diagnostics + applies customRuleFix quick-fixes and hot-reloads bunest.config.ts", async () => {
    const controllerSource = `function Controller(_p?: string): ClassDecorator { return () => {}; }
function Post(): MethodDecorator { return () => {}; }
class OrdersRepository {}

@Controller("orders")
export class TodoOrdersController {
  constructor(private readonly ordersRepo: OrdersRepository) {}

  @Post()
  createOrder() {}
}
`;

    const dir = createTempWorkspace({
      "bunest.config.ts": `export default {
  diagnostics: {
    presetRules: ["no-repository-in-controller", "require-guard-on-mutations"],
    rules: [
      {
        code: "ACME_NO_TODO",
        severity: "warning",
        description: "Rename Todo-prefixed controllers",
        check(ctx: any) {
          const hits = [];
          for (const sf of ctx.sourceFiles) {
            for (const cls of sf.getClasses()) {
              const nameNode = cls.getNameNode();
              const name = cls.getName();
              if (name && nameNode && name.startsWith("Todo")) {
                const start = nameNode.getStart();
                const end = nameNode.getEnd();
                const pos = sf.getLineAndColumnAtPos(start);
                hits.push({
                  message: \`Remove Todo prefix from \${name}\`,
                  location: {
                    filePath: sf.getFilePath(),
                    line: pos.line,
                    column: pos.column,
                    endLine: pos.line,
                    endColumn: pos.column + name.length,
                    start,
                    end,
                  },
                  fix: {
                    description: "Remove Todo prefix",
                    start,
                    end,
                    newText: name.slice(4),
                  },
                });
              }
            }
          }
          return hits;
        },
      },
    ],
  },
};
`,
      "src/orders.controller.ts": controllerSource,
    });

    mockWorkspaceFolders = [{ uri: MockUri.file(dir), name: "app", index: 0 }];
    const index = new BunestWorkspaceIndex();
    const diagProvider = new BunestDiagnosticsProvider(index);
    await index.initialize();

    const ctrlPath = join(dir, "src/orders.controller.ts");
    const published = mockPublishedDiagnostics.get(ctrlPath) ?? [];
    const codes = new Set(published.map((d) => String(d.code)));
    expect(codes.has("BUNEST_ARCH001")).toBe(true);
    expect(codes.has("BUNEST_ARCH002")).toBe(true);
    expect(codes.has("ACME_NO_TODO")).toBe(true);

    // CodeActionsProvider produces QuickFix edit for `customRuleFix`
    const todoDiag = published.find((d) => d.code === "ACME_NO_TODO")!;
    const doc = createMockTextDocument(ctrlPath, controllerSource);
    const codeActionsProvider = new BunestCodeActionsProvider(index);
    const actions = codeActionsProvider.provideCodeActions(
      doc as unknown as import("vscode").TextDocument,
      todoDiag.range as unknown as import("vscode").Range,
      { diagnostics: [todoDiag] } as unknown as import("vscode").CodeActionContext,
    ) as unknown as MockCodeAction[];

    const customFixAct = actions.find((a) =>
      a.title.includes("Remove Todo prefix"),
    );
    expect(customFixAct).toBeDefined();
    expect(customFixAct!.edit!.edits[0]!.text).toBe("OrdersController");

    // Hot-reload bunest.config.ts (disable preset rules) clears BUNEST_ARCH001/002 immediately!
    writeTextSync(join(dir, "bunest.config.ts"), `export default {};\n`);
    const ctx = index.getContextForFile(ctrlPath)!;
    await index.reloadConfigForFolder(ctx);
    const afterReload = mockPublishedDiagnostics.get(ctrlPath) ?? [];
    expect(afterReload.some((d) => d.code === "BUNEST_ARCH001")).toBe(false);
    expect(afterReload.some((d) => d.code === "ACME_NO_TODO")).toBe(false);

    diagProvider.dispose();
    index.dispose();
  });

  it("regenerates .bunest/types/bunest.d.ts live from unsaved .ts and .env buffers without saving, resists mid-keystroke syntax errors, and reverts on close-without-save", async () => {
    mockConfigValues = { "typegen.debounceMs": 15, "typegen.live": true };

    const initialEntity = `function Data(): ClassDecorator { return () => {}; }
function Builder(): ClassDecorator { return () => {}; }

@Data()
@Builder()
export class UserEntity {
  id!: number;
  email!: string;
}
`;
    const dir = createTempWorkspace({
      "bunest.json": JSON.stringify({
        sourceRoot: "src",
        typegen: { enabled: true, outDir: ".bunest/types", fileName: "bunest.d.ts" },
      }),
      ".env": "PORT=3000\n",
      "src/user.entity.ts": initialEntity,
    });

    mockWorkspaceFolders = [{ uri: MockUri.file(dir), name: "app", index: 0 }];
    const index = new BunestWorkspaceIndex();
    await index.initialize();

    const dtsPath = join(dir, ".bunest/types/bunest.d.ts");
    const entityPath = join(dir, "src/user.entity.ts");
    const envPath = join(dir, ".env");

    // 1. Initial load immediately emits `.bunest/types/bunest.d.ts`
    expect(existsSyncPath(dtsPath)).toBe(true);
    expect(readTextSync(dtsPath)).toContain("getEmail(): string;");
    expect(readTextSync(dtsPath)).not.toContain("getPhone");

    // 2. Unsaved edit in `user.entity.ts` (NOT written to disk!) immediately updates `.bunest/types/bunest.d.ts`
    const editedEntity = initialEntity.replace(
      "email!: string;",
      "email!: string;\n  phone!: string;",
    );
    const editedDoc = createMockTextDocument(entityPath, editedEntity);
    mockOpenDocuments = [editedDoc];
    mockDidChangeDocEmitter.fire({
      document: editedDoc,
      contentChanges: [{ text: "phone!: string;" }],
    });
    await Bun.sleep(60);

    // Disk source file is still untouched, yet `.bunest/types/bunest.d.ts` already has `getPhone()` & `phone()`!
    expect(readTextSync(entityPath)).not.toContain("phone");
    const afterEditDts = readTextSync(dtsPath);
    expect(afterEditDts).toContain("getPhone(): string;");
    expect(afterEditDts).toContain("phone(value: string): this;");

    // 3. Mid-keystroke partial field (`nickname:` without type yet) never writes invalid syntax
    const partialEntity = editedEntity.replace(
      "phone!: string;",
      "phone!: string;\n  nickname:",
    );
    const partialDoc = createMockTextDocument(entityPath, partialEntity);
    mockOpenDocuments = [partialDoc];
    mockDidChangeDocEmitter.fire({
      document: partialDoc,
      contentChanges: [{ text: "nickname:" }],
    });
    await Bun.sleep(60);

    const partialDts = readTextSync(dtsPath);
    expect(partialDts).toContain("getNickname(): unknown;");
    expect(partialDts).not.toContain("getNickname(): };");

    // 4. Unsaved `.env` edit updates `BunestConfigRegistry` and live hover preview without saving `.env`
    const envDoc = createMockTextDocument(
      envPath,
      "PORT=3000\nSTRIPE_SECRET=sk_live_999\n",
    );
    mockOpenDocuments = [partialDoc, envDoc];
    mockDidChangeDocEmitter.fire({
      document: envDoc,
      contentChanges: [{ text: "STRIPE_SECRET=sk_live_999\n" }],
    });
    await Bun.sleep(60);

    expect(readTextSync(envPath)).not.toContain("STRIPE_SECRET");
    expect(readTextSync(dtsPath)).toContain("STRIPE_SECRET: string;");
    expect(index.readEnvPreview(dir, "STRIPE_SECRET")).toEqual({
      file: ".env",
      value: "[REDACTED]",
      redacted: true,
    });

    // 5. Closing unsaved documents without saving reverts `.bunest/types/bunest.d.ts` cleanly back to disk
    mockOpenDocuments = [];
    mockDidCloseDocEmitter.fire(partialDoc);
    mockDidCloseDocEmitter.fire(envDoc);
    await Bun.sleep(60);

    const revertedDts = readTextSync(dtsPath);
    expect(revertedDts).not.toContain("getPhone");
    expect(revertedDts).not.toContain("getNickname");
    expect(revertedDts).not.toContain("STRIPE_SECRET");

    index.dispose();
  });

  it("lazily discovers nested Bunest subprojects inside a monorepo workspace and respects bunest.typegen.live = false", async () => {
    mockConfigValues = { "typegen.debounceMs": 15, "typegen.live": true };

    const monoRoot = createTempWorkspace({
      "package.json": JSON.stringify({ name: "my-monorepo", private: true }),
      "examples/demo/bunest.json": JSON.stringify({ sourceRoot: "src" }),
      "examples/demo/src/item.entity.ts": `function Data(): ClassDecorator { return () => {}; }
@Data()
export class ItemEntity {
  id!: number;
}
`,
    });

    mockWorkspaceFolders = [{ uri: MockUri.file(monoRoot), name: "mono", index: 0 }];
    const index = new BunestWorkspaceIndex();
    await index.initialize();

    const itemPath = join(monoRoot, "examples/demo/src/item.entity.ts");
    const subDtsPath = join(monoRoot, "examples/demo/.bunest/types/bunest.d.ts");

    // Editing a file inside the nested Bunest subproject triggers lazy registration + live typegen
    const editedItem = `function Data(): ClassDecorator { return () => {}; }
@Data()
export class ItemEntity {
  id!: number;
  sku!: string;
}
`;
    const itemDoc = createMockTextDocument(itemPath, editedItem);
    mockDidChangeDocEmitter.fire({
      document: itemDoc,
      contentChanges: [{ text: "sku!: string;" }],
    });
    await Bun.sleep(80);

    expect(existsSyncPath(subDtsPath)).toBe(true);
    expect(readTextSync(subDtsPath)).toContain("getSku(): string;");

    // Turning `bunest.typegen.live` off prevents subsequent disk writes while keeping AST index alive
    mockConfigValues = { "typegen.debounceMs": 15, "typegen.live": false };
    const editedAgain = editedItem.replace("sku!: string;", "sku!: string;\n  price!: number;");
    mockDidChangeDocEmitter.fire({
      document: createMockTextDocument(itemPath, editedAgain),
      contentChanges: [{ text: "price!: number;" }],
    });
    await Bun.sleep(60);

    expect(readTextSync(subDtsPath)).not.toContain("getPrice");
    expect(
      index
        .getSnapshotForFile(itemPath)
        ?.scan.classMacros[0]?.fields.some((f) => f.name === "price"),
    ).toBe(true);

    index.dispose();
  });

  it("supports @BaseEntity<Key>() in live zero-save typegen, Hover, Delombok, repository autocomplete, and SQL preview", async () => {
    mockConfigValues = { "typegen.debounceMs": 15, "typegen.live": true };

    const entitySrc = `function BaseEntity<Key = number>(_opts?: any): ClassDecorator { return () => {}; }
function Column(): PropertyDecorator { return () => {}; }

@BaseEntity<string>({ tableName: "invoices", idStrategy: "uuid" })
export class InvoiceEntity {
  @Column()
  code!: string;
}
`;
    const repoSrc = `import { InvoiceEntity } from "./invoice.entity";
function OrmRepository(_e?: any): ClassDecorator { return () => {}; }
abstract class CrudRepository<T, K = number> {}

@OrmRepository(InvoiceEntity)
export abstract class InvoiceRepository extends CrudRepository<InvoiceEntity, string> {
  abstract findById(id: string): Promise<InvoiceEntity | null>;
  abstract findAllByCreatedAtGreaterThan(since: Date): Promise<InvoiceEntity[]>;
  abstract findAllByDeletedAtIsNull(): Promise<InvoiceEntity[]>;
  abstract findAllBy
}
`;

    const dir = createTempWorkspace({
      "bunest.json": JSON.stringify({ sourceRoot: "src" }),
      "src/invoice.entity.ts": entitySrc,
      "src/invoice.repository.ts": repoSrc,
    });

    mockWorkspaceFolders = [{ uri: MockUri.file(dir), name: "app", index: 0 }];
    const index = new BunestWorkspaceIndex();
    await index.initialize();

    const dtsPath = join(dir, ".bunest/types/bunest.d.ts");
    const entityPath = join(dir, "src/invoice.entity.ts");
    const repoPath = join(dir, "src/invoice.repository.ts");

    // 1. Typegen emits `id: string`, `createdAt`, `updatedAt`, `deletedAt`
    const dts = readTextSync(dtsPath);
    expect(dts).toContain("interface InvoiceEntity {");
    expect(dts).toContain("id: string;");
    expect(dts).toContain("createdAt: Date;");
    expect(dts).toContain("updatedAt: Date;");
    expect(dts).toContain("deletedAt?: Date | null;");

    // 2. Repository analyzer has ZERO diagnostics on findById / findAllByCreatedAtAfter / findAllByDeletedAtIsNull
    const snap = index.getSnapshotForFile(repoPath)!;
    const repoDiags = snap.diagnostics.filter((d) =>
      d.code.startsWith("BUNEST_REPO"),
    );
    expect(repoDiags).toHaveLength(0);

    // 3. Derived query autocomplete surfaces Id, CreatedAt, UpdatedAt, DeletedAt
    const completionProvider = new BunestRepositoryCompletionProvider(index);
    const items = completionProvider.provideCompletionItems(
      createMockTextDocument(repoPath, repoSrc) as unknown as import("vscode").TextDocument,
      new MockPosition(9, "  abstract findAllBy".length) as unknown as import("vscode").Position,
    ) as unknown as MockCompletionItem[] | undefined;
    const labels = new Set((items ?? []).map((i) => i.label));
    expect(labels.has("Id")).toBe(true);
    expect(labels.has("CreatedAt")).toBe(true);
    expect(labels.has("UpdatedAt")).toBe(true);
    expect(labels.has("DeletedAt")).toBe(true);

    // 4. Hover on InvoiceEntity shows @BaseEntity<string> members
    const hoverProvider = new BunestHoverProvider(index);
    const entityHover = hoverProvider.provideHover(
      createMockTextDocument(entityPath, entitySrc) as unknown as import("vscode").TextDocument,
      new MockPosition(4, 15) as unknown as import("vscode").Position,
    ) as unknown as MockHover | undefined;
    expect(entityHover).toBeDefined();
    expect(entityHover!.contents.value).toContain("@BaseEntity<string>");
    expect(entityHover!.contents.value).toContain("id: string");
    expect(entityHover!.contents.value).toContain("createdAt: Date");
    expect(entityHover!.contents.value).toContain("deletedAt?: Date \\| null");

    // 5. SQL Hover on findAllByCreatedAtAfter compiles to `"created_at" > ?`
    const sqlHover = hoverProvider.provideHover(
      createMockTextDocument(repoPath, repoSrc) as unknown as import("vscode").TextDocument,
      new MockPosition(7, 15) as unknown as import("vscode").Position,
    ) as unknown as MockHover | undefined;
    expect(sqlHover).toBeDefined();
    expect(sqlHover!.contents.value).toContain(
      'SELECT * FROM "invoices" WHERE "created_at" > ?',
    );

    // 5b. Delombok expands @BaseEntity<string> into explicit ORM columns
    const codeActionsProvider = new BunestCodeActionsProvider(index);
    const delombokActions = codeActionsProvider.provideCodeActions(
      createMockTextDocument(entityPath, entitySrc) as unknown as import("vscode").TextDocument,
      new MockRange(4, 0, 4, 20) as unknown as import("vscode").Range,
      { diagnostics: [] } as unknown as import("vscode").CodeActionContext,
    ) as unknown as MockCodeAction[];
    const delombokAct = delombokActions.find((a) => a.title.includes("Delombok"));
    expect(delombokAct).toBeDefined();
    const expanded = delombokAct!.edit!.edits[0]!.text;
    expect(expanded).not.toContain("@BaseEntity");
    expect(expanded).toContain("@Entity()");
    expect(expanded).toContain('@PrimaryGeneratedColumn("uuid")');
    expect(expanded).toContain("id!: string;");
    expect(expanded).toContain("@CreateDateColumn()");
    expect(expanded).toContain("@UpdateDateColumn()");
    expect(expanded).toContain("@DeleteDateColumn()");

    // 6. Changing `<string>` -> `<number>` without saving live-updates `.bunest/types/bunest.d.ts`!
    const liveEdited = entitySrc.replace(
      '@BaseEntity<string>({ tableName: "invoices", idStrategy: "uuid" })',
      '@BaseEntity<number>({ tableName: "invoices" })',
    );
    mockDidChangeDocEmitter.fire({
      document: createMockTextDocument(entityPath, liveEdited),
      contentChanges: [{ text: "number" }],
    });
    await Bun.sleep(60);
    expect(readTextSync(dtsPath)).toContain("id: number;");

    index.dispose();
  });

  it("supports static applyDecorators(...) wrappers and publishes BUNEST_DEC001..005 diagnostics in VS Code", async () => {
    const dir = createTempWorkspace({
      "package.json": JSON.stringify({
        name: "composed-dec-app",
        dependencies: { "@bunest/core": "*", "@bunest/orm": "*" },
      }),
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          target: "ESNext",
          module: "ESNext",
          experimentalDecorators: true,
        },
      }),
      "src/decorators.ts": [
        'import { applyDecorators, Data, Builder } from "@bunest/core";',
        'import { BaseEntity } from "@bunest/orm";',
        "",
        "export function AuditedEntity<Key = number>(table: string) {",
        "  return applyDecorators(BaseEntity<Key>(table), Data(), Builder());",
        "}",
      ].join("\n"),
      "src/product.entity.ts": [
        'import { Column } from "@bunest/orm";',
        'import { AuditedEntity } from "./decorators";',
        "",
        '@AuditedEntity<string>("products")',
        "export class ProductEntity {",
        "  @Column()",
        "  sku!: string;",
        "}",
      ].join("\n"),
      "src/bad.ts": [
        'import { Value, Setter } from "@bunest/core";',
        "",
        "@Value()",
        "@Setter()",
        "export class ConflictingModel {",
        "  label!: string;",
        "}",
      ].join("\n"),
    });

    const productPath = join(dir, "src/product.entity.ts");
    const badPath = join(dir, "src/bad.ts");
    const productSrc = readTextSync(productPath);

    mockWorkspaceFolders = [
      { uri: MockUri.file(dir), name: "composed-dec-app", index: 0 },
    ];
    mockConfigValues = {
      "diagnostics.enabled": true,
      "typegen.live": true,
      "typegen.debounceMs": 10,
    };

    const index = new BunestWorkspaceIndex();
    const diagProvider = new BunestDiagnosticsProvider(index);
    const hoverProvider = new BunestHoverProvider(index);

    await index.initialize();

    // 1. Live typegen includes expanded @BaseEntity<string> + @Data + @Builder from @AuditedEntity
    const dts = readTextSync(join(dir, ".bunest/types/bunest.d.ts"));
    expect(dts).toContain("id: string;");
    expect(dts).toContain("getSku(): string;");

    // 2. Hover on ProductEntity shows expanded members
    const hover = hoverProvider.provideHover(
      createMockTextDocument(productPath, productSrc) as unknown as import("vscode").TextDocument,
      new MockPosition(4, 15) as unknown as import("vscode").Position,
    ) as unknown as MockHover | undefined;
    expect(hover).toBeDefined();
    expect(hover!.contents.value).toContain("id: string");
    expect(hover!.contents.value).toContain("getSku()");

    // 3. Diagnostics provider publishes BUNEST_DEC001 for @Value() + @Setter()
    const badDiags = mockPublishedDiagnostics.get(badPath) ?? [];
    expect(badDiags.some((d) => d.code === "BUNEST_DEC001")).toBe(true);

    diagProvider.dispose();
    index.dispose();
  });
});
