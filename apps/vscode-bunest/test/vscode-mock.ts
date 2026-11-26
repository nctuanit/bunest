import { mock } from "bun:test";

// ============================================================================
// Shared Headless VS Code API Mock (Zero `node:*` imports)
// ============================================================================

export class MockPosition {
  constructor(
    public readonly line: number,
    public readonly character: number,
  ) {}
}

export class MockRange {
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
      this.end = new MockPosition(
        endLine ?? startOrLine,
        endCol ?? Number(endOrCol),
      );
    } else {
      this.start = startOrLine;
      this.end = endOrCol as MockPosition;
    }
  }
}

export class MockLocation {
  constructor(
    public readonly uri: MockUri,
    public readonly range: MockRange,
  ) {}
}

export class MockUri {
  constructor(
    public readonly fsPath: string,
    public readonly scheme = "file",
  ) {}
  static file(p: string): MockUri {
    return new MockUri(p, "file");
  }
  static parse(value: string): MockUri {
    const idx = value.indexOf(":");
    const scheme = idx > 0 ? value.slice(0, idx) : "file";
    return new MockUri(value, scheme);
  }
  toString(): string {
    return this.scheme === "file" ? `file://${this.fsPath}` : this.fsPath;
  }
}

export class MockMarkdownString {
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

export class MockHover {
  constructor(public readonly contents: MockMarkdownString) {}
}

export class MockCodeLens {
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

export class MockCompletionItem {
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

export class MockDiagnostic {
  code?: string | number;
  source?: string;
  constructor(
    public readonly range: MockRange,
    public readonly message: string,
    public readonly severity: number,
  ) {}
}

export class MockWorkspaceEdit {
  readonly edits: Array<{
    readonly kind: "replace" | "insert" | "createFile";
    readonly uri: MockUri;
    readonly rangeOrPos?: MockRange | MockPosition;
    readonly text?: string;
  }> = [];
  replace(uri: MockUri, range: MockRange, newText: string): void {
    this.edits.push({ kind: "replace", uri, rangeOrPos: range, text: newText });
  }
  insert(uri: MockUri, pos: MockPosition, newText: string): void {
    this.edits.push({ kind: "insert", uri, rangeOrPos: pos, text: newText });
  }
  createFile(
    uri: MockUri,
    _options?: { overwrite?: boolean; ignoreIfExists?: boolean },
  ): void {
    this.edits.push({ kind: "createFile", uri });
  }
}

export class MockCodeAction {
  edit?: MockWorkspaceEdit;
  diagnostics?: MockDiagnostic[];
  isPreferred?: boolean;
  constructor(
    public readonly title: string,
    public readonly kind?: string,
  ) {}
}

export class MockEventEmitter<T> {
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

export interface MockTextDocument {
  readonly uri: MockUri;
  readonly languageId: string;
  readonly isDirty: boolean;
  getText(): string;
  lineAt(line: number): { readonly text: string };
  positionAt(offset: number): MockPosition;
  offsetAt(pos: MockPosition): number;
  getWordRangeAtPosition(pos: MockPosition): MockRange | undefined;
}

export function createMockTextDocument(
  filePath: string,
  text: string,
  isDirty = false,
): MockTextDocument {
  const lines = text.split("\n");
  const lineStarts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }

  return {
    uri: MockUri.file(filePath),
    languageId: "typescript",
    isDirty,
    getText: () => text,
    lineAt: (line: number) => ({ text: lines[line] ?? "" }),
    positionAt: (posOffset: number) => {
      const clamped = Math.max(0, Math.min(posOffset, text.length));
      let line = 0;
      for (let i = 0; i < lineStarts.length; i++) {
        if (lineStarts[i]! <= clamped) line = i;
        else break;
      }
      return new MockPosition(
        line,
        Math.max(0, clamped - (lineStarts[line] ?? 0)),
      );
    },
    offsetAt: (pos: MockPosition) =>
      (lineStarts[pos.line] ?? 0) + pos.character,
    getWordRangeAtPosition: (pos: MockPosition) => {
      const lineText = lines[pos.line] ?? "";
      let start = pos.character;
      let end = pos.character;
      while (start > 0 && /[\w$]/.test(lineText[start - 1] ?? "")) start--;
      while (end < lineText.length && /[\w$]/.test(lineText[end] ?? "")) end++;
      if (start === end) return undefined;
      return new MockRange(pos.line, start, pos.line, end);
    },
  };
}

export const vscodeMockState = {
  workspaceFolders: [] as Array<{ uri: MockUri; name: string; index: number }>,
  configValues: {} as Record<string, unknown>,
  openDocuments: [] as MockTextDocument[],
  publishedDiagnostics: new Map<string, MockDiagnostic[]>(),
  didChangeDocEmitter: new MockEventEmitter<{
    readonly document: MockTextDocument;
    readonly contentChanges: ReadonlyArray<{ readonly text: string }>;
  }>(),
  didSaveDocEmitter: new MockEventEmitter<MockTextDocument>(),
  didOpenDocEmitter: new MockEventEmitter<MockTextDocument>(),
  didCloseDocEmitter: new MockEventEmitter<MockTextDocument>(),
};

mock.module("vscode", () => ({
  Position: MockPosition,
  Range: MockRange,
  Location: MockLocation,
  Uri: MockUri,
  MarkdownString: MockMarkdownString,
  Hover: MockHover,
  CodeLens: MockCodeLens,
  TreeItem: class {
    constructor(
      public label: string,
      public collapsibleState?: number,
    ) {}
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class {
    constructor(
      public id: string,
      public color?: unknown,
    ) {}
  },
  ThemeColor: class {
    constructor(public id: string) {}
  },
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
  ViewColumn: { Beside: 2 },
  EventEmitter: MockEventEmitter,
  window: {
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showQuickPick: async () => undefined,
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
  commands: {
    executeCommand: async () => undefined,
  },
  languages: {
    createDiagnosticCollection: () => ({
      clear: () => vscodeMockState.publishedDiagnostics.clear(),
      set: (uri: MockUri, diags: MockDiagnostic[]) => {
        vscodeMockState.publishedDiagnostics.set(uri.fsPath, diags);
      },
      dispose: () => vscodeMockState.publishedDiagnostics.clear(),
    }),
  },
  workspace: {
    get workspaceFolders() {
      return vscodeMockState.workspaceFolders;
    },
    get textDocuments() {
      return vscodeMockState.openDocuments;
    },
    getConfiguration: () => ({
      get: (key: string) => vscodeMockState.configValues[key],
    }),
    createFileSystemWatcher: () => ({
      onDidChange: () => ({ dispose: () => {} }),
      onDidCreate: () => ({ dispose: () => {} }),
      onDidDelete: () => ({ dispose: () => {} }),
      dispose: () => {},
    }),
    onDidSaveTextDocument: (cb: (doc: MockTextDocument) => void) =>
      vscodeMockState.didSaveDocEmitter.event(cb),
    onDidChangeTextDocument: (
      cb: (e: {
        readonly document: MockTextDocument;
        readonly contentChanges: ReadonlyArray<{ readonly text: string }>;
      }) => void,
    ) => vscodeMockState.didChangeDocEmitter.event(cb),
    onDidOpenTextDocument: (cb: (doc: MockTextDocument) => void) =>
      vscodeMockState.didOpenDocEmitter.event(cb),
    onDidCloseTextDocument: (cb: (doc: MockTextDocument) => void) =>
      vscodeMockState.didCloseDocEmitter.event(cb),
    onDidCreateFiles: () => ({ dispose: () => {} }),
    onDidDeleteFiles: () => ({ dispose: () => {} }),
    onDidChangeWorkspaceFolders: () => ({ dispose: () => {} }),
    applyEdit: async () => true,
  },
}));
