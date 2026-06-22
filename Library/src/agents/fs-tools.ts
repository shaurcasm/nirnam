import type { ToolDefinition } from './types';

// Resolve a slash-delimited relative path against a root handle.
// Rejects paths that escape the root (leading /, or .. segments).
async function resolveDir(
  root: FileSystemDirectoryHandle,
  dirPath: string,
  create = false,
): Promise<FileSystemDirectoryHandle> {
  const parts = dirPath.split('/').filter(p => p && p !== '.');
  if (parts.some(p => p === '..')) {
    throw new Error(`[NirnamAgent] Path traversal not allowed: "${dirPath}"`);
  }
  let current = root;
  for (const part of parts) {
    current = await current.getDirectoryHandle(part, { create });
  }
  return current;
}

async function resolveFile(
  root: FileSystemDirectoryHandle,
  filePath: string,
  create = false,
): Promise<FileSystemFileHandle> {
  const parts = filePath.split('/').filter(p => p && p !== '.');
  if (parts.some(p => p === '..')) {
    throw new Error(`[NirnamAgent] Path traversal not allowed: "${filePath}"`);
  }
  const fileName = parts.pop()!;
  let dir = root;
  if (parts.length > 0) {
    dir = await resolveDir(root, parts.join('/'), create);
  }
  return dir.getFileHandle(fileName, { create });
}

export function buildFilesystemTools(
  getHandle: () => FileSystemDirectoryHandle | null,
): ToolDefinition[] {
  function requireHandle(): FileSystemDirectoryHandle {
    const handle = getHandle();
    if (!handle) throw new Error('[NirnamAgent] No folder access granted. Call agent.requestFolderAccess() first.');
    return handle;
  }

  return [
    {
      name: 'read_file',
      description: 'Read the text content of a file relative to the granted folder root.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path, e.g. "src/App.tsx"' },
        },
        required: ['path'],
      },
      async execute(args) {
        const root = requireHandle();
        const handle = await resolveFile(root, args.path as string);
        const file = await handle.getFile();
        return file.text();
      },
    },

    {
      name: 'write_file',
      description: 'Write text content to a file. Creates the file and any missing parent directories.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path' },
          content: { type: 'string', description: 'Text to write' },
        },
        required: ['path', 'content'],
      },
      async execute(args) {
        const root = requireHandle();
        const handle = await resolveFile(root, args.path as string, true);
        const writable = await handle.createWritable();
        await writable.write(args.content as string);
        await writable.close();
        return `Written ${(args.content as string).length} chars to "${args.path as string}".`;
      },
    },

    {
      name: 'list_directory',
      description: 'List files and sub-directories inside a directory relative to the granted root.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative directory path. Use "" or "." for the root.' },
        },
        required: ['path'],
      },
      async execute(args) {
        const root = requireHandle();
        const pathStr = (args.path as string) || '.';
        const dir = pathStr === '.' || pathStr === ''
          ? root
          : await resolveDir(root, pathStr);
        const entries: string[] = [];
        for await (const [name, handle] of (dir as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
          entries.push(handle.kind === 'directory' ? `${name}/` : name);
        }
        return entries.sort().join('\n') || '(empty directory)';
      },
    },

    {
      name: 'create_directory',
      description: 'Create a directory (and any missing parents) relative to the granted root.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative directory path to create' },
        },
        required: ['path'],
      },
      async execute(args) {
        const root = requireHandle();
        await resolveDir(root, args.path as string, true);
        return `Directory "${args.path as string}" created.`;
      },
    },

    {
      name: 'delete_file',
      description: 'Delete a file at the given path relative to the granted root.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path to delete' },
        },
        required: ['path'],
      },
      async execute(args) {
        const root = requireHandle();
        const parts = (args.path as string).split('/').filter(p => p && p !== '.' && p !== '..');
        const fileName = parts.pop()!;
        const dir = parts.length > 0 ? await resolveDir(root, parts.join('/')) : root;
        await dir.removeEntry(fileName);
        return `Deleted "${args.path as string}".`;
      },
    },

    {
      name: 'move_file',
      description: 'Move or rename a file within the granted folder.',
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Source relative path' },
          to: { type: 'string', description: 'Destination relative path' },
        },
        required: ['from', 'to'],
      },
      async execute(args) {
        const root = requireHandle();
        // Read source, write to dest, delete source
        const srcHandle = await resolveFile(root, args.from as string);
        const srcFile = await srcHandle.getFile();
        const content = await srcFile.text();

        const dstHandle = await resolveFile(root, args.to as string, true);
        const writable = await dstHandle.createWritable();
        await writable.write(content);
        await writable.close();

        // Remove source
        const srcParts = (args.from as string).split('/').filter(p => p && p !== '.');
        const srcName = srcParts.pop()!;
        const srcDir = srcParts.length > 0 ? await resolveDir(root, srcParts.join('/')) : root;
        await srcDir.removeEntry(srcName);

        return `Moved "${args.from as string}" to "${args.to as string}".`;
      },
    },
  ];
}
