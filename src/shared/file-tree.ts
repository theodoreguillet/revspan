// Folder tree of a diff's files, in the VS Code explorer's order (folders first at each level, then by name),
// with compact folders: a chain of folders that each hold a single folder shows as one row ("src/server/core").
// Shared by the server (diff order) and the page (file list), so that both follow the same order.

export interface TreeDir<T> {
    kind: 'dir';
    /** Full path of the deepest folder of the chain: stable key of the row. */
    path: string;
    /** Displayed name: one folder, or a compact chain "a/b/c". */
    name: string;
    children: TreeNode<T>[];
}

export interface TreeFile<T> {
    kind: 'file';
    path: string;
    name: string;
    item: T;
}

export type TreeNode<T> = TreeDir<T> | TreeFile<T>;

export type TreeRow<T> =
    | { kind: 'dir'; depth: number; dir: TreeDir<T>; collapsed: boolean; files: T[] }
    | { kind: 'file'; depth: number; item: T };

function compareNames(a: string, b: string): number {
    return a.localeCompare(b) || (a < b ? -1 : a > b ? 1 : 0);
}

/** Explorer order of two file paths: at the first differing level, a folder comes before a file, then by name. */
export function compareTreePaths(a: string, b: string): number {
    const as = a.split('/');
    const bs = b.split('/');
    for (let i = 0; i < Math.min(as.length, bs.length); i++) {
        if (as[i] === bs[i]) {
            continue;
        }
        const aDir = i < as.length - 1;
        const bDir = i < bs.length - 1;
        if (aDir !== bDir) {
            return aDir ? -1 : 1;
        }
        return compareNames(as[i]!, bs[i]!);
    }
    return as.length - bs.length;
}

function compareNodes<T>(a: TreeNode<T>, b: TreeNode<T>): number {
    if (a.kind !== b.kind) {
        return a.kind === 'dir' ? -1 : 1;
    }
    return compareNames(a.name, b.name);
}

function sortAndCompact<T>(nodes: TreeNode<T>[]): TreeNode<T>[] {
    return nodes.sort(compareNodes).map((node) => {
        if (node.kind === 'file') {
            return node;
        }
        let dir = node;
        let only = dir.children.length === 1 ? dir.children[0] : undefined;
        while (only?.kind === 'dir') {
            dir = { kind: 'dir', path: only.path, name: `${dir.name}/${only.name}`, children: only.children };
            only = dir.children.length === 1 ? dir.children[0] : undefined;
        }
        return { ...dir, children: sortAndCompact(dir.children) };
    });
}

export function buildFileTree<T extends { path: string }>(items: readonly T[]): TreeNode<T>[] {
    const root: TreeNode<T>[] = [];
    const dirs = new Map<string, TreeDir<T>>();
    for (const item of items) {
        const parts = item.path.split('/');
        let level = root;
        for (let i = 0; i < parts.length - 1; i++) {
            const path = parts.slice(0, i + 1).join('/');
            let dir = dirs.get(path);
            if (!dir) {
                dir = { kind: 'dir', path, name: parts[i]!, children: [] };
                dirs.set(path, dir);
                level.push(dir);
            }
            level = dir.children;
        }
        level.push({ kind: 'file', path: item.path, name: parts[parts.length - 1]!, item });
    }
    return sortAndCompact(root);
}

function filesOf<T>(dir: TreeDir<T>): T[] {
    return dir.children.flatMap((node) => (node.kind === 'file' ? [node.item] : filesOf(node)));
}

/** Rows to display: the content of the collapsed folders (by folder path) is left out. */
export function visibleTreeRows<T>(nodes: readonly TreeNode<T>[], isCollapsed: (path: string) => boolean, depth = 0): TreeRow<T>[] {
    return nodes.flatMap((node): TreeRow<T>[] => {
        if (node.kind === 'file') {
            return [{ kind: 'file', depth, item: node.item }];
        }
        const collapsed = isCollapsed(node.path);
        const row: TreeRow<T> = { kind: 'dir', depth, dir: node, collapsed, files: filesOf(node) };
        return collapsed ? [row] : [row, ...visibleTreeRows(node.children, isCollapsed, depth + 1)];
    });
}
