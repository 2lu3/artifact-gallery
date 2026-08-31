import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

const readFileFault = vi.hoisted(() => ({
  path: undefined as string | undefined,
  beforeRead: undefined as (() => Promise<void>) | undefined,
}));
const readDirectoryFault = vi.hoisted(() => ({
  path: undefined as string | undefined,
  beforeRead: undefined as (() => Promise<void>) | undefined,
  afterRead: undefined as (() => Promise<void>) | undefined,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      if (String(args[0]) === readFileFault.path) {
        const beforeRead = readFileFault.beforeRead;
        readFileFault.path = undefined;
        readFileFault.beforeRead = undefined;
        await beforeRead?.();
      }
      return Reflect.apply(actual.readFile, actual, args);
    },
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      const matchesFault = String(args[0]) === readDirectoryFault.path;
      const beforeRead = matchesFault ? readDirectoryFault.beforeRead : undefined;
      const afterRead = matchesFault ? readDirectoryFault.afterRead : undefined;
      if (matchesFault) {
        readDirectoryFault.path = undefined;
        readDirectoryFault.beforeRead = undefined;
        readDirectoryFault.afterRead = undefined;
      }
      await beforeRead?.();
      const entries = await Reflect.apply(actual.readdir, actual, args);
      await afterRead?.();
      return entries;
    },
  };
});

import { PathPolicy } from '../../src/server/security/path-policy.js';

const temporaryDirectories: string[] = [];

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'artifact-gallery-path-policy-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  readFileFault.path = undefined;
  readFileFault.beforeRead = undefined;
  readDirectoryFault.path = undefined;
  readDirectoryFault.beforeRead = undefined;
  readDirectoryFault.afterRead = undefined;
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('PathPolicy', () => {
  test('normalizes a missing allowed root during policy creation', async () => {
    const parent = await makeTemporaryDirectory();
    const missingRoot = join(parent, 'missing-root');

    await expect(PathPolicy.create([missingRoot])).rejects.toMatchObject({
      name: 'PathPolicyError',
      code: 'SOURCE_MISSING',
      sourcePath: missingRoot,
    });
  });

  test('normalizes a missing allowed root during missing-path validation', async () => {
    const root = await makeTemporaryDirectory();
    const missing = join(root, 'missing.html');
    const policy = await PathPolicy.create([root]);
    await rm(root, { recursive: true });

    await expect(policy.validateMissingPath(missing)).rejects.toMatchObject({
      name: 'PathPolicyError',
      code: 'SOURCE_MISSING',
      sourcePath: missing,
    });
  });

  test('authorizes and reads a supported file inside an allowed root', async () => {
    const root = await makeTemporaryDirectory();
    const source = join(root, 'artifact.HTML');
    await writeFile(source, '<h1>Artifact</h1>');

    const policy = await PathPolicy.create([root]);
    const authorized = await policy.authorizeFile(source);

    expect(authorized.canonicalPath).toBe(await realpath(source));
    await expect(authorized.read('utf8')).resolves.toBe('<h1>Artifact</h1>');
  });

  test('rejects a file outside the allowed root, including a sibling with the same prefix', async () => {
    const parent = await makeTemporaryDirectory();
    const root = join(parent, 'allowed');
    const sibling = join(parent, 'allowed-sibling');
    await mkdir(root);
    await mkdir(sibling);
    const outside = join(sibling, 'artifact.html');
    await writeFile(outside, '<h1>Outside</h1>');

    const policy = await PathPolicy.create([root]);

    await expect(policy.authorizeFile(outside)).rejects.toMatchObject({
      code: 'OUTSIDE_ALLOWED_ROOT',
    });
  });

  test('rejects traversal components even when they resolve inside the allowed root', async () => {
    const root = await makeTemporaryDirectory();
    await mkdir(join(root, 'nested'));
    await writeFile(join(root, 'artifact.html'), '<h1>Artifact</h1>');
    const traversingPath = [root, 'nested', '..', 'artifact.html'].join(sep);

    const policy = await PathPolicy.create([root]);

    await expect(policy.authorizeFile(traversingPath)).rejects.toMatchObject({
      code: 'OUTSIDE_ALLOWED_ROOT',
    });
  });

  test('rejects symlinks at the file or directory path component', async () => {
    const root = await makeTemporaryDirectory();
    const outside = await makeTemporaryDirectory();
    const actualDirectory = join(root, 'actual');
    await mkdir(actualDirectory);
    const actualFile = join(actualDirectory, 'artifact.html');
    await writeFile(actualFile, '<h1>Artifact</h1>');
    const linkedDirectory = join(root, 'linked-directory');
    const linkedFile = join(root, 'linked-file.html');
    const enteringLink = join(outside, 'entering-link.html');
    await symlink(actualDirectory, linkedDirectory, 'dir');
    await symlink(actualFile, linkedFile, 'file');
    await symlink(actualFile, enteringLink, 'file');
    const policy = await PathPolicy.create([root]);

    for (const source of [join(linkedDirectory, 'artifact.html'), linkedFile, enteringLink]) {
      await expect(policy.authorizeFile(source)).rejects.toMatchObject({
        code: 'SYMLINK_REJECTED',
      });
    }
  });

  test('rejects hidden files and hidden directory path components', async () => {
    const root = await makeTemporaryDirectory();
    const hiddenDirectory = join(root, '.hidden');
    await mkdir(hiddenDirectory);
    const nestedHidden = join(hiddenDirectory, 'artifact.html');
    const hiddenFile = join(root, '.artifact.html');
    await writeFile(nestedHidden, '<h1>Nested</h1>');
    await writeFile(hiddenFile, '<h1>Hidden</h1>');
    const policy = await PathPolicy.create([root]);

    for (const source of [nestedHidden, hiddenFile]) {
      await expect(policy.authorizeFile(source)).rejects.toMatchObject({
        code: 'UNREADABLE_SOURCE',
      });
    }
  });

  test('accepts html, htm, and markdown extensions case-insensitively and rejects others', async () => {
    const root = await makeTemporaryDirectory();
    const supported = ['page.HTML', 'page.htm', 'page.Md'];
    for (const name of supported) {
      await writeFile(join(root, name), name);
    }
    const unsupported = join(root, 'page.txt');
    await writeFile(unsupported, 'unsupported');
    const policy = await PathPolicy.create([root]);

    for (const name of supported) {
      await expect(policy.authorizeFile(join(root, name))).resolves.toMatchObject({
        canonicalPath: await realpath(join(root, name)),
      });
    }
    await expect(policy.authorizeFile(unsupported)).rejects.toMatchObject({
      code: 'UNSUPPORTED_FORMAT',
    });
  });

  test('rejects a directory where a file is required', async () => {
    const root = await makeTemporaryDirectory();
    const directory = join(root, 'directory.html');
    await mkdir(directory);
    const policy = await PathPolicy.create([root]);

    await expect(policy.authorizeFile(directory)).rejects.toMatchObject({
      code: 'UNREADABLE_SOURCE',
    });
  });

  test('authorizes directories and rejects a file where a directory is required', async () => {
    const root = await makeTemporaryDirectory();
    const directory = join(root, 'artifacts');
    const file = join(root, 'artifact.html');
    await mkdir(directory);
    await writeFile(file, '<h1>Artifact</h1>');
    const policy = await PathPolicy.create([root]);

    await expect(policy.authorizeDirectory(directory)).resolves.toEqual({
      canonicalPath: await realpath(directory),
    });
    await expect(policy.authorizeDirectory(file)).rejects.toMatchObject({
      code: 'UNREADABLE_SOURCE',
    });
  });

  test('rejects an unreadable directory with a normalized error', async () => {
    const root = await makeTemporaryDirectory();
    const directory = join(root, 'unreadable');
    await mkdir(directory);
    const policy = await PathPolicy.create([root]);

    const authorization = (async () => {
      await chmod(directory, 0o000);
      try {
        return await policy.authorizeDirectory(directory);
      } finally {
        await chmod(directory, 0o755);
      }
    })();

    await expect(authorization).rejects.toMatchObject({
      name: 'PathPolicyError',
      code: 'UNREADABLE_SOURCE',
      sourcePath: directory,
    });
  });

  test('validates a missing path without granting read authority', async () => {
    const root = await makeTemporaryDirectory();
    const missing = join(root, 'missing.html');
    const policy = await PathPolicy.create([root]);

    await expect(policy.validateMissingPath(missing)).resolves.toEqual({
      normalizedPath: join(await realpath(root), 'missing.html'),
    });
    await expect(policy.authorizeFile(missing)).rejects.toMatchObject({
      code: 'SOURCE_MISSING',
    });
  });

  test('rejects hidden components and unsupported extensions in missing paths', async () => {
    const root = await makeTemporaryDirectory();
    const policy = await PathPolicy.create([root]);

    await expect(
      policy.validateMissingPath(join(root, 'absent', '.hidden', 'artifact.html')),
    ).rejects.toMatchObject({ code: 'UNREADABLE_SOURCE' });
    await expect(policy.validateMissingPath(join(root, 'artifact.txt'))).rejects.toMatchObject({
      code: 'UNSUPPORTED_FORMAT',
    });
  });

  test('enumerates supported files recursively', async () => {
    const root = await makeTemporaryDirectory();
    const folder = join(root, 'artifacts');
    const nested = join(folder, 'nested');
    await mkdir(nested, { recursive: true });
    const topLevel = join(folder, 'index.html');
    const nestedFile = join(nested, 'notes.md');
    await writeFile(topLevel, '<h1>Index</h1>');
    await writeFile(nestedFile, '# Notes');
    const policy = await PathPolicy.create([root]);

    const result = await policy.enumerateFolder(folder);

    expect(result.files.map((file) => file.canonicalPath)).toEqual([
      await realpath(topLevel),
      await realpath(nestedFile),
    ]);
    expect(result.errors).toEqual([]);
  });

  test('does not follow symlinks during enumeration and reports the item error', async () => {
    const root = await makeTemporaryDirectory();
    const outside = await makeTemporaryDirectory();
    const folder = join(root, 'artifacts');
    await mkdir(folder);
    const safeFile = join(folder, 'safe.html');
    await writeFile(safeFile, '<h1>Safe</h1>');
    await writeFile(join(outside, 'outside.html'), '<h1>Outside</h1>');
    const linkedDirectory = join(folder, 'linked');
    await symlink(outside, linkedDirectory, 'dir');
    const policy = await PathPolicy.create([root]);

    const result = await policy.enumerateFolder(folder);

    expect(result.files.map((file) => file.canonicalPath)).toEqual([await realpath(safeFile)]);
    expect(result.errors).toEqual([
      { path: join(await realpath(folder), 'linked'), code: 'SYMLINK_REJECTED' },
    ]);
  });

  test('continues enumeration after an unreadable item and reports its error', async () => {
    const root = await makeTemporaryDirectory();
    const folder = join(root, 'artifacts');
    await mkdir(folder);
    const unreadable = join(folder, 'a-unreadable.html');
    const readable = join(folder, 'b-readable.html');
    await writeFile(unreadable, '<h1>Unreadable</h1>');
    await writeFile(readable, '<h1>Readable</h1>');
    const policy = await PathPolicy.create([root]);

    const result = await (async () => {
      await chmod(unreadable, 0o000);
      try {
        return await policy.enumerateFolder(folder);
      } finally {
        await chmod(unreadable, 0o644);
      }
    })();

    expect(result.files.map((file) => file.canonicalPath)).toEqual([await realpath(readable)]);
    expect(result.errors).toEqual([
      { path: await realpath(unreadable), code: 'UNREADABLE_SOURCE' },
    ]);
  });

  test('normalizes an unreadable enumeration root', async () => {
    const root = await makeTemporaryDirectory();
    const folder = join(root, 'artifacts');
    await mkdir(folder);
    const policy = await PathPolicy.create([root]);

    const enumeration = (async () => {
      await chmod(folder, 0o000);
      try {
        return await policy.enumerateFolder(folder);
      } finally {
        await chmod(folder, 0o755);
      }
    })();

    await expect(enumeration).rejects.toMatchObject({
      name: 'PathPolicyError',
      code: 'UNREADABLE_SOURCE',
      sourcePath: folder,
    });
  });

  test('does not descend into hidden entries during enumeration', async () => {
    const root = await makeTemporaryDirectory();
    const folder = join(root, 'artifacts');
    const hidden = join(folder, '.hidden');
    await mkdir(hidden, { recursive: true });
    await writeFile(join(hidden, 'concealed.html'), '<h1>Concealed</h1>');
    const visible = join(folder, 'visible.html');
    await writeFile(visible, '<h1>Visible</h1>');
    const policy = await PathPolicy.create([root]);

    const result = await policy.enumerateFolder(folder);

    expect(result.files.map((file) => file.canonicalPath)).toEqual([await realpath(visible)]);
    expect(result.errors).toEqual([
      { path: join(await realpath(folder), '.hidden'), code: 'UNREADABLE_SOURCE' },
    ]);
  });

  test('rechecks containment when an authorized file is replaced before read', async () => {
    const root = await makeTemporaryDirectory();
    const outside = await makeTemporaryDirectory();
    const source = join(root, 'artifact.html');
    const outsideFile = join(outside, 'outside.html');
    await writeFile(source, '<h1>Original</h1>');
    await writeFile(outsideFile, '<h1>Outside</h1>');
    const policy = await PathPolicy.create([root]);
    const authorized = await policy.authorizeFile(source);

    await rm(source);
    await symlink(outsideFile, source, 'file');

    await expect(authorized.read('utf8')).rejects.toMatchObject({
      code: 'SYMLINK_REJECTED',
    });
  });

  test('reads route assets as MIME-typed bytes without widening source formats', async () => {
    const root = await makeTemporaryDirectory();
    const outside = await makeTemporaryDirectory();
    const fixtures = [
      { name: 'styles.css', bytes: Buffer.from('body {}'), mimeType: 'text/css; charset=utf-8' },
      { name: 'pixel.png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]), mimeType: 'image/png' },
      { name: 'font.woff2', bytes: Buffer.from([0x77, 0x4f, 0x46, 0x32]), mimeType: 'font/woff2' },
      { name: 'data.bin', bytes: Buffer.from([0x00, 0xff]), mimeType: 'application/octet-stream' },
    ];
    for (const fixture of fixtures) {
      await writeFile(join(root, fixture.name), fixture.bytes);
    }
    const policy = await PathPolicy.create([root]);

    await expect(policy.authorizeFile(join(root, 'styles.css'))).rejects.toMatchObject({
      code: 'UNSUPPORTED_FORMAT',
    });
    for (const fixture of fixtures) {
      const asset = await policy.authorizeAsset(join(root, fixture.name));
      expect(asset.mimeType).toBe(fixture.mimeType);
      await expect(asset.read()).resolves.toEqual(fixture.bytes);
    }

    const outsideAsset = join(outside, 'outside.png');
    await writeFile(outsideAsset, Buffer.from('outside'));
    const replaceable = join(root, 'pixel.png');
    const authorized = await policy.authorizeAsset(replaceable);
    await rm(replaceable);
    await symlink(outsideAsset, replaceable, 'file');
    await expect(authorized.read()).rejects.toMatchObject({ code: 'SYMLINK_REJECTED' });
  });

  test('normalizes disappearance after validation but before the read syscall', async () => {
    const root = await makeTemporaryDirectory();
    const source = join(root, 'vanishing.png');
    await writeFile(source, Buffer.from('vanishing'));
    const policy = await PathPolicy.create([root]);
    const asset = await policy.authorizeAsset(source);
    readFileFault.path = asset.canonicalPath;
    readFileFault.beforeRead = () => rm(source);

    await expect(asset.read()).rejects.toMatchObject({
      name: 'PathPolicyError',
      code: 'SOURCE_MISSING',
      sourcePath: source,
    });
  });

  test('normalizes permission loss after validation but before the read syscall', async () => {
    const root = await makeTemporaryDirectory();
    const source = join(root, 'unreadable.png');
    await writeFile(source, Buffer.from('unreadable'));
    const policy = await PathPolicy.create([root]);
    const asset = await policy.authorizeAsset(source);
    readFileFault.path = asset.canonicalPath;
    readFileFault.beforeRead = () => chmod(source, 0o000);

    try {
      await expect(asset.read()).rejects.toMatchObject({
        name: 'PathPolicyError',
        code: 'UNREADABLE_SOURCE',
        sourcePath: source,
      });
    } finally {
      await chmod(source, 0o644);
    }
  });

  test('revalidates a recursive directory immediately before reading its entries', async () => {
    const root = await makeTemporaryDirectory();
    const outside = await makeTemporaryDirectory();
    const folder = join(root, 'artifacts');
    const replaceableDirectory = join(folder, 'z-replaceable');
    await mkdir(replaceableDirectory, { recursive: true });
    await writeFile(join(outside, 'outside-secret.html'), 'secret');
    const policy = await PathPolicy.create([root]);
    const canonicalFolder = await realpath(folder);
    readDirectoryFault.path = canonicalFolder;
    readDirectoryFault.afterRead = async () => {
      await rm(replaceableDirectory, { recursive: true });
      await symlink(outside, replaceableDirectory, 'dir');
    };

    const result = await policy.enumerateFolder(folder);

    expect(result.errors).toContainEqual({
      path: join(canonicalFolder, 'z-replaceable'),
      code: 'SYMLINK_REJECTED',
    });
    expect(result.errors.map((error) => error.path)).not.toContain(
      join(canonicalFolder, 'z-replaceable', 'outside-secret.html'),
    );
  });

  test('discards entries read after a validated directory becomes an outside symlink', async () => {
    const root = await makeTemporaryDirectory();
    const outside = await makeTemporaryDirectory();
    const folder = join(root, 'artifacts');
    const replaceableDirectory = join(folder, 'replaceable');
    await mkdir(replaceableDirectory, { recursive: true });
    await writeFile(join(outside, 'outside-secret.html'), 'secret');
    const policy = await PathPolicy.create([root]);
    const canonicalFolder = await realpath(folder);
    readDirectoryFault.path = await realpath(replaceableDirectory);
    readDirectoryFault.beforeRead = async () => {
      await rm(replaceableDirectory, { recursive: true });
      await symlink(outside, replaceableDirectory, 'dir');
    };

    const result = await policy.enumerateFolder(folder);

    expect(result.errors).toContainEqual({
      path: join(canonicalFolder, 'replaceable'),
      code: 'SYMLINK_REJECTED',
    });
    expect(result.errors.map((error) => error.path)).not.toContain(
      join(canonicalFolder, 'replaceable', 'outside-secret.html'),
    );
  });

  test('discards entries read after a validated directory is replaced by another inode', async () => {
    const root = await makeTemporaryDirectory();
    const folder = join(root, 'artifacts');
    const replaceableDirectory = join(folder, 'replaceable');
    const replacementDirectory = join(root, 'replacement');
    await mkdir(replaceableDirectory, { recursive: true });
    await mkdir(replacementDirectory);
    await writeFile(join(replacementDirectory, 'replacement-secret.html'), 'secret');
    const policy = await PathPolicy.create([root]);
    const canonicalFolder = await realpath(folder);
    readDirectoryFault.path = await realpath(replaceableDirectory);
    readDirectoryFault.beforeRead = async () => {
      await rm(replaceableDirectory, { recursive: true });
      await rename(replacementDirectory, replaceableDirectory);
    };

    const result = await policy.enumerateFolder(folder);

    expect(result.errors).toContainEqual({
      path: join(canonicalFolder, 'replaceable'),
      code: 'UNREADABLE_SOURCE',
    });
    expect(result.files.map((file) => file.canonicalPath)).not.toContain(
      join(canonicalFolder, 'replaceable', 'replacement-secret.html'),
    );
    expect(result.errors.map((error) => error.path)).not.toContain(
      join(canonicalFolder, 'replaceable', 'replacement-secret.html'),
    );
  });
});
