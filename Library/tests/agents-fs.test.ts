/**
 * Unit tests for agents/fs-tools.ts.
 *
 * All FileSystem Access API calls are replaced with minimal in-memory mock handles.
 * Tests cover all 6 tools (read_file, write_file, list_directory, create_directory,
 * delete_file, move_file) plus path traversal protection.
 */

jest.mock('../src/worker-source', () => ({ default: '/* mock worker script */' }));

import { buildFilesystemTools } from '../src/agents/fs-tools';
import type { ToolDefinition } from '../src/agents/types';

// ---- In-memory FileSystem mock ----------------------------------------------

interface FakeFile {
  kind: 'file';
  name: string;
  content: string;
}

interface FakeDir {
  kind: 'directory';
  name: string;
  children: Map<string, FakeFile | FakeDir>;
}

function makeFakeFile(name: string, content = ''): FakeFile {
  return { kind: 'file', name, content };
}

function makeFakeDir(name: string, children: (FakeFile | FakeDir)[] = []): FakeDir {
  return {
    kind: 'directory',
    name,
    children: new Map(children.map(c => [c.name, c])),
  };
}

function createFileHandle(file: FakeFile): FileSystemFileHandle {
  return {
    kind: 'file',
    name: file.name,
    getFile: jest.fn(async () => ({
      text: jest.fn(async () => file.content),
    })),
    createWritable: jest.fn(async () => {
      let accumulated = '';
      return {
        write: jest.fn(async (data: string) => { accumulated += data; }),
        close: jest.fn(async () => { file.content = accumulated; }),
      };
    }),
  } as unknown as FileSystemFileHandle;
}

function createDirHandle(dir: FakeDir): FileSystemDirectoryHandle {
  const handle: FileSystemDirectoryHandle = {
    kind: 'directory',
    name: dir.name,
    getFileHandle: jest.fn(async (name: string, opts?: { create?: boolean }) => {
      let entry = dir.children.get(name);
      if (!entry || entry.kind !== 'file') {
        if (!opts?.create) throw new DOMException(`${name} not found`, 'NotFoundError');
        const newFile = makeFakeFile(name);
        dir.children.set(name, newFile);
        entry = newFile;
      }
      return createFileHandle(entry as FakeFile);
    }),
    getDirectoryHandle: jest.fn(async (name: string, opts?: { create?: boolean }) => {
      let entry = dir.children.get(name);
      if (!entry || entry.kind !== 'directory') {
        if (!opts?.create) throw new DOMException(`${name} not found`, 'NotFoundError');
        const newDir = makeFakeDir(name);
        dir.children.set(name, newDir);
        entry = newDir;
      }
      return createDirHandle(entry as FakeDir);
    }),
    removeEntry: jest.fn(async (name: string) => {
      dir.children.delete(name);
    }),
    [Symbol.asyncIterator]: async function* () {
      for (const [name, entry] of dir.children) {
        yield [name, { kind: entry.kind, name }] as [string, { kind: string; name: string }];
      }
    },
  } as unknown as FileSystemDirectoryHandle;

  return handle;
}

// ---- Helpers ----------------------------------------------------------------

function getTools(root: FileSystemDirectoryHandle): Record<string, ToolDefinition> {
  const tools = buildFilesystemTools(() => root);
  return Object.fromEntries(tools.map(t => [t.name, t]));
}

function getToolsWithNullHandle(): Record<string, ToolDefinition> {
  const tools = buildFilesystemTools(() => null);
  return Object.fromEntries(tools.map(t => [t.name, t]));
}

// ---- Tests ------------------------------------------------------------------

describe('buildFilesystemTools()', () => {
  it('returns exactly 6 tools', () => {
    const root = createDirHandle(makeFakeDir('root'));
    expect(buildFilesystemTools(() => root)).toHaveLength(6);
  });

  it('all tools have a name, description, inputSchema, and execute', () => {
    const root = createDirHandle(makeFakeDir('root'));
    for (const tool of buildFilesystemTools(() => root)) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema.type).toBe('object');
      expect(typeof tool.execute).toBe('function');
    }
  });
});

describe('read_file', () => {
  it('reads and returns file content', async () => {
    const dir = makeFakeDir('root', [makeFakeFile('hello.txt', 'hello world')]);
    const tools = getTools(createDirHandle(dir));
    const result = await tools['read_file'].execute({ path: 'hello.txt' });
    expect(result).toBe('hello world');
  });

  it('reads a nested file via sub-directory', async () => {
    const inner = makeFakeDir('src', [makeFakeFile('App.tsx', 'export default App;')]);
    const dir = makeFakeDir('root', [inner]);
    const tools = getTools(createDirHandle(dir));
    const result = await tools['read_file'].execute({ path: 'src/App.tsx' });
    expect(result).toBe('export default App;');
  });

  it('throws on path traversal', async () => {
    const dir = makeFakeDir('root');
    const tools = getTools(createDirHandle(dir));
    await expect(tools['read_file'].execute({ path: '../secret.txt' })).rejects.toThrow(/Path traversal/);
  });

  it('throws when handle is null', async () => {
    const tools = getToolsWithNullHandle();
    await expect(tools['read_file'].execute({ path: 'a.txt' })).rejects.toThrow(/No folder access/);
  });
});

describe('write_file', () => {
  it('writes content and returns byte count message', async () => {
    const dir = makeFakeDir('root');
    const tools = getTools(createDirHandle(dir));
    const result = await tools['write_file'].execute({ path: 'new.txt', content: 'hello!' });
    expect(result).toContain('6');  // 6 chars in 'hello!'
    expect(result).toContain('new.txt');
  });

  it('creates the file if it does not exist', async () => {
    const dir = makeFakeDir('root');
    const handle = createDirHandle(dir);
    const tools = getTools(handle);
    await tools['write_file'].execute({ path: 'created.txt', content: 'new' });
    expect(dir.children.has('created.txt')).toBe(true);
  });

  it('overwrites existing file content', async () => {
    const file = makeFakeFile('a.txt', 'original');
    const dir = makeFakeDir('root', [file]);
    const tools = getTools(createDirHandle(dir));
    await tools['write_file'].execute({ path: 'a.txt', content: 'updated' });
    expect(file.content).toBe('updated');
  });

  it('throws on path traversal', async () => {
    const dir = makeFakeDir('root');
    const tools = getTools(createDirHandle(dir));
    await expect(tools['write_file'].execute({ path: '../evil.txt', content: 'x' })).rejects.toThrow(/Path traversal/);
  });

  it('throws when handle is null', async () => {
    const tools = getToolsWithNullHandle();
    await expect(tools['write_file'].execute({ path: 'a.txt', content: 'x' })).rejects.toThrow(/No folder access/);
  });
});

describe('list_directory', () => {
  it('lists files and subdirectories in root', async () => {
    const dir = makeFakeDir('root', [
      makeFakeFile('a.txt'),
      makeFakeDir('src'),
    ]);
    const tools = getTools(createDirHandle(dir));
    const result = await tools['list_directory'].execute({ path: '' });
    expect(result).toContain('a.txt');
    expect(result).toContain('src/');
  });

  it('uses "." to list root', async () => {
    const dir = makeFakeDir('root', [makeFakeFile('readme.md', '')]);
    const tools = getTools(createDirHandle(dir));
    const result = await tools['list_directory'].execute({ path: '.' });
    expect(result).toContain('readme.md');
  });

  it('lists contents of a named subdirectory', async () => {
    const inner = makeFakeDir('lib', [makeFakeFile('util.ts')]);
    const dir = makeFakeDir('root', [inner]);
    const tools = getTools(createDirHandle(dir));
    const result = await tools['list_directory'].execute({ path: 'lib' });
    expect(result).toContain('util.ts');
  });

  it('returns "(empty directory)" for empty dirs', async () => {
    const dir = makeFakeDir('root');
    const tools = getTools(createDirHandle(dir));
    const result = await tools['list_directory'].execute({ path: '' });
    expect(result).toBe('(empty directory)');
  });

  it('returns entries sorted alphabetically', async () => {
    const dir = makeFakeDir('root', [
      makeFakeFile('z.txt'),
      makeFakeFile('a.txt'),
      makeFakeFile('m.txt'),
    ]);
    const tools = getTools(createDirHandle(dir));
    const result = await tools['list_directory'].execute({ path: '' });
    const lines = result.split('\n');
    expect(lines).toEqual([...lines].sort());
  });

  it('throws on path traversal', async () => {
    const dir = makeFakeDir('root');
    const tools = getTools(createDirHandle(dir));
    await expect(tools['list_directory'].execute({ path: '../secret' })).rejects.toThrow(/Path traversal/);
  });

  it('throws when handle is null', async () => {
    const tools = getToolsWithNullHandle();
    await expect(tools['list_directory'].execute({ path: '' })).rejects.toThrow(/No folder access/);
  });
});

describe('create_directory', () => {
  it('creates a directory and returns confirmation', async () => {
    const dir = makeFakeDir('root');
    const tools = getTools(createDirHandle(dir));
    const result = await tools['create_directory'].execute({ path: 'components' });
    expect(result).toContain('components');
    expect(dir.children.has('components')).toBe(true);
  });

  it('creates nested directories', async () => {
    const inner = makeFakeDir('src');
    const dir = makeFakeDir('root', [inner]);
    const tools = getTools(createDirHandle(dir));
    await tools['create_directory'].execute({ path: 'src/utils' });
    expect(inner.children.has('utils')).toBe(true);
  });

  it('throws on path traversal', async () => {
    const dir = makeFakeDir('root');
    const tools = getTools(createDirHandle(dir));
    await expect(tools['create_directory'].execute({ path: '../escape' })).rejects.toThrow(/Path traversal/);
  });

  it('throws when handle is null', async () => {
    const tools = getToolsWithNullHandle();
    await expect(tools['create_directory'].execute({ path: 'new' })).rejects.toThrow(/No folder access/);
  });
});

describe('delete_file', () => {
  it('deletes a file at the root level', async () => {
    const dir = makeFakeDir('root', [makeFakeFile('trash.txt')]);
    const tools = getTools(createDirHandle(dir));
    const result = await tools['delete_file'].execute({ path: 'trash.txt' });
    expect(result).toContain('trash.txt');
    expect(dir.children.has('trash.txt')).toBe(false);
  });

  it('deletes a nested file', async () => {
    const inner = makeFakeDir('sub', [makeFakeFile('old.ts')]);
    const dir = makeFakeDir('root', [inner]);
    const tools = getTools(createDirHandle(dir));
    await tools['delete_file'].execute({ path: 'sub/old.ts' });
    expect(inner.children.has('old.ts')).toBe(false);
  });

  it('throws when handle is null', async () => {
    const tools = getToolsWithNullHandle();
    await expect(tools['delete_file'].execute({ path: 'a.txt' })).rejects.toThrow(/No folder access/);
  });
});

describe('move_file', () => {
  it('moves a file from source to destination', async () => {
    const file = makeFakeFile('old.txt', 'content here');
    const dir = makeFakeDir('root', [file]);
    const tools = getTools(createDirHandle(dir));
    const result = await tools['move_file'].execute({ from: 'old.txt', to: 'new.txt' });
    expect(result).toContain('old.txt');
    expect(result).toContain('new.txt');
    // Source deleted, destination created
    expect(dir.children.has('old.txt')).toBe(false);
    expect(dir.children.has('new.txt')).toBe(true);
    expect((dir.children.get('new.txt') as FakeFile | undefined)?.content).toBe('content here');
  });

  it('throws on path traversal in "from"', async () => {
    const dir = makeFakeDir('root', [makeFakeFile('a.txt')]);
    const tools = getTools(createDirHandle(dir));
    await expect(tools['move_file'].execute({ from: '../a.txt', to: 'b.txt' })).rejects.toThrow(/Path traversal/);
  });

  it('throws when handle is null', async () => {
    const tools = getToolsWithNullHandle();
    await expect(tools['move_file'].execute({ from: 'a.txt', to: 'b.txt' })).rejects.toThrow(/No folder access/);
  });
});
