import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import { PathPolicy } from '../../src/server/security/path-policy.js';

const temporaryDirectories: string[] = [];

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'artifact-gallery-path-policy-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('PathPolicy', () => {
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
});
