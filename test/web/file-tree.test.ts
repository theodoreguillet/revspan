import { describe, expect, it } from 'vitest';
import { buildFileTree, compareTreePaths, visibleTreeRows, type TreeNode } from '../../src/shared/file-tree.ts';
import { clampFilesWidth, MIN_FILES_WIDTH } from '../../src/web/composables/useResizableWidth.ts';

const item = (path: string) => ({ path });

/** Compact text view of a tree: "dir/" for folders, indented by depth. */
function outline<T extends { path: string }>(nodes: readonly TreeNode<T>[], depth = 0): string[] {
    return nodes.flatMap((node) => (node.kind === 'dir'
        ? [`${'  '.repeat(depth)}${node.name}/`, ...outline(node.children, depth + 1)]
        : [`${'  '.repeat(depth)}${node.name}`]));
}

describe('compareTreePaths', () => {
    it('puts folders before files at each level, like the VS Code explorer', () => {
        const paths = ['src/z.ts', 'README.md', 'src/core/a.ts', 'package.json', 'src/a.ts', 'docs/x.md'];
        expect(paths.sort(compareTreePaths)).toEqual(['docs/x.md', 'src/core/a.ts', 'src/a.ts', 'src/z.ts', 'package.json', 'README.md']);
    });

    it('orders names within a level alphabetically', () => {
        expect(['b/x', 'a/y', 'c'].sort(compareTreePaths)).toEqual(['a/y', 'b/x', 'c']);
    });

    it('is a total order: equal paths compare to 0', () => {
        expect(compareTreePaths('src/a.ts', 'src/a.ts')).toBe(0);
    });
});

describe('buildFileTree', () => {
    it('nests files under their folders, folders first', () => {
        const tree = buildFileTree(['src/web/main.ts', 'package.json', 'src/server/x.ts', 'src/index.ts'].map(item));
        expect(outline(tree)).toEqual(['src/', '  server/', '    x.ts', '  web/', '    main.ts', '  index.ts', 'package.json']);
    });

    it('merges chains of single-folder folders (compact folders)', () => {
        const tree = buildFileTree(['src/server/core/a.ts', 'src/server/core/b.ts', 'README.md'].map(item));
        expect(outline(tree)).toEqual(['src/server/core/', '  a.ts', '  b.ts', 'README.md']);
        expect(tree[0]).toMatchObject({ kind: 'dir', path: 'src/server/core' });
    });

    it('does not merge a folder that also holds files', () => {
        const tree = buildFileTree(['src/a.ts', 'src/core/b.ts'].map(item));
        expect(outline(tree)).toEqual(['src/', '  core/', '    b.ts', '  a.ts']);
    });

    it('keeps the items and their order in the leaves', () => {
        const items = ['b/2.ts', 'a/1.ts', 'c.ts'].map(item);
        const leaves = visibleTreeRows(buildFileTree(items), () => false).filter((r) => r.kind === 'file').map((r) => r.item);
        expect(leaves).toEqual([items[1], items[0], items[2]]);
    });

    it('builds an empty tree from no file', () => {
        expect(buildFileTree([])).toEqual([]);
    });
});

describe('visibleTreeRows', () => {
    const tree = buildFileTree(['src/core/a.ts', 'src/b.ts', 'c.ts'].map(item));

    it('lists every row with its depth when nothing is collapsed', () => {
        const rows = visibleTreeRows(tree, () => false);
        expect(rows.map((r) => `${r.depth}:${r.kind === 'dir' ? `${r.dir.name}/` : r.item.path}`)).toEqual([
            '0:src/', '1:core/', '2:src/core/a.ts', '1:src/b.ts', '0:c.ts',
        ]);
    });

    it('hides the content of a collapsed folder and gives its files for the summary', () => {
        const rows = visibleTreeRows(tree, (path) => path === 'src');
        expect(rows.map((r) => (r.kind === 'dir' ? `${r.dir.path}/ collapsed=${r.collapsed}` : r.item.path))).toEqual(['src/ collapsed=true', 'c.ts']);
        const src = rows[0]!;
        expect(src.kind === 'dir' && src.files.map((f) => f.path)).toEqual(['src/core/a.ts', 'src/b.ts']);
    });
});

describe('clampFilesWidth', () => {
    it('keeps the width between the minimum and half of the viewport', () => {
        expect(clampFilesWidth(100, 1600)).toBe(MIN_FILES_WIDTH);
        expect(clampFilesWidth(420.6, 1600)).toBe(421);
        expect(clampFilesWidth(1200, 1600)).toBe(800);
    });

    it('never goes under the minimum, even on a tiny viewport', () => {
        expect(clampFilesWidth(500, 200)).toBe(MIN_FILES_WIDTH);
    });
});
