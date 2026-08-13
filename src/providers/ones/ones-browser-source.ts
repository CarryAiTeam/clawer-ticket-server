import { existsSync } from "node:fs";
import { chromium, Browser, BrowserContext, Page } from "playwright-core";
import { OnesConfig, OnesProfile } from "./ones-config.js";
import { TicketAttachment } from "../../modules/tickets/domain/ticket.js";
import { TicketError as OnesError } from "../../modules/tickets/domain/ticket-error.js";
import { BrowserSessionProvider, BrowserSessionStatus, ConnectionStatus, TicketMediaDownload, TicketMediaDownloadOptions, TicketProfile } from "../../modules/tickets/domain/ports.js";
import { HttpResponse, parseJsonResponse } from "../../infrastructure/http/fetch-http-client.js";
import { OnesGraphqlSource, myOpenTicketSearchQuery } from "./ones-graphql-source.js";

type BrowserFetchResult = { status: number; text: string; contentType: string; csrfToken?: string; retryAfter?: string };
const DEFAULT_CHROME_PATHS = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
];

const DIRECT_LOGIN_ACCOUNT_SELECTOR = [
  "input[type='email']",
  "input[name='email']",
  "input[name='username']",
  "input[name='account']",
  "input[name='login_name']",
  "input[name='loginName']",
  "input[autocomplete='email']",
  "input[autocomplete='username']",
  "input[placeholder*='邮箱']",
  "input[placeholder*='用户名']",
  "input[placeholder*='账号']",
].join(", ");

const DIRECT_LOGIN_PASSWORD_SELECTOR = [
  "input[type='password']",
  "input[name='password']",
  "input[name='passwd']",
  "input[name='pwd']",
  "input[autocomplete='current-password']",
  "input[placeholder*='密码']",
].join(", ");

const DIRECT_LOGIN_SUBMIT_SELECTOR = [
  "button[type='submit']",
  "input[type='submit']",
  "button:has-text('登录')",
  "button:has-text('登 录')",
].join(", ");

/**
 * 目标系统可能在提交登录表单后异步建立会话；这里使用有界且稀疏的探测等待，
 * 避免超出 profile 的请求预算。
 */
const AUTO_LOGIN_AUTHORIZATION_DELAYS_MS = [500, 1_000, 2_000, 4_000] as const;

/**
 * ONES 浏览器 provider 使用可见窗口和全新的内存 context，不使用持久化个人资料目录。
 * 可选的直登只处理受控的邮箱密码表单，不读取、导出或持久化 Cookie 与凭据。
 */
export class OnesBrowserSource extends OnesGraphqlSource implements BrowserSessionProvider {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private csrfToken?: string;
  private activeProfileName?: string;

  /** 创建浏览器 provider，并保留会话状态在当前 MCP 进程内。 */
  constructor(config: OnesConfig) {
    // 浏览器认证基于会话，因此刻意不使用基础密钥 provider。
    super(config);
  }

  /** 打开可见浏览器，并在配置直登时等待 ONES 授权探测结果。 */
  async openBrowserSession(ticketProfile: TicketProfile): Promise<BrowserSessionStatus> {
    const profile = this.profileFor(ticketProfile);
    if (profile.source !== "browser") throw new OnesError("CONFIG_INVALID", "This profile is configured for direct GraphQL, not the interactive browser source");
    const created = !this.page || this.page.isClosed();
    const page = await this.ensurePage(ticketProfile.name, profile);
    const autoLoginConfigured = Boolean(profile.browser?.autoLogin);
    const authorization = autoLoginConfigured
      ? await this.waitForAutoLoginAuthorization(ticketProfile, page)
      : { authorized: false, diagnostics: ["sign in to ONES in the visible browser session, then check connection status"] };
    return {
      url: page.url(),
      message: autoLoginConfigured
        ? authorization.authorized
          ? "A visible temporary browser was opened and automatic direct login was confirmed by ONES. The session is ready for ticket tools and remains only while this MCP process is running."
          : "A visible temporary browser was opened and direct-login credentials were submitted, but ONES authorization is not yet confirmed. Complete any MFA, CAPTCHA, SSO, or other challenge in the window, then check connection status before reading tickets. The session remains only while this MCP process is running."
        : "A visible temporary browser was opened. Sign in to ONES there, then call the requested ticket tool again. The session remains only while this MCP process is running.",
      authentication: {
        mode: autoLoginConfigured ? "auto" : "manual",
        authorized: authorization.authorized,
        diagnostics: authorization.diagnostics,
      },
      created,
    };
  }

  /** 关闭浏览器并清理所有内存中的会话、CSRF 和缓存数据。 */
  async closeBrowserSession(ticketProfile: TicketProfile): Promise<void> {
    const profile = this.profileFor(ticketProfile);
    if (profile.source !== "browser") throw new OnesError("CONFIG_INVALID", "This profile is not configured for the interactive browser source");
    await this.browser?.close();
    this.browser = undefined;
    this.context = undefined;
    this.page = undefined;
    this.csrfToken = undefined;
    this.activeProfileName = undefined;
  }

  /** 对浏览器 profile 执行窄范围授权探测，不触发页面 reconciliation。 */
  override async status(ticketProfile: TicketProfile): Promise<ConnectionStatus> {
    const profile = this.profileFor(ticketProfile);
    if (profile.source !== "browser") return super.status(ticketProfile);
    if (!this.page || this.page.isClosed() || this.activeProfileName !== ticketProfile.name) {
      return { configured: true, credentialAvailable: false, authorized: false, diagnostics: ["open the supervised browser session and sign in to ONES before using this profile"] };
    }
    try {
      // 授权探测只执行最小受控搜索，不触发旧的树形视图校准。
      await this.search(ticketProfile, myOpenTicketSearchQuery(1));
      return { configured: true, credentialAvailable: true, authorized: true, diagnostics: ["the visible supervised browser session was accepted by ONES"] };
    } catch (error) {
      if (error instanceof OnesError && (error.code === "SOURCE_UNAUTHORIZED" || error.code === "HUMAN_ACTION_REQUIRED")) {
        return { configured: true, credentialAvailable: true, authorized: false, diagnostics: ["sign in to ONES in the visible browser session, then retry"] };
      }
      if (error instanceof OnesError) return { configured: true, credentialAvailable: true, authorized: false, diagnostics: [`browser authorization probe failed: ${error.code}`] };
      throw error;
    }
  }

  /** 使用可见浏览器的内存认证上下文；不读取或持久化 Cookie。 */
  override async downloadAttachment(ticketProfile: TicketProfile, attachment: TicketAttachment, options?: TicketMediaDownloadOptions): Promise<TicketMediaDownload> {
    const profile = this.profileFor(ticketProfile);
    if (profile.source !== "browser") return super.downloadAttachment(ticketProfile, attachment, options);
    const url = await this.resolveAttachmentUrl(profile, attachment.id);
    return this.withRequestSlot(profile, () => this.retryRateLimited(profile, async () => {
      await this.acquireBudget(profile);
      const page = this.requireActivePage(profile);
      const encoded = await page.evaluate(async ({ value, maxBytes }) => {
        const response = await fetch(value, { credentials: "include" });
        if (!response.ok) return { status: response.status, contentType: response.headers.get("content-type") ?? "", retryAfter: response.headers.get("retry-after") ?? undefined, base64: "" };
        const declaredSize = Number(response.headers.get("content-length"));
        if (maxBytes !== undefined && Number.isSafeInteger(declaredSize) && declaredSize > maxBytes) {
          return { status: response.status, contentType: response.headers.get("content-type") ?? "", retryAfter: response.headers.get("retry-after") ?? undefined, base64: "", tooLarge: true };
        }
        const reader = response.body?.getReader();
        if (!reader) return { status: response.status, contentType: response.headers.get("content-type") ?? "", retryAfter: response.headers.get("retry-after") ?? undefined, base64: "" };
        const chunks: Uint8Array[] = [];
        let total = 0;
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            const candidate = total + next.value.byteLength;
            if (maxBytes !== undefined && (!Number.isSafeInteger(candidate) || candidate > maxBytes)) {
              await reader.cancel();
              return { status: response.status, contentType: response.headers.get("content-type") ?? "", retryAfter: response.headers.get("retry-after") ?? undefined, base64: "", tooLarge: true };
            }
            total = candidate;
            chunks.push(next.value);
          }
        } finally {
          reader.releaseLock();
        }
        const bytes = new Uint8Array(total);
        let byteOffset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, byteOffset);
          byteOffset += chunk.byteLength;
        }
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
        return { status: response.status, contentType: response.headers.get("content-type") ?? "", retryAfter: response.headers.get("retry-after") ?? undefined, base64: btoa(binary) };
      }, { value: url.toString(), maxBytes: options?.maxBytes }) as { status: number; contentType: string; retryAfter?: string; base64: string; tooLarge?: boolean };
      if (encoded.status === 401 || encoded.status === 403) throw new OnesError("HUMAN_ACTION_REQUIRED", "ONES requires an authenticated visible browser session for attachment download");
      if (encoded.status === 429) throw this.rateLimited("attachment download was rate limited", encoded.retryAfter ?? null);
      if (encoded.status < 200 || encoded.status >= 300) throw new OnesError("SOURCE_FAILED", `attachment download returned ${encoded.status}`);
      if (encoded.tooLarge) throw new OnesError("EXPORT_LIMIT_EXCEEDED", `attachment download exceeds the configured per-file limit of ${options?.maxBytes ?? 0} bytes`);
      return { attachment, bytes: Uint8Array.from(Buffer.from(encoded.base64, "base64")), ...(encoded.contentType ? { contentType: encoded.contentType } : {}) };
    }));
  }

  /**
   * 表单提交成功不等于 ONES 会话已立即可用；只在短暂结算窗口内重试，
   * MFA、SSO 和 CAPTCHA 仍交由用户在可见窗口中完成。
   */
  private async waitForAutoLoginAuthorization(
    ticketProfile: TicketProfile,
    page: Page,
  ): Promise<ConnectionStatus> {
    let authorization: ConnectionStatus = { configured: true, credentialAvailable: true, authorized: false, diagnostics: ["browser authorization is pending"] };
    for (const delay of AUTO_LOGIN_AUTHORIZATION_DELAYS_MS) {
      await page.waitForTimeout(delay);
      authorization = await this.status(ticketProfile);
      if (authorization.authorized) return authorization;
    }
    return authorization;
  }

  /** 通过可见页面的同源 fetch 发送 ONES 请求，并维护 CSRF token。 */
  protected override async requestJson(profile: OnesProfile, method: "GET" | "POST", relativePath: string, body?: string): Promise<unknown> {
    if (profile.source !== "browser") return super.requestJson(profile, method, relativePath, body);
    return this.withRequestSlot(profile, () => this.retryRateLimited(profile, async () => {
      await this.acquireBudget(profile);
      const page = this.requireActivePage(profile);
      const endpoint = new URL(`/project/api/project/team/${encodeURIComponent(profile.teamId)}/${relativePath}`, profile.baseUrl);
      if (!profile.allowedHosts.includes(endpoint.host)) throw new OnesError("SOURCE_FAILED", "Resolved endpoint is outside the profile host allowlist");
      const result = await page.evaluate(async ({ url, method, body, csrfToken }) => {
        const headers: Record<string, string> = { accept: "application/json", "Accept-Language": navigator.language };
        if (body) headers["content-type"] = "application/json";
        if (csrfToken) headers["X-CSRF-TOKEN"] = csrfToken;
        else headers["X-REQUEST-CSRF-TOKEN"] = "1";
        const response = await fetch(url, { method, headers, credentials: "include", ...(body ? { body } : {}) });
        return {
          status: response.status,
          text: await response.text(),
          contentType: response.headers.get("content-type") ?? "",
          csrfToken: response.headers.get("x-csrf-token") ?? undefined,
          retryAfter: response.headers.get("retry-after") ?? undefined,
        };
      }, { url: endpoint.toString(), method, body, csrfToken: this.csrfToken }) as BrowserFetchResult;
      if (result.csrfToken) this.csrfToken = result.csrfToken;
      if (result.status === 429) throw this.rateLimited("ONES request was rate limited", result.retryAfter ?? null);
      if (result.status === 401 || result.status === 403) {
        throw new OnesError("HUMAN_ACTION_REQUIRED", "ONES requires an authenticated visible browser session; sign in and retry");
      }
      return parseJsonResponse({ status: result.status, headers: new Headers({ "content-type": result.contentType }), text: result.text } satisfies HttpResponse);
    }));
  }

  /** 确认当前存在可用页面，且页面属于当前激活 profile。 */
  private requireActivePage(profile: OnesProfile): Page {
    if (!this.page || this.page.isClosed()) {
      throw new OnesError("HUMAN_ACTION_REQUIRED", "Open the supervised browser session, sign in to ONES, then retry");
    }
    if (this.activeProfileName && this.activeProfileName !== this.profileName(profile)) {
      throw new OnesError("HUMAN_ACTION_REQUIRED", "A different browser profile is active; close it before connecting this profile");
    }
    return this.page;
  }

  /** 启动临时 Chrome、创建内存 context 并导航到受控入口。 */
  protected async ensurePage(profileName: string, profile: OnesProfile): Promise<Page> {
    if (this.page && !this.page.isClosed()) {
      if (this.activeProfileName !== profileName) {
        throw new OnesError("HUMAN_ACTION_REQUIRED", "A different browser profile is active; close it before connecting this profile");
      }
      return this.page;
    }
    const executablePath = profile.browser?.executablePath ?? process.env.ONES_BROWSER_EXECUTABLE_PATH ?? DEFAULT_CHROME_PATHS.find(existsSync);
    if (!executablePath) {
      throw new OnesError("HUMAN_ACTION_REQUIRED", "Chrome was not found. Configure profiles.<name>.browser.executablePath or ONES_BROWSER_EXECUTABLE_PATH");
    }
    try {
      this.browser = await chromium.launch({ executablePath, headless: false, args: ["--no-first-run", "--no-default-browser-check"] });
    } catch (error) {
      throw new OnesError("HUMAN_ACTION_REQUIRED", `Unable to open the supervised Chrome session: ${error instanceof Error ? error.message : "unknown error"}`);
    }
    this.context = await this.browser.newContext();
    this.page = await this.context.newPage();
    const startUrl = new URL(`/project/#/workspace/team/${encodeURIComponent(profile.teamId)}`, profile.baseUrl).toString();
    await this.page.goto(startUrl, { waitUntil: "domcontentloaded" });
    // 先绑定会话，确保自动登录失败时仍可在此可见窗口手动完成登录。
    this.activeProfileName = profileName;
    await this.autoLogin(profile, this.page);
    return this.page;
  }

  /**
   * 仅执行常规邮箱密码直登，不处理 MFA、验证码、SSO 确认或任意页面脚本。
   */
  protected async autoLogin(profile: OnesProfile, page: Page): Promise<void> {
    const login = profile.browser?.autoLogin;
    if (!login) return;

    try {
      const loginUrl = login.loginUrl ?? new URL("/login", profile.baseUrl).toString();
      await page.goto(loginUrl, { waitUntil: "domcontentloaded" });
      if (!this.isAllowedBrowserPage(profile, page)) throw new Error("login page is outside the host allowlist");
      const emailInput = page.locator(DIRECT_LOGIN_ACCOUNT_SELECTOR).first();
      const passwordInput = page.locator(DIRECT_LOGIN_PASSWORD_SELECTOR).first();
      await emailInput.waitFor({ state: "visible", timeout: 10_000 });
      await passwordInput.waitFor({ state: "visible", timeout: 10_000 });
      await emailInput.fill(login.email);
      await passwordInput.fill(login.password);
      await page.locator(DIRECT_LOGIN_SUBMIT_SELECTOR).first().click();
    } catch {
      throw new OnesError(
        "HUMAN_ACTION_REQUIRED",
        "The configured browser auto-login could not complete a controlled direct email/password login. Complete sign-in manually; MFA, CAPTCHA, SSO, and custom login pages are not automated.",
      );
    }
  }

  /** 判断浏览器当前页面 host 是否仍在 profile allowlist 中。 */
  private isAllowedBrowserPage(profile: OnesProfile, page: Page): boolean {
    try {
      return profile.allowedHosts.includes(new URL(page.url()).host);
    } catch {
      return false;
    }
  }

  /** 由受控 ONES profile 对象反查配置名称，用于隔离单一临时浏览器会话。 */
  private profileName(profile: OnesProfile): string | undefined {
    return Object.entries(this.config.profiles).find(([, candidate]) => candidate === profile)?.[0];
  }

}
