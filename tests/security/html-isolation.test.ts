import { copyFile, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, test } from 'vitest';
import { chromium, type Browser, type BrowserContext } from 'playwright';

import { HtmlRenderer } from '../../src/server/rendering/html-renderer.js';
import { AssetReadLimitError, PathPolicy } from '../../src/server/security/path-policy.js';

const temporaryDirectories: string[] = [];
const renderers: HtmlRenderer[] = [];

afterEach(async () => {
  await Promise.all(renderers.splice(0).map((renderer) => renderer.close()));
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('HTML isolation', () => {
  test('rejects HTML input larger than 10 MiB before rendering', async () => {
    const root = await makeTemporaryDirectory();
    const sourcePath = join(root, 'artifact.html');
    await writeFile(sourcePath, '<h1>source</h1>');
    const renderer = await makeRenderer(root);
    const oversizedHtml = 'a'.repeat(10 * 1024 * 1024 + 1);

    await expect(renderer.render({ html: oversizedHtml, sourcePath })).rejects.toMatchObject({
      name: 'HtmlRenderError',
      code: 'INPUT_TOO_LARGE',
    });
  });

  test(
    'renders memory HTML in real Chromium with scripts disabled and bounded WebP output',
    async () => {
      const root = await makeTemporaryDirectory();
      const sourcePath = join(root, 'artifact.html');
      await writeFile(sourcePath, '<h1>source</h1>');
      const renderer = await makeRenderer(root);

      const result = await renderer.render({
        sourcePath,
        html: `
          <style>html, body { margin: 0; width: 1200px; height: 300px; background: #146c43; }</style>
          <script>document.body.style.height = '5000px'</script>
          <h1>Memory only</h1>
        `,
      });

      expect(result.screenshot.subarray(0, 4).toString('ascii')).toBe('RIFF');
      expect(result.screenshot.subarray(8, 12).toString('ascii')).toBe('WEBP');
      expect(result.width).toBe(1200);
      expect(result.height).toBeLessThanOrEqual(2400);
      expect(result.warnings).not.toContainEqual({ code: 'CONTENT_CLIPPED' });
    },
    20_000,
  );

  test(
    'fulfills and applies allowed CSS, image, and font bytes through the path policy',
    async () => {
      const root = await makeTemporaryDirectory();
      const sourcePath = join(root, 'artifact.html');
      await writeFile(sourcePath, '<h1>source</h1>');
      await writeFile(
        join(root, 'styles.css'),
        `
          @font-face { font-family: AssetFont; src: url('./Abel-Regular.ttf') format('truetype'); }
          html, body { margin: 0; background: rgb(200, 10, 20); }
          #image { width: 100px; height: 100px; background: url('./square.svg'); }
          #font { display: inline-block; font: 100px/100px AssetFont, monospace; }
          #font-marker { display: inline-block; width: 20px; height: 100px; background: rgb(240, 200, 5); }
        `,
      );
      await writeFile(
        join(root, 'square.svg'),
        '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="rgb(5, 40, 220)"/></svg>',
      );
      await copyFile(
        join(process.cwd(), 'tests/fixtures/fonts/abel/Abel-Regular.ttf'),
        join(root, 'Abel-Regular.ttf'),
      );
      const renderer = await makeRenderer(root);

      const result = await renderer.render({
        sourcePath,
        html: `
          <link rel="stylesheet" href="./styles.css">
          <div id="image"></div>
          <span id="font">WWWW</span><span id="font-marker"></span>
        `,
      });

      expect(result.warnings).toEqual([]);
      expectPixelClose(await readWebpPixel(result.screenshot, 110, 10), [200, 10, 20]);
      expectPixelClose(await readWebpPixel(result.screenshot, 20, 20), [5, 40, 220]);
      expectPixelClose(await readWebpPixel(result.screenshot, 305, 120), [240, 200, 5]);
    },
    20_000,
  );

  test('fulfills local font capabilities with a browser-observed CORS header', async () => {
    const root = await makeTemporaryDirectory();
    const sourcePath = join(root, 'artifact.html');
    await writeFile(sourcePath, '<h1>source</h1>');
    await copyFile(
      join(process.cwd(), 'tests/fixtures/fonts/abel/Abel-Regular.ttf'),
      join(root, 'Abel-Regular.ttf'),
    );
    const policy = await PathPolicy.create([root]);
    let fontCorsHeader: string | undefined;
    const renderer = new HtmlRenderer(policy, {
      launchBrowser: async () => {
        const browser = await chromium.launch({ headless: true });
        return proxyBrowserNewContext(browser, async (options) => {
          const context = await browser.newContext(options);
          context.on('response', async (response) => {
            if (response.url().includes('Abel-Regular.ttf')) {
              fontCorsHeader = (await response.allHeaders())['access-control-allow-origin'];
            }
          });
          return context;
        });
      },
    });
    renderers.push(renderer);

    await renderer.render({
      sourcePath,
      html: `
        <style>
          @font-face { font-family: AssetFont; src: url('./Abel-Regular.ttf') format('truetype'); }
          #font { font: 100px AssetFont; }
        </style>
        <span id="font">WWWW</span>
      `,
    });

    expect(fontCorsHeader).toBe('*');
  });

  test.each([
    ['external HTTP', 'http://example.invalid/blocked.png'],
    ['external HTTPS', 'https://example.invalid/blocked.png'],
    ['loopback API', 'http://127.0.0.1:43210/api/private.png'],
    ['file URL', 'file:///etc/passwd'],
    ['parent traversal', '../outside.png'],
  ])('denies %s as a structured warning in real Chromium', async (_label, assetUrl) => {
    const root = await makeTemporaryDirectory();
    const sourcePath = join(root, 'artifact.html');
    await writeFile(sourcePath, '<h1>source</h1>');
    const renderer = await makeRenderer(root);

    const result = await renderer.render({
      sourcePath,
      html: `<img src="${assetUrl}" alt="blocked">`,
    });

    expect(result.warnings).toContainEqual({ code: 'ASSET_BLOCKED' });
    expect(Object.keys(result.warnings[0] ?? {})).toEqual(['code']);
  });

  test.each([
    ['raw attribute', '<img src="nested/../outside-child.svg" alt="blocked">'],
    ['percent-encoded attribute', '<img src="nested/%2e%2e/outside-child.svg" alt="blocked">'],
    [
      'double-percent-encoded attribute',
      '<img src="nested/%252e%252e/outside-child.svg" alt="blocked">',
    ],
    [
      'inline CSS URL',
      '<div style="width: 20px; height: 20px; background: url(\'nested/../outside-child.svg\')"></div>',
    ],
    [
      'CSS-escaped URL',
      '<style>body { background: url(\'nested/\\2e \\2e /outside-child.svg\') }</style>',
    ],
  ])(
    'rejects %s traversal before Chromium normalization without reading sibling bytes',
    async (_label, html) => {
      const root = await makeTemporaryDirectory();
      const sourcePath = join(root, 'artifact.html');
      const outsideChildPath = join(root, 'outside-child.svg');
      await writeFile(sourcePath, '<h1>source</h1>');
      await writeFile(
        outsideChildPath,
        '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>',
      );
      const canonicalOutsideChildPath = await realpath(outsideChildPath);
      const realPolicy = await PathPolicy.create([root]);
      const readPaths: string[] = [];
      const renderer = new HtmlRenderer({
        authorizeAsset: async (requestedPath) => {
          const asset = await realPolicy.authorizeAsset(requestedPath);
          return {
            canonicalPath: asset.canonicalPath,
            mimeType: asset.mimeType,
            read: async (maxBytes) => {
              readPaths.push(asset.canonicalPath);
              return asset.read(maxBytes);
            },
          };
        },
      });
      renderers.push(renderer);

      const result = await renderer.render({ sourcePath, html });

      expect(result.warnings).toContainEqual({ code: 'ASSET_BLOCKED' });
      expect(readPaths).not.toContain(canonicalOutsideChildPath);
    },
    20_000,
  );

  test(
    'rejects traversal inside an authorized stylesheet without reading sibling bytes',
    async () => {
      const root = await makeTemporaryDirectory();
      const sourcePath = join(root, 'artifact.html');
      const stylesheetPath = join(root, 'styles.css');
      const outsideChildPath = join(root, 'outside-child.svg');
      await writeFile(sourcePath, '<h1>source</h1>');
      await writeFile(
        stylesheetPath,
        "body { background: url('nested/../outside-child.svg') }",
      );
      await writeFile(
        outsideChildPath,
        '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"></svg>',
      );
      const canonicalStylesheetPath = await realpath(stylesheetPath);
      const canonicalOutsideChildPath = await realpath(outsideChildPath);
      const realPolicy = await PathPolicy.create([root]);
      const readPaths: string[] = [];
      const renderer = new HtmlRenderer({
        authorizeAsset: async (requestedPath) => {
          const asset = await realPolicy.authorizeAsset(requestedPath);
          return {
            canonicalPath: asset.canonicalPath,
            mimeType: asset.mimeType,
            read: async (maxBytes) => {
              readPaths.push(asset.canonicalPath);
              return asset.read(maxBytes);
            },
          };
        },
      });
      renderers.push(renderer);

      const result = await renderer.render({
        sourcePath,
        html: '<link rel="stylesheet" href="./styles.css">',
      });

      expect(result.warnings).toContainEqual({ code: 'ASSET_BLOCKED' });
      expect(readPaths).toContain(canonicalStylesheetPath);
      expect(readPaths).not.toContain(canonicalOutsideChildPath);
    },
    20_000,
  );

  test('denies a symlink to an outside asset through the real path policy', async () => {
    const root = await makeTemporaryDirectory();
    const outside = await makeTemporaryDirectory();
    const sourcePath = join(root, 'artifact.html');
    const outsideImage = join(outside, 'outside.svg');
    await writeFile(sourcePath, '<h1>source</h1>');
    await writeFile(
      outsideImage,
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>',
    );
    await symlink(outsideImage, join(root, 'linked.svg'), 'file');
    const renderer = await makeRenderer(root);

    const result = await renderer.render({
      sourcePath,
      html: '<img src="./linked.svg" alt="blocked symlink">',
    });

    expect(result.warnings).toEqual([{ code: 'ASSET_BLOCKED' }]);
  });

  test(
    'rejects an individual asset larger than 10 MiB',
    async () => {
      const root = await makeTemporaryDirectory();
      const sourcePath = join(root, 'artifact.html');
      await writeFile(sourcePath, '<h1>source</h1>');
      await writeFile(join(root, 'oversized.bin'), Buffer.alloc(10 * 1024 * 1024 + 1, 0x61));
      const renderer = await makeRenderer(root);

      await expect(
        renderer.render({ sourcePath, html: '<img src="./oversized.bin" alt="oversized">' }),
      ).rejects.toMatchObject({ name: 'HtmlRenderError', code: 'ASSET_TOO_LARGE' });
    },
    20_000,
  );

  test(
    'rejects more than 50 MiB of assets in one render attempt',
    async () => {
      const root = await makeTemporaryDirectory();
      const sourcePath = join(root, 'artifact.html');
      await writeFile(sourcePath, '<h1>source</h1>');
      await writeFile(join(root, 'nine-mib.bin'), Buffer.alloc(9 * 1024 * 1024, 0x62));
      const renderer = await makeRenderer(root);
      const images = Array.from(
        { length: 6 },
        (_, index) => `<img src="./nine-mib.bin?request=${index}" alt="asset ${index}">`,
      ).join('');

      await expect(renderer.render({ sourcePath, html: images })).rejects.toMatchObject({
        name: 'HtmlRenderError',
        code: 'ASSET_TOO_LARGE',
      });
    },
    30_000,
  );

  test(
    'serializes bounded asset reads against the reserved cumulative budget',
    async () => {
      const root = await makeTemporaryDirectory();
      const sourcePath = join(root, 'artifact.html');
      const assetPath = join(root, 'reserved.bin');
      await writeFile(sourcePath, '<h1>source</h1>');
      await writeFile(assetPath, Buffer.from('capability'));
      const realPolicy = await PathPolicy.create([root]);
      const requestedLimits: Array<number | undefined> = [];
      let activeReads = 0;
      let peakReads = 0;
      const renderer = new HtmlRenderer({
        authorizeAsset: async (requestedPath) => {
          const asset = await realPolicy.authorizeAsset(requestedPath);
          return {
            canonicalPath: asset.canonicalPath,
            mimeType: asset.mimeType,
            read: async (maxBytes?: number) => {
              requestedLimits.push(maxBytes);
              activeReads += 1;
              peakReads = Math.max(peakReads, activeReads);
              try {
                await new Promise((resolve) => setTimeout(resolve, 20));
                if (maxBytes !== undefined && maxBytes < 9 * 1024 * 1024) {
                  throw new AssetReadLimitError(maxBytes);
                }
                return Buffer.alloc(9 * 1024 * 1024, 0x64);
              } finally {
                activeReads -= 1;
              }
            },
          };
        },
      });
      renderers.push(renderer);
      const images = Array.from(
        { length: 6 },
        (_, index) => `<img src="./reserved.bin?request=${index}" alt="asset ${index}">`,
      ).join('');

      await expect(renderer.render({ sourcePath, html: images })).rejects.toMatchObject({
        code: 'ASSET_TOO_LARGE',
      });
      expect(peakReads).toBe(1);
      expect(requestedLimits).toEqual([
        10 * 1024 * 1024,
        10 * 1024 * 1024,
        10 * 1024 * 1024,
        10 * 1024 * 1024,
        10 * 1024 * 1024,
        5 * 1024 * 1024,
      ]);
    },
    20_000,
  );

  test('clips long pages at 2400px and exposes a structured warning', async () => {
    const root = await makeTemporaryDirectory();
    const sourcePath = join(root, 'artifact.html');
    await writeFile(sourcePath, '<h1>source</h1>');
    const renderer = await makeRenderer(root);

    const result = await renderer.render({
      sourcePath,
      html: '<style>html, body { margin: 0; height: 3000px; }</style><p>Long page</p>',
    });

    expect(result.height).toBe(2400);
    expect(result.warnings).toContainEqual({ code: 'CONTENT_CLIPPED' });
  });

  test.each([
    ['service worker registration', "void navigator.serviceWorker.register('./worker.js')"],
    ['popup/window.open', "void window.open('https://example.invalid/popup')"],
    ['dialog', "alert('blocked')"],
    [
      'download',
      "const link = document.createElement('a'); link.href = './download.bin'; link.download = 'x'; link.click()",
    ],
    ['WebSocket', "void new WebSocket('wss://example.invalid/socket')"],
    ['external navigation', "window.location.href = 'https://example.invalid/navigation'"],
  ])('prevents %s code from executing in real Chromium', async (_label, capabilityCode) => {
    const root = await makeTemporaryDirectory();
    const sourcePath = join(root, 'artifact.html');
    await writeFile(sourcePath, '<h1>source</h1>');
    const renderer = await makeRenderer(root);

    const result = await renderer.render({
      sourcePath,
      html: `<script>try { ${capabilityCode} } finally { document.body.style.height = '3000px' }</script>`,
    });

    expect(result.warnings).not.toContainEqual({ code: 'CONTENT_CLIPPED' });
    expect(result.height).toBeLessThan(2400);
  });

  test('blocks meta-refresh redirects before external navigation', async () => {
    const root = await makeTemporaryDirectory();
    const sourcePath = join(root, 'artifact.html');
    await writeFile(sourcePath, '<h1>source</h1>');
    const renderer = await makeRenderer(root);

    const result = await renderer.render({
      sourcePath,
      html: '<meta http-equiv="refresh" content="0; url=https://example.invalid/redirect">',
    });

    expect(result.warnings).toContainEqual({ code: 'ASSET_BLOCKED' });
  });

  test('closes the disposable browser context after a successful render', async () => {
    const root = await makeTemporaryDirectory();
    const sourcePath = join(root, 'artifact.html');
    await writeFile(sourcePath, '<h1>source</h1>');
    const { browser, renderer } = await makeInspectableRenderer(root);

    await renderer.render({ sourcePath, html: '<h1>Success</h1>' });

    expect(browser()).toBeDefined();
    expect(browser()?.contexts()).toHaveLength(0);
  });

  test(
    'closes the disposable browser context after a boundary error',
    async () => {
      const root = await makeTemporaryDirectory();
      const sourcePath = join(root, 'artifact.html');
      await writeFile(sourcePath, '<h1>source</h1>');
      await writeFile(join(root, 'oversized.bin'), Buffer.alloc(10 * 1024 * 1024 + 1, 0x63));
      const { browser, renderer } = await makeInspectableRenderer(root);

      await expect(
        renderer.render({ sourcePath, html: '<img src="./oversized.bin" alt="oversized">' }),
      ).rejects.toMatchObject({ code: 'ASSET_TOO_LARGE' });

      expect(browser()?.contexts()).toHaveLength(0);
    },
    20_000,
  );

  test(
    'disposes a stalled render context before returning TIMEOUT',
    async () => {
      const root = await makeTemporaryDirectory();
      const sourcePath = join(root, 'artifact.html');
      const assetPath = join(root, 'stalled.css');
      await writeFile(sourcePath, '<h1>source</h1>');
      await writeFile(assetPath, 'body { color: red; }');
      const realPolicy = await PathPolicy.create([root]);
      let launchedBrowser: Browser | undefined;
      const renderer = new HtmlRenderer(
        {
          authorizeAsset: async (requestedPath) => {
            const asset = await realPolicy.authorizeAsset(requestedPath);
            return {
              canonicalPath: asset.canonicalPath,
              mimeType: asset.mimeType,
              read: () => new Promise<Buffer>(() => undefined),
            };
          },
        },
        {
          renderTimeoutMs: 1_000,
          launchBrowser: async () => {
            launchedBrowser = await chromium.launch({ headless: true });
            return launchedBrowser;
          },
        },
      );
      renderers.push(renderer);

      const outcome = await Promise.race([
        renderer
          .render({ sourcePath, html: '<link rel="stylesheet" href="./stalled.css">' })
          .then(() => ({ code: 'RENDERED' }), (error: unknown) => error),
        new Promise<{ code: string }>((resolve) =>
          setTimeout(() => resolve({ code: 'TIMEOUT_MISSING' }), 2_500),
        ),
      ]);

      expect(outcome).toMatchObject({ name: 'HtmlRenderError', code: 'TIMEOUT' });
      expect(launchedBrowser?.contexts()).toHaveLength(0);
    },
    5_000,
  );

  test(
    'reuses one Chromium process across concurrent renders',
    async () => {
      const root = await makeTemporaryDirectory();
      const sourcePath = join(root, 'artifact.html');
      await writeFile(sourcePath, '<h1>source</h1>');
      await writeFile(join(root, 'gate.css'), 'body { color: green; }');
      const realPolicy = await PathPolicy.create([root]);
      const releases: Array<() => void> = [];
      let startedReads = 0;
      let resolveBothStarted: (() => void) | undefined;
      const bothStarted = new Promise<void>((resolve) => {
        resolveBothStarted = resolve;
      });
      const launchedBrowsers: Browser[] = [];
      const renderer = new HtmlRenderer(
        {
          authorizeAsset: async (requestedPath) => {
            const asset = await realPolicy.authorizeAsset(requestedPath);
            return {
              canonicalPath: asset.canonicalPath,
              mimeType: asset.mimeType,
              read: () =>
                new Promise<Buffer>((resolve) => {
                  releases.push(() => resolve(Buffer.from('body { color: green; }')));
                  startedReads += 1;
                  if (startedReads === 2) {
                    resolveBothStarted?.();
                  }
                }),
            };
          },
        },
        {
          launchBrowser: async () => {
            const browser = await chromium.launch({ headless: true });
            launchedBrowsers.push(browser);
            return browser;
          },
        },
      );
      renderers.push(renderer);
      const renders = [
        renderer.render({ sourcePath, html: '<link rel="stylesheet" href="./gate.css?one">' }),
        renderer.render({ sourcePath, html: '<link rel="stylesheet" href="./gate.css?two">' }),
      ];

      try {
        await bothStarted;
        expect(launchedBrowsers).toHaveLength(1);
      } finally {
        for (const release of releases) {
          release();
        }
        await Promise.allSettled(renders);
        await Promise.all(launchedBrowsers.map((browser) => browser.close()));
      }
    },
    10_000,
  );

  test(
    'waits to open a third context until one of two active contexts closes',
    async () => {
      const root = await makeTemporaryDirectory();
      const sourcePath = join(root, 'artifact.html');
      await writeFile(sourcePath, '<h1>source</h1>');
      await writeFile(join(root, 'gate.css'), 'body { color: navy; }');
      const realPolicy = await PathPolicy.create([root]);
      const releases: Array<() => void> = [];
      let startedReads = 0;
      let resolveFirstTwo: (() => void) | undefined;
      let resolveThird: (() => void) | undefined;
      const firstTwoStarted = new Promise<void>((resolve) => {
        resolveFirstTwo = resolve;
      });
      const thirdStarted = new Promise<void>((resolve) => {
        resolveThird = resolve;
      });
      let launchedBrowser: Browser | undefined;
      const renderer = new HtmlRenderer(
        {
          authorizeAsset: async (requestedPath) => {
            const asset = await realPolicy.authorizeAsset(requestedPath);
            return {
              canonicalPath: asset.canonicalPath,
              mimeType: asset.mimeType,
              read: () =>
                new Promise<Buffer>((resolve) => {
                  releases.push(() => resolve(Buffer.from('body { color: navy; }')));
                  startedReads += 1;
                  if (startedReads === 2) resolveFirstTwo?.();
                  if (startedReads === 3) resolveThird?.();
                }),
            };
          },
        },
        {
          launchBrowser: async () => {
            launchedBrowser = await chromium.launch({ headless: true });
            return launchedBrowser;
          },
        },
      );
      renderers.push(renderer);
      const renders = [0, 1, 2].map((request) =>
        renderer.render({
          sourcePath,
          html: `<link rel="stylesheet" href="./gate.css?request=${request}">`,
        }),
      );

      try {
        await firstTwoStarted;
        const thirdStartedEarly = await Promise.race([
          thirdStarted.then(() => true),
          new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
        ]);
        expect(thirdStartedEarly).toBe(false);
        expect(launchedBrowser?.contexts()).toHaveLength(2);

        releases[0]?.();
        const thirdStartedAfterRelease = await Promise.race([
          thirdStarted.then(() => true),
          new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000)),
        ]);
        expect(thirdStartedAfterRelease).toBe(true);
        expect(launchedBrowser?.contexts().length).toBeLessThanOrEqual(2);
      } finally {
        for (const release of releases) {
          release();
        }
        await Promise.allSettled(renders);
        await launchedBrowser?.close();
      }
    },
    10_000,
  );

  test('relaunches Chromium after the reusable browser disconnects', async () => {
    const root = await makeTemporaryDirectory();
    const sourcePath = join(root, 'artifact.html');
    await writeFile(sourcePath, '<h1>source</h1>');
    const policy = await PathPolicy.create([root]);
    const launchedBrowsers: Browser[] = [];
    const renderer = new HtmlRenderer(policy, {
      launchBrowser: async () => {
        const browser = await chromium.launch({ headless: true });
        launchedBrowsers.push(browser);
        return browser;
      },
    });
    renderers.push(renderer);

    await renderer.render({ sourcePath, html: '<h1>Before disconnect</h1>' });
    await launchedBrowsers[0]?.close();
    const recovered = await renderer.render({ sourcePath, html: '<h1>After disconnect</h1>' });

    expect(launchedBrowsers).toHaveLength(2);
    expect(recovered.screenshot.subarray(8, 12).toString('ascii')).toBe('WEBP');
    expect(launchedBrowsers[1]?.contexts()).toHaveLength(0);
  });

  test(
    'closes a context returned after the render timeout before clearing permissions',
    async () => {
      const root = await makeTemporaryDirectory();
      const sourcePath = join(root, 'artifact.html');
      await writeFile(sourcePath, '<h1>source</h1>');
      const policy = await PathPolicy.create([root]);
      const returnContext = deferred<void>();
      const finishPermissions = deferred<void>();
      const contextCreated = deferred<void>();
      let permissionsCalled = false;
      let actualBrowser: Browser | undefined;
      const renderer = new HtmlRenderer(policy, {
        renderTimeoutMs: 1_500,
        launchBrowser: async () => {
          actualBrowser = await chromium.launch({ headless: true });
          return proxyBrowserNewContext(actualBrowser, async (options) => {
            const context = await actualBrowser?.newContext(options);
            if (!context) throw new Error('Browser context was not created');
            contextCreated.resolve();
            await returnContext.promise;
            return proxyContextClearPermissions(context, async () => {
              permissionsCalled = true;
              await finishPermissions.promise;
            });
          });
        },
      });
      renderers.push(renderer);
      const outcome = renderer
        .render({ sourcePath, html: '<h1>Timeout</h1>' })
        .then(() => ({ code: 'RENDERED' }), (error: unknown) => error);

      try {
        await contextCreated.promise;
        await expect(outcome).resolves.toMatchObject({ code: 'TIMEOUT' });
        returnContext.resolve();
        await new Promise((resolve) => setTimeout(resolve, 100));

        expect(permissionsCalled).toBe(false);
        expect(actualBrowser?.contexts()).toHaveLength(0);
      } finally {
        returnContext.resolve();
        finishPermissions.resolve();
      }
    },
    5_000,
  );

  test(
    'tracks and closes a context while clearPermissions is delayed',
    async () => {
      const root = await makeTemporaryDirectory();
      const sourcePath = join(root, 'artifact.html');
      await writeFile(sourcePath, '<h1>source</h1>');
      const policy = await PathPolicy.create([root]);
      const finishPermissions = deferred<void>();
      const permissionsCalled = deferred<void>();
      let actualBrowser: Browser | undefined;
      const renderer = new HtmlRenderer(policy, {
        renderTimeoutMs: 1_500,
        launchBrowser: async () => {
          actualBrowser = await chromium.launch({ headless: true });
          return proxyBrowserNewContext(actualBrowser, async (options) => {
            const context = await actualBrowser?.newContext(options);
            if (!context) throw new Error('Browser context was not created');
            return proxyContextClearPermissions(context, async () => {
              permissionsCalled.resolve();
              await finishPermissions.promise;
            });
          });
        },
      });
      renderers.push(renderer);
      const outcome = renderer
        .render({ sourcePath, html: '<h1>Timeout</h1>' })
        .then(() => ({ code: 'RENDERED' }), (error: unknown) => error);

      try {
        await permissionsCalled.promise;
        await expect(outcome).resolves.toMatchObject({ code: 'TIMEOUT' });
        expect(actualBrowser?.contexts()).toHaveLength(0);
      } finally {
        finishPermissions.resolve();
      }
    },
    5_000,
  );

  test(
    'releases both limiter slots when clearPermissions never settles',
    async () => {
      const root = await makeTemporaryDirectory();
      const sourcePath = join(root, 'artifact.html');
      await writeFile(sourcePath, '<h1>source</h1>');
      const policy = await PathPolicy.create([root]);
      const firstTwoPermissionsStarted = deferred<void>();
      let permissionsStarted = 0;
      let contextCount = 0;
      let actualBrowser: Browser | undefined;
      const renderer = new HtmlRenderer(policy, {
        renderTimeoutMs: 750,
        launchBrowser: async () => {
          actualBrowser = await chromium.launch({ headless: true });
          return proxyBrowserNewContext(actualBrowser, async (options) => {
            const context = await actualBrowser?.newContext(options);
            if (!context) throw new Error('Browser context was not created');
            contextCount += 1;
            if (contextCount > 2) return context;
            return proxyContextClearPermissions(context, () => {
              permissionsStarted += 1;
              if (permissionsStarted === 2) firstTwoPermissionsStarted.resolve();
              return new Promise<void>(() => undefined);
            });
          });
        },
      });
      renderers.push(renderer);
      const stalled = [1, 2].map((attempt) =>
        renderer
          .render({ sourcePath, html: `<h1>Stalled ${attempt}</h1>` })
          .then(() => ({ code: 'RENDERED' }), (error: unknown) => error),
      );

      await firstTwoPermissionsStarted.promise;
      await expect(Promise.all(stalled)).resolves.toEqual([
        expect.objectContaining({ code: 'TIMEOUT' }),
        expect.objectContaining({ code: 'TIMEOUT' }),
      ]);
      await expect(renderer.render({ sourcePath, html: '<h1>Third</h1>' })).resolves.toMatchObject({
        width: 1200,
      });
      expect(actualBrowser?.contexts()).toHaveLength(0);
    },
    5_000,
  );

  test(
    'releases both limiter slots when route asset reads never settle',
    async () => {
      const root = await makeTemporaryDirectory();
      const sourcePath = join(root, 'artifact.html');
      const assetPath = join(root, 'stalled.css');
      await writeFile(sourcePath, '<h1>source</h1>');
      await writeFile(assetPath, 'body { color: purple; }');
      const realPolicy = await PathPolicy.create([root]);
      const firstTwoReadsStarted = deferred<void>();
      let readsStarted = 0;
      const renderer = new HtmlRenderer(
        {
          authorizeAsset: async (requestedPath) => {
            const asset = await realPolicy.authorizeAsset(requestedPath);
            return {
              canonicalPath: asset.canonicalPath,
              mimeType: asset.mimeType,
              read: () => {
                readsStarted += 1;
                if (readsStarted === 2) firstTwoReadsStarted.resolve();
                return new Promise<Buffer>(() => undefined);
              },
            };
          },
        },
        { renderTimeoutMs: 750 },
      );
      renderers.push(renderer);
      const stalled = [1, 2].map((attempt) =>
        renderer
          .render({
            sourcePath,
            html: `<link rel="stylesheet" href="./stalled.css?attempt=${attempt}">`,
          })
          .then(() => ({ code: 'RENDERED' }), (error: unknown) => error),
      );

      await firstTwoReadsStarted.promise;
      await expect(Promise.all(stalled)).resolves.toEqual([
        expect.objectContaining({ code: 'TIMEOUT' }),
        expect.objectContaining({ code: 'TIMEOUT' }),
      ]);
      await expect(renderer.render({ sourcePath, html: '<h1>Third</h1>' })).resolves.toMatchObject({
        width: 1200,
      });
    },
    5_000,
  );
});

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'artifact-gallery-html-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function makeRenderer(root: string): Promise<HtmlRenderer> {
  const policy = await PathPolicy.create([root]);
  const renderer = new HtmlRenderer(policy);
  renderers.push(renderer);
  return renderer;
}

async function makeInspectableRenderer(root: string): Promise<{
  browser: () => Browser | undefined;
  renderer: HtmlRenderer;
}> {
  const policy = await PathPolicy.create([root]);
  let launchedBrowser: Browser | undefined;
  const renderer = new HtmlRenderer(policy, {
    launchBrowser: async () => {
      launchedBrowser = await chromium.launch({ headless: true });
      return launchedBrowser;
    },
  });
  renderers.push(renderer);
  return { browser: () => launchedBrowser, renderer };
}

async function readWebpPixel(
  screenshot: Buffer,
  x: number,
  y: number,
): Promise<[number, number, number]> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    return await page.evaluate(
      async ({ source, pixelX, pixelY }) => {
        const image = new Image();
        image.src = source;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext('2d');
        if (!context) {
          throw new Error('Canvas is unavailable');
        }
        context.drawImage(image, 0, 0);
        const [red = 0, green = 0, blue = 0] = context.getImageData(pixelX, pixelY, 1, 1).data;
        return [red, green, blue] as [number, number, number];
      },
      {
        source: `data:image/webp;base64,${screenshot.toString('base64')}`,
        pixelX: x,
        pixelY: y,
      },
    );
  } finally {
    await browser.close();
  }
}

function expectPixelClose(
  actual: [number, number, number],
  expected: [number, number, number],
): void {
  for (const [index, expectedChannel] of expected.entries()) {
    expect(Math.abs((actual[index] ?? 0) - expectedChannel)).toBeLessThanOrEqual(3);
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value?: T) => void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => resolvePromise?.(value as T),
  };
}

function proxyBrowserNewContext(
  browser: Browser,
  newContext: (...args: Parameters<Browser['newContext']>) => Promise<BrowserContext>,
): Browser {
  return new Proxy(browser, {
    get(target, property) {
      if (property === 'newContext') return newContext;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function proxyContextClearPermissions(
  context: BrowserContext,
  clearPermissions: () => Promise<void>,
): BrowserContext {
  return new Proxy(context, {
    get(target, property) {
      if (property === 'clearPermissions') return clearPermissions;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
