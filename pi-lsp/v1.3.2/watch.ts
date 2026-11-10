import { existsSync, realpathSync, watch, type FSWatcher } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const ignored = new Set([".git", ".codegraph", "node_modules", "vendor", ".venv", "__pycache__", "target", "dist", "build"]);
const within = (root: string, path: string) => { const rel = relative(root, path); return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };

/** One native watcher per indexed owner workspace; DB writes never feed back into sync. */
export function createSourceWatchers(deps: { isOwner(person: string): boolean; changed(cwd: string, person: string, files: string[]): void; failed(cwd: string, error: string): void }) {
    const roots = new Map<string, { person: string; watcher: FSWatcher }>();
    let disposed = false;
    const remove = (cwd: string) => { roots.get(cwd)?.watcher.close(); roots.delete(cwd); };
    return {
        ensure(cwd: string, person: string, indexed: boolean): void {
            if (disposed) return;
            if (!indexed || !deps.isOwner(person)) { remove(cwd); return; }
            if (roots.get(cwd)?.person === person) return;
            remove(cwd);
            // Bound OS watch resources when the owner visits many workspaces.
            if (roots.size >= 8) remove(roots.keys().next().value!);
            try {
                if (realpathSync(cwd) !== cwd) throw new Error("Source watcher requires a canonical workspace");
                const watcher = watch(cwd, { recursive: true, persistent: false }, (_event, name) => {
                    if (disposed || !deps.isOwner(person)) { remove(cwd); return; }
                    if (!name) { deps.changed(cwd, person, [cwd]); return; }
                    const parts = String(name).split(/[\\/]/);
                    if (parts.some((part) => ignored.has(part) || part.startsWith(".env"))) return;
                    const file = resolve(cwd, String(name));
                    if (!within(cwd, file)) return;
                    try {
                        // A removed file is checked through its nearest surviving parent.
                        let existing = file;
                        while (!existsSync(existing) && existing !== cwd) existing = dirname(existing);
                        if (!within(cwd, realpathSync(existing))) return;
                        deps.changed(cwd, person, [file]);
                    } catch { /* Disappearing paths are covered by the next query freshness check. */ }
                });
                watcher.on("error", (error) => { remove(cwd); deps.failed(cwd, error.message); });
                roots.set(cwd, { person, watcher });
                deps.failed(cwd, "");
            } catch (error) { deps.failed(cwd, error instanceof Error ? error.message : String(error)); }
        },
        dispose(): void { disposed = true; for (const cwd of roots.keys()) remove(cwd); },
    };
}
