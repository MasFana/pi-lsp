
export type PositionEncoding = "utf-8" | "utf-16" | "utf-32";
export interface Position { line: number; character: number }
export interface TextEdit { range: { start: Position; end: Position }; newText: string }
export interface FileEdits { file: string; edits: TextEdit[]; encoding?: PositionEncoding; version?: number | null }
export interface ByteEdit { start: number; end: number; replacement: string }
export interface FileByteEdits { file: string; edits: ByteEdit[] }
export interface ProviderStatus {
    id: "ast-grep" | "codegraph";
    available: boolean;
    executable?: string;
    version?: string;
    compatible?: boolean;
    provenance?: string;
    error?: string;
    actions: string[];
    checkedAt?: number;
    [key: string]: unknown;
}
export interface ExecutionResult { stdout: string; stderr: string; exitCode: number; truncated: boolean }
export interface ProviderRuntime {
    findExecutable(command: string, cwd: string): string | undefined;
    run(executable: string, args: string[], options: { cwd: string; signal?: AbortSignal; timeout?: number; maxBytes?: number; env?: Record<string, string | undefined> }): Promise<ExecutionResult>;
    assertOwner(): void;
}
export interface ProviderQueryResult {
    status: "ok" | "empty" | "unsupported" | "unavailable";
    items?: unknown[];
    total?: number;
    truncated?: boolean;
    message?: string;
    fileEdits?: FileEdits[];
    byteEdits?: FileByteEdits[];
    [key: string]: unknown;
}
export interface AstQuery {
    action: "search" | "outline" | "rewrite_preview";
    paths: string[];
    lang?: string;
    pattern?: string;
    rule?: string;
    ops?: { pat: string; out: string }[];
    maxResults?: number;
    maxFiles?: number;
    maxReplacements?: number;
}
export interface GraphQuery {
    action: "explore" | "callers" | "callees" | "impact" | "affected_tests";
    query?: string;
    symbol?: string;
    file?: string;
    depth?: number;
    maxResults?: number;
    generation?: string;
}
export interface GraphOperation { action: "create" | "sync" | "rebuild" | "refresh" }
