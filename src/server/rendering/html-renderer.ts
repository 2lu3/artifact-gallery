import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';

import { chromium, type Browser, type BrowserContext, type Page, type Route } from 'playwright';

import type { PathPolicy } from '../security/path-policy.js';

export type HtmlRenderErrorCode =
  | 'HTML_RENDER_FAILED'
  | 'ASSET_BLOCKED'
  | 'ASSET_TOO_LARGE'
  | 'INPUT_TOO_LARGE'
  | 'TIMEOUT';

export class HtmlRenderError extends Error {
  constructor(readonly code: HtmlRenderErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = 'HtmlRenderError';
  }
}

export interface HtmlRenderRequest {
  readonly html: string;
  readonly sourcePath: string;
}

export type HtmlRenderWarningCode = 'ASSET_BLOCKED' | 'CONTENT_CLIPPED';

export interface HtmlRenderWarning {
  readonly code: HtmlRenderWarningCode;
}

export interface HtmlRenderResult {
  readonly screenshot: Buffer;
  readonly width: number;
  readonly height: number;
  readonly warnings: readonly HtmlRenderWarning[];
}

type AssetPathPolicy = Pick<PathPolicy, 'authorizeAsset'>;

export interface HtmlRendererOptions {
  readonly launchBrowser?: () => Promise<Browser>;
  readonly renderTimeoutMs?: number;
}

const RENDER_TIMEOUT_MS = 30_000;
const MAX_HTML_BYTES = 10 * 1024 * 1024;
const MAX_ASSET_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_ASSET_BYTES = 50 * 1024 * 1024;
const SCREENSHOT_WIDTH = 1200;
const SCREENSHOT_MAX_HEIGHT = 2400;
const VIRTUAL_ASSET_ORIGIN = 'https://artifact.invalid';

const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline' https://artifact.invalid",
  'img-src data: https://artifact.invalid',
  'font-src https://artifact.invalid',
  "connect-src 'none'",
  "worker-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "media-src 'none'",
  "form-action 'none'",
  'base-uri https://artifact.invalid',
].join('; ');

interface RenderState {
  readonly warnings: Set<HtmlRenderWarningCode>;
  totalAssetBytes: number;
  blockedNavigation: boolean;
  error?: HtmlRenderError;
}

interface RenderAttemptHandle {
  context?: BrowserContext;
}

interface ContextWaiter {
  readonly signal: AbortSignal;
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: HtmlRenderError) => void;
  readonly onAbort: () => void;
}

class ContextLimiter {
  private active = 0;
  private readonly waiters: ContextWaiter[] = [];

  constructor(private readonly maximum: number) {}

  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) {
      return Promise.reject(new HtmlRenderError('TIMEOUT'));
    }
    if (this.active < this.maximum) {
      this.active += 1;
      return Promise.resolve(this.releaseFunction());
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new HtmlRenderError('TIMEOUT'));
      };
      const waiter: ContextWaiter = { signal, resolve, reject, onAbort };
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private releaseFunction(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.grantNext();
    };
  }

  private grantNext(): void {
    const waiter = this.waiters.shift();
    if (!waiter) return;
    waiter.signal.removeEventListener('abort', waiter.onAbort);
    if (waiter.signal.aborted) {
      waiter.reject(new HtmlRenderError('TIMEOUT'));
      this.grantNext();
      return;
    }
    this.active += 1;
    waiter.resolve(this.releaseFunction());
  }
}

export class HtmlRenderer {
  private browser: Browser | null = null;
  private browserLaunch: Promise<Browser> | null = null;
  private readonly launchBrowser: () => Promise<Browser>;
  private readonly renderTimeoutMs: number;
  private readonly contextLimiter = new ContextLimiter(2);

  constructor(
    private readonly pathPolicy: AssetPathPolicy,
    options: HtmlRendererOptions = {},
  ) {
    this.launchBrowser = options.launchBrowser ?? (() => chromium.launch({ headless: true }));
    this.renderTimeoutMs = Math.min(
      Math.max(1, options.renderTimeoutMs ?? RENDER_TIMEOUT_MS),
      RENDER_TIMEOUT_MS,
    );
  }

  async render(request: HtmlRenderRequest): Promise<HtmlRenderResult> {
    if (Buffer.byteLength(request.html, 'utf8') > MAX_HTML_BYTES) {
      throw new HtmlRenderError('INPUT_TOO_LARGE');
    }

    const handle: RenderAttemptHandle = {};
    const abortController = new AbortController();
    const attempt = this.renderAttempt(request, handle, abortController.signal);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        attempt,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new HtmlRenderError('TIMEOUT')),
            this.renderTimeoutMs,
          );
        }),
      ]);
    } catch (error) {
      if (error instanceof HtmlRenderError && error.code === 'TIMEOUT') {
        abortController.abort();
        void attempt.catch(() => undefined);
        await handle.context?.close().catch(() => undefined);
      }
      throw error;
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private async renderAttempt(
    request: HtmlRenderRequest,
    handle: RenderAttemptHandle,
    signal: AbortSignal,
  ): Promise<HtmlRenderResult> {
    let context: BrowserContext | undefined;
    let releaseContextSlot: (() => void) | undefined;
    try {
      releaseContextSlot = await this.contextLimiter.acquire(signal);
      context = await this.createContext(signal);
      handle.context = context;
      const state: RenderState = {
        warnings: new Set(),
        totalAssetBytes: 0,
        blockedNavigation: false,
      };
      const assetToken = randomUUID();
      await context.route('**/*', (route) =>
        this.handleRoute(route, request.sourcePath, assetToken, state),
      );
      await context.routeWebSocket('**/*', (webSocket) => {
        state.warnings.add('ASSET_BLOCKED');
        webSocket.close();
      });
      const page = await context.newPage();
      this.blockPageCapabilities(page, state.warnings);
      await page.setContent(this.isolatedDocument(request.html, assetToken), { waitUntil: 'load' });
      try {
        await page.evaluate(() => document.fonts.ready);
      } catch (error) {
        if (!state.blockedNavigation) {
          throw error;
        }
      }
      if (state.blockedNavigation) {
        await this.replaceBlockedNavigation(page);
      }
      if (state.error) {
        throw state.error;
      }
      const naturalHeight = await page.evaluate(() =>
        Math.max(document.body?.scrollHeight ?? 0, document.documentElement.scrollHeight, 1),
      );
      const height = Math.min(naturalHeight, SCREENSHOT_MAX_HEIGHT);
      if (naturalHeight > SCREENSHOT_MAX_HEIGHT) {
        state.warnings.add('CONTENT_CLIPPED');
      }
      const screenshot = await this.captureWebp(page, height);
      return {
        screenshot,
        width: SCREENSHOT_WIDTH,
        height,
        warnings: [...state.warnings].map((code) => ({ code })),
      };
    } catch (error) {
      if (error instanceof HtmlRenderError) {
        throw error;
      }
      throw new HtmlRenderError('HTML_RENDER_FAILED', { cause: error });
    } finally {
      await context?.close().catch(() => undefined);
      handle.context = undefined;
      releaseContextSlot?.();
    }
  }

  async close(): Promise<void> {
    const browser = this.browser ?? (await this.browserLaunch?.catch(() => null));
    this.browser = null;
    this.browserLaunch = null;
    await browser?.close().catch(() => undefined);
  }

  private async createContext(signal: AbortSignal): Promise<BrowserContext> {
    const browser = await this.ensureBrowser();
    if (signal.aborted) {
      throw new HtmlRenderError('TIMEOUT');
    }
    const context = await browser.newContext({
      acceptDownloads: false,
      javaScriptEnabled: false,
      serviceWorkers: 'block',
      viewport: { width: SCREENSHOT_WIDTH, height: 800 },
    });
    await context.clearPermissions();
    return context;
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) {
      return this.browser;
    }
    if (!this.browserLaunch) {
      const launch = this.launchBrowser().then((browser) => {
        this.browser = browser;
        browser.on('disconnected', () => {
          if (this.browser === browser) {
            this.browser = null;
          }
        });
        return browser;
      });
      this.browserLaunch = launch;
      void launch.then(
        () => {
          if (this.browserLaunch === launch) this.browserLaunch = null;
        },
        () => {
          if (this.browserLaunch === launch) this.browserLaunch = null;
        },
      );
    }
    return this.browserLaunch;
  }

  private async handleRoute(
    route: Route,
    sourcePath: string,
    assetToken: string,
    state: RenderState,
  ): Promise<void> {
    /*
     * Default-deny decision tree:
     * request -> virtual local asset? -- no --> abort + warning
     *                              `-- yes -> authorizeAsset -> fulfill | abort
     */
    const assetPath = this.localAssetPath(route.request().url(), sourcePath, assetToken);
    if (!assetPath) {
      state.warnings.add('ASSET_BLOCKED');
      if (route.request().isNavigationRequest()) {
        state.blockedNavigation = true;
      }
      await route.abort('blockedbyclient');
      return;
    }
    try {
      const asset = await this.pathPolicy.authorizeAsset(assetPath);
      const bytes = await asset.read();
      if (
        bytes.byteLength > MAX_ASSET_BYTES ||
        state.totalAssetBytes + bytes.byteLength > MAX_TOTAL_ASSET_BYTES
      ) {
        state.error = new HtmlRenderError('ASSET_TOO_LARGE');
        await route.abort('blockedbyclient');
        return;
      }
      state.totalAssetBytes += bytes.byteLength;
      await route.fulfill({
        status: 200,
        body: bytes,
        contentType: asset.mimeType,
        headers: { 'x-content-type-options': 'nosniff' },
      });
    } catch {
      state.warnings.add('ASSET_BLOCKED');
      await route.abort('blockedbyclient');
    }
  }

  private localAssetPath(requestUrl: string, sourcePath: string, assetToken: string): string | null {
    let url: URL;
    try {
      url = new URL(requestUrl);
    } catch {
      return null;
    }
    const prefix = `/${assetToken}/`;
    if (url.origin !== VIRTUAL_ASSET_ORIGIN || !url.pathname.startsWith(prefix)) {
      return null;
    }
    let relativePath: string;
    try {
      relativePath = decodeURIComponent(url.pathname.slice(prefix.length));
    } catch {
      return null;
    }
    if (
      relativePath.length === 0 ||
      relativePath.includes('\0') ||
      relativePath.includes('\\') ||
      relativePath.split('/').includes('..')
    ) {
      return null;
    }
    return resolve(dirname(sourcePath), relativePath);
  }

  private blockPageCapabilities(page: Page, warnings: Set<HtmlRenderWarningCode>): void {
    page.on('console', (message) => {
      const text = message.text();
      if (
        text.includes('Content Security Policy') ||
        text.includes('Not allowed to load local resource')
      ) {
        warnings.add('ASSET_BLOCKED');
      }
    });
    page.on('dialog', (dialog) => {
      warnings.add('ASSET_BLOCKED');
      void dialog.dismiss();
    });
    page.on('download', (download) => {
      warnings.add('ASSET_BLOCKED');
      void download.cancel();
    });
    page.on('popup', (popup) => {
      warnings.add('ASSET_BLOCKED');
      void popup.close();
    });
  }

  private isolatedDocument(html: string, assetToken: string): string {
    return `<meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}">
      <base href="${VIRTUAL_ASSET_ORIGIN}/${assetToken}/">
      ${html}`;
  }

  private async replaceBlockedNavigation(page: Page): Promise<void> {
    await page.goto('about:blank', { waitUntil: 'commit' });
    await page.setContent(
      `<meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}">`,
      { waitUntil: 'load' },
    );
  }

  private async captureWebp(page: Page, height: number): Promise<Buffer> {
    const session = await page.context().newCDPSession(page);
    try {
      const result = await session.send('Page.captureScreenshot', {
        format: 'webp',
        quality: 80,
        clip: { x: 0, y: 0, width: SCREENSHOT_WIDTH, height, scale: 1 },
        captureBeyondViewport: true,
      });
      return Buffer.from(result.data, 'base64');
    } finally {
      await session.detach().catch(() => undefined);
    }
  }
}
