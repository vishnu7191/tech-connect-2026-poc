import { chromium, type Browser, type BrowserContext, type Page, type Frame } from 'playwright';
import path from 'node:path';
import { env } from '../config/env.js';
import { BrowserError } from '../core/errors.js';
import { logger } from '../core/logger.js';
import { isAllowedFigmaHost } from '../figma/url.js';

export type DeviceClassName = 'desktop' | 'mobile';

export const VIEWPORTS: Record<DeviceClassName, { width: number; height: number }> = {
  // Fixed per device class so screenshots are comparable across runs and the
  // vision model always sees consistent framing.
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
};

export interface SessionOptions {
  device?: DeviceClassName;
  /** Directory for Playwright video output. Recording must be enabled at
   *  context creation - it cannot be turned on later. */
  videoDir?: string;
  headless?: boolean;
}

/**
 * Wraps one Playwright BrowserContext.
 *
 * Guarantees teardown (including on cancellation) so browser processes and temp
 * profiles never leak, and centralizes the Figma-viewer quirks discovered
 * during live probing.
 */
export class BrowserSession {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private bannersDismissed = false;

  constructor(private readonly opts: SessionOptions = {}) {}

  get device(): DeviceClassName {
    return this.opts.device ?? 'desktop';
  }

  async start(): Promise<Page> {
    const viewport = VIEWPORTS[this.device];
    try {
      this.browser = await chromium.launch({
        headless: this.opts.headless ?? env.HEADLESS,
        args: ['--disable-dev-shm-usage'],
      });
      this.context = await this.browser.newContext({
        viewport,
        deviceScaleFactor: 1,
        ...(this.opts.videoDir
          ? { recordVideo: { dir: this.opts.videoDir, size: viewport } }
          : {}),
      });

      /**
       * SSRF defence at the browser layer.
       *
       * Two different things need different rules:
       *
       *  - DOCUMENT navigation is restricted to Figma origins. This is the
       *    control that matters: the AI can never cause the browser to visit
       *    an arbitrary URL.
       *  - SUBRESOURCES (scripts, styles, fonts, images, XHR) may additionally
       *    come from well-known public CDNs. Figma Make applications are
       *    user-authored web apps that legitimately load libraries from CDNs;
       *    blocking those was observed to leave the app stuck on its loading
       *    screen, which produced an empty, useless discovery run.
       *
       * Everything else is still aborted.
       */
      await this.context.route('**/*', (route) => {
        const request = route.request();
        const url = request.url();
        if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('about:')) {
          return route.continue();
        }
        let host: string;
        try {
          host = new URL(url).hostname;
        } catch {
          return route.abort();
        }

        const isFigma = isAllowedFigmaHost(host) || isFigmaAsset(host);
        if (isFigma) return route.continue();

        // Only non-document resources may come from an allow-listed CDN.
        const isDocument = request.resourceType() === 'document';
        if (!isDocument && isAllowedAssetCdn(host)) return route.continue();

        return route.abort();
      });

      this.page = await this.context.newPage();
      this.page.setDefaultTimeout(45_000);
      return this.page;
    } catch (err) {
      await this.close();
      throw new BrowserError('Could not start the browser', (err as Error).message);
    }
  }

  getPage(): Page {
    if (!this.page) throw new BrowserError('Browser session has not been started');
    return this.page;
  }

  /**
   * Dismiss the Figma viewer's cookie banner and hardware-acceleration toast.
   *
   * Both were observed live. They reappear after navigation, so this MUST run
   * before every capture rather than once per session - otherwise they end up
   * baked into screenshots and corrupt the UX analysis that reads them.
   *
   * Uses count() rather than isVisible() with a timeout, so the common case
   * (no banner) costs a few milliseconds instead of seconds per selector.
   */
  async dismissBanners(): Promise<void> {
    const page = this.getPage();
    const selectors = [
      'button:has-text("Allow all cookies")',
      'button:has-text("Do not allow cookies")',
      'button:has-text("Dismiss")',
      '[data-testid="cookie-banner"] button',
    ];
    let clicked = false;
    for (const sel of selectors) {
      try {
        const el = page.locator(sel).first();
        if ((await el.count()) > 0 && (await el.isVisible())) {
          await el.click({ timeout: 1500 });
          clicked = true;
          await page.waitForTimeout(200);
        }
      } catch {
        // Banner absent, detached, or already gone - never fatal.
      }
    }
    if (clicked) await page.waitForTimeout(300);
    this.bannersDismissed = true;
  }

  get hasDismissedBanners(): boolean {
    return this.bannersDismissed;
  }

  /**
   * Resolve the Figma Make preview iframe.
   *
   * Verified live: the top-level page is Figma chrome (sign-in, cookie banner);
   * the real application renders in a nested iframe served from
   * <uuid>-figmacachedpreview.figma.site. Capturing the top-level page would
   * embed Figma chrome in every screenshot.
   */
  async resolveMakePreviewFrame(timeoutMs = 30_000): Promise<Frame> {
    const page = this.getPage();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const frame = page.frames().find((f) => {
        try {
          return new URL(f.url()).hostname.endsWith('.figma.site');
        } catch {
          return false;
        }
      });
      if (frame) return frame;
      await page.waitForTimeout(750);
    }
    throw new BrowserError(
      'Could not locate the Figma Make preview frame. The application may still be loading, or the link may require sign-in.',
    );
  }

  /** Finalize and return the recorded video path, or null if not recording. */
  async finalizeVideo(): Promise<string | null> {
    if (!this.opts.videoDir || !this.page) return null;
    const video = this.page.video();
    if (!video) return null;
    try {
      // The file is only written when the context closes.
      await this.context?.close();
      this.context = null;
      return await video.path();
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Could not finalize video recording');
      return null;
    }
  }

  async close(): Promise<void> {
    try {
      await this.context?.close();
    } catch {
      /* already closed */
    }
    try {
      await this.browser?.close();
    } catch {
      /* already closed */
    }
    this.context = null;
    this.browser = null;
    this.page = null;
  }
}

/**
 * Public CDNs a Figma Make application may legitimately pull libraries from.
 * Subresources only - never document navigation.
 */
const ASSET_CDN_HOSTS = [
  'cdnjs.cloudflare.com',
  'cdn.jsdelivr.net',
  'unpkg.com',
  'esm.sh',
  'cdn.skypack.dev',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'cdn.tailwindcss.com',
  'code.jquery.com',
  'images.unsplash.com',
];

export function isAllowedAssetCdn(host: string): boolean {
  const h = host.toLowerCase();
  return ASSET_CDN_HOSTS.some((c) => h === c || h.endsWith(`.${c}`));
}

/** Figma serves images and fonts from S3/CDN hosts that are not figma.com. */
function isFigmaAsset(host: string): boolean {
  return (
    host.endsWith('.figma.com') ||
    host.endsWith('figma.site') ||
    /^s3[-.].*\.amazonaws\.com$/.test(host) ||
    host === 'figma-alpha-api.s3.us-west-2.amazonaws.com' ||
    host.endsWith('.fontawesome.com') ||
    host.endsWith('.gstatic.com') ||
    host.endsWith('.googleapis.com')
  );
}

export function videoDirFor(executionId: string, root: string): string {
  return path.join(root, 'videos', executionId);
}
