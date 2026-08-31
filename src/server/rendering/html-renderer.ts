import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';

import * as cssTree from 'css-tree';
import {
  parse as parseHtml,
  serialize as serializeHtml,
  type DefaultTreeAdapterTypes,
} from 'parse5';
import { chromium, type Browser, type BrowserContext, type Page, type Route } from 'playwright';

import {
  AssetReadLimitError,
  type AuthorizedAsset,
  type PathPolicy,
} from '../security/path-policy.js';

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

const HTML_URL_ATTRIBUTES = new Set([
  'action',
  'background',
  'cite',
  'data',
  'formaction',
  'href',
  'longdesc',
  'manifest',
  'poster',
  'src',
  'xlink:href',
]);

const SVG_CSS_URL_ATTRIBUTES = new Set([
  'clip-path',
  'cursor',
  'fill',
  'filter',
  'marker',
  'marker-end',
  'marker-mid',
  'marker-start',
  'mask',
  'stroke',
]);

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
  readonly assetBudget: AssetBudget;
  blockedNavigation: boolean;
  error?: HtmlRenderError;
}

class AssetBudget {
  private remainingBytes = MAX_TOTAL_ASSET_BYTES;
  private failed = false;
  private tail: Promise<void> = Promise.resolve();

  read(asset: AuthorizedAsset): Promise<Buffer> {
    const operation = this.tail.then(() => this.readNext(asset));
    this.tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async readNext(asset: AuthorizedAsset): Promise<Buffer> {
    if (this.failed || this.remainingBytes <= 0) {
      this.failed = true;
      throw new AssetReadLimitError(Math.max(0, this.remainingBytes));
    }
    const reservedBytes = Math.min(MAX_ASSET_BYTES, this.remainingBytes);
    try {
      const bytes = await asset.read(reservedBytes);
      if (bytes.byteLength > reservedBytes) {
        throw new AssetReadLimitError(reservedBytes);
      }
      this.remainingBytes -= bytes.byteLength;
      return bytes;
    } catch (error) {
      if (error instanceof AssetReadLimitError) this.failed = true;
      throw error;
    }
  }
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
      context = await this.createContext(signal, handle);
      const state: RenderState = {
        warnings: new Set(),
        assetBudget: new AssetBudget(),
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
      const virtualBaseUrl = `${VIRTUAL_ASSET_ORIGIN}/${assetToken}/`;
      const rewrittenHtml = this.rewriteHtmlAssetReferences(
        request.html,
        virtualBaseUrl,
        state.warnings,
      );
      await page.setContent(this.isolatedDocument(rewrittenHtml, assetToken), {
        waitUntil: 'load',
      });
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

  private async createContext(
    signal: AbortSignal,
    handle: RenderAttemptHandle,
  ): Promise<BrowserContext> {
    const browser = await this.awaitAttempt(this.ensureBrowser(), signal);
    this.assertAttemptActive(signal);
    let context: BrowserContext | undefined;
    try {
      context = await this.awaitAttempt(
        browser.newContext({
          acceptDownloads: false,
          javaScriptEnabled: false,
          serviceWorkers: 'block',
          viewport: { width: SCREENSHOT_WIDTH, height: 800 },
        }),
        signal,
        (lateContext) => lateContext.close(),
      );
      handle.context = context;
      this.assertAttemptActive(signal);
      await this.awaitAttempt(context.clearPermissions(), signal);
      this.assertAttemptActive(signal);
      return context;
    } catch (error) {
      await context?.close().catch(() => undefined);
      if (handle.context === context) handle.context = undefined;
      throw error;
    }
  }

  private assertAttemptActive(signal: AbortSignal): void {
    if (signal.aborted) throw new HtmlRenderError('TIMEOUT');
  }

  private awaitAttempt<T>(
    operation: Promise<T>,
    signal: AbortSignal,
    disposeLateResult?: (value: T) => Promise<unknown>,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        reject(new HtmlRenderError('TIMEOUT'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
      void operation.then(
        (value) => {
          if (settled) {
            void disposeLateResult?.(value).catch(() => undefined);
            return;
          }
          settled = true;
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
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
      const bytes = await state.assetBudget.read(asset);
      const body = asset.mimeType.startsWith('text/css')
        ? Buffer.from(
            this.rewriteCssAssetReferences(
              bytes.toString('utf8'),
              route.request().url(),
              `${VIRTUAL_ASSET_ORIGIN}/${assetToken}/`,
              'stylesheet',
              state.warnings,
            ),
          )
        : bytes;
      await route.fulfill({
        status: 200,
        body,
        contentType: asset.mimeType,
        headers: {
          'access-control-allow-origin': '*',
          'x-content-type-options': 'nosniff',
        },
      });
    } catch (error) {
      if (error instanceof AssetReadLimitError) {
        state.error = new HtmlRenderError('ASSET_TOO_LARGE');
      } else {
        state.warnings.add('ASSET_BLOCKED');
      }
      await route.abort('blockedbyclient').catch(() => undefined);
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

  private rewriteHtmlAssetReferences(
    html: string,
    virtualBaseUrl: string,
    warnings: Set<HtmlRenderWarningCode>,
  ): string {
    const document = parseHtml(html);
    const visit = (node: DefaultTreeAdapterTypes.Node): void => {
      if (isHtmlElement(node)) {
        if (node.tagName === 'base') {
          const hadBaseCapability = node.attrs.some(({ name }) => name === 'href' || name === 'target');
          node.attrs = node.attrs.filter(({ name }) => name !== 'href' && name !== 'target');
          if (hadBaseCapability) warnings.add('ASSET_BLOCKED');
        }
        if (
          node.tagName === 'meta' &&
          node.attrs.some(
            ({ name, value }) => name === 'http-equiv' && value.toLowerCase() === 'refresh',
          )
        ) {
          const content = node.attrs.find(({ name }) => name === 'content');
          if (content) content.value = '';
          warnings.add('ASSET_BLOCKED');
        }

        for (const attribute of node.attrs) {
          const attributeName = attribute.name.toLowerCase();
          if (HTML_URL_ATTRIBUTES.has(attributeName)) {
            const rewritten = rewriteLocalAssetUrl(
              attribute.value,
              virtualBaseUrl,
              virtualBaseUrl,
            );
            if (rewritten === null) {
              attribute.value = 'data:,blocked';
              warnings.add('ASSET_BLOCKED');
            } else {
              attribute.value = rewritten;
            }
          } else if (attributeName === 'srcset' || attributeName === 'ping') {
            attribute.value = '';
            warnings.add('ASSET_BLOCKED');
          } else if (attributeName === 'srcdoc') {
            attribute.value = '';
            warnings.add('ASSET_BLOCKED');
          } else if (attributeName === 'style') {
            attribute.value = this.rewriteCssAssetReferences(
              attribute.value,
              virtualBaseUrl,
              virtualBaseUrl,
              'declarationList',
              warnings,
            );
          } else if (SVG_CSS_URL_ATTRIBUTES.has(attributeName)) {
            attribute.value = this.rewriteCssAssetReferences(
              attribute.value,
              virtualBaseUrl,
              virtualBaseUrl,
              'value',
              warnings,
            );
          }
        }

        if (node.tagName === 'style') {
          const stylesheet = node.childNodes
            .filter(isHtmlTextNode)
            .map(({ value }) => value)
            .join('');
          node.childNodes = [
            {
              nodeName: '#text',
              parentNode: node,
              value: this.rewriteCssAssetReferences(
                stylesheet,
                virtualBaseUrl,
                virtualBaseUrl,
                'stylesheet',
                warnings,
              ),
            },
          ];
        }
        if (node.tagName === 'template' && 'content' in node) {
          visit(node.content);
        }
      }
      if ('childNodes' in node) {
        for (const child of node.childNodes) visit(child);
      }
    };
    visit(document);
    return serializeHtml(document);
  }

  private rewriteCssAssetReferences(
    css: string,
    resolutionBaseUrl: string,
    virtualAssetRootUrl: string,
    context: 'stylesheet' | 'declarationList' | 'value',
    warnings: Set<HtmlRenderWarningCode>,
  ): string {
    let malformed = false;
    let ast: cssTree.CssNode;
    try {
      ast = cssTree.parse(css, {
        context,
        parseCustomProperty: true,
        onParseError: () => {
          malformed = true;
        },
      });
    } catch {
      warnings.add('ASSET_BLOCKED');
      return '';
    }
    cssTree.walk(ast, function (node) {
      if (node.type === 'Raw') {
        malformed = true;
        return;
      }
      const stringIsAssetUrl =
        node.type === 'String' &&
        (this.atrule?.name.toLowerCase() === 'import' ||
          this.function?.name.toLowerCase() === 'image-set' ||
          this.function?.name.toLowerCase() === '-webkit-image-set');
      if (node.type !== 'Url' && !stringIsAssetUrl) return;
      const rewritten = rewriteLocalAssetUrl(
        node.value,
        resolutionBaseUrl,
        virtualAssetRootUrl,
      );
      if (rewritten === null) {
        node.value = 'data:,blocked';
        warnings.add('ASSET_BLOCKED');
      } else {
        node.value = rewritten;
      }
    });
    if (malformed) {
      warnings.add('ASSET_BLOCKED');
      return '';
    }
    return cssTree.generate(ast);
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

function isHtmlElement(
  node: DefaultTreeAdapterTypes.Node,
): node is DefaultTreeAdapterTypes.Element | DefaultTreeAdapterTypes.Template {
  return 'tagName' in node;
}

function isHtmlTextNode(
  node: DefaultTreeAdapterTypes.ChildNode,
): node is DefaultTreeAdapterTypes.TextNode {
  return node.nodeName === '#text';
}

function rewriteLocalAssetUrl(
  rawUrl: string,
  resolutionBaseUrl: string,
  virtualAssetRootUrl: string,
): string | null {
  const candidate = rawUrl.trim();
  if (candidate.startsWith('#') || candidate.toLowerCase().startsWith('data:')) {
    return candidate;
  }
  if (candidate.length === 0 || containsTraversalAfterDecoding(candidate)) {
    return null;
  }
  try {
    const url = new URL(candidate, resolutionBaseUrl);
    const virtualRoot = new URL(virtualAssetRootUrl);
    if (
      url.origin !== virtualRoot.origin ||
      !url.pathname.startsWith(virtualRoot.pathname) ||
      url.username !== '' ||
      url.password !== ''
    ) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

function containsTraversalAfterDecoding(rawUrl: string): boolean {
  let decoded = rawUrl;
  for (let depth = 0; depth < 8; depth += 1) {
    if (decoded.includes('\0') || decoded.includes('\\')) return true;
    const path = decoded.split(/[?#]/u, 1)[0] ?? '';
    if (path.startsWith('/') || path.split('/').includes('..')) return true;
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return true;
    }
    if (next === decoded) return false;
    decoded = next;
  }
  return true;
}
