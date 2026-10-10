import { wikiMode } from "./wikiStorage";
/**
 * 网站服务器(账号、云同步、分享短链接、我们的 AI 共用一台):地址和请求。
 *
 * 基址:构建变量 VITE_AI_SERVER(如 https://ai.example.com)。没配置 = 没有服务器:不显示登录、云同步、短链接,
 * 一切和以前一样(世界只存在浏览器里,分享用长链接)。开发时网址加 aiServer=fake 用本地假服务器(scripts/lib/fakeAiServer.ts)。
 * 接口约定见 src/ai/providers/official.ts 文件头(登录、AI)和 src/account/cloud.ts 文件头(世界、分享)。
 */

let override: string | null | undefined;

/** 服务器地址;null = 没有服务器 */
export function serverBase(): string | null {
  if (override !== undefined) return override;
  if (wikiMode()) return '/api/v1/civ-atlas';
  const env = (import.meta.env?.VITE_AI_SERVER as string | undefined)?.trim();
  if (env) return env.replace(/\/+$/, '');
  // 开发时:网址加 aiServer=fake 用本地假服务器(vite.config.ts 里挂的);正式构建里这段不生效
  if (import.meta.env?.DEV && typeof location !== 'undefined' && new URLSearchParams(location.search).get('aiServer') === 'fake') return '/__fake-ai';
  return null;
}

const listeners = new Set<() => void>();
/** 服务器地址变了(单测里换地址)时通知 */
export function onServerChange(f: () => void): () => void {
  listeners.add(f);
  return () => void listeners.delete(f);
}

/** 单测用:指定服务器地址(null = 没有;undefined = 恢复按构建变量) */
export function setServerForTest(url: string | null | undefined): void {
  override = url;
  for (const f of listeners) f();
}

/** 服务器回的错(或连不上:status 0、code 'network') */
export class ServerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** 错误里别的字段(rev、deleted、balance、retryAfter……) */
    readonly data: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ServerError';
  }
}

const DEFAULT_MSG: Record<string, string> = {
  network: '连不上服务器，请检查网络后再试',
  auth: '登录过期了，请重新登录',
  'rate-limit': '太频繁了，等一会儿再试',
  'bad-code': '验证码不对或已过期',
  'need-invite': '这个邮箱还没有账号，要填邀请码',
  'bad-invite': '邀请码不对，或者已经用完了',
  'not-found': '账号里没有这个世界',
  'share-gone': '这个分享已经停止了',
  'content-filter': '内容没通过审核',
  unavailable: '服务器暂时不可用，稍后再试',
};

const codeOf = (status: number) =>
  status === 401 ? 'auth' : status === 404 ? 'not-found' : status === 409 ? 'conflict' : status === 429 ? 'rate-limit' : status === 503 ? 'unavailable' : status >= 500 ? 'server' : 'bad-request';

/** 401(令牌过期 / 作废)时调,带上这次请求用的令牌:清掉本地令牌(session.ts 登记) */
let onAuthLost: ((token: string) => void) | null = null;
export function setAuthLostHandler(f: ((token: string) => void) | null): void {
  onAuthLost = f;
}

export interface CallInit {
  method?: string;
  body?: unknown;
  /** 带上这个令牌(Authorization: Bearer) */
  token?: string;
}

/**
 * 一个请求最多等多久(连上了、回话迟迟不来或者传到一半卡住):到了就算连不上,
 * 不然后面的同步、分享、退出前的核对都排在它后面一直等。存一个世界最大几 MB,慢网也够传完
 */
let timeoutMs = 90_000;
/** 单测用:改等多久(undefined = 恢复) */
export function setTimeoutForTest(ms: number | undefined): void {
  timeoutMs = ms ?? 90_000;
}
const TIMEOUT_MSG = '服务器很久没有回话，请检查网络后再试';

/** 调一个接口,回 JSON(204 = null);出错抛 ServerError */
export async function call<T>(path: string, init: CallInit = {}): Promise<T> {
  const base = serverBase();
  if (!base) throw new ServerError(0, 'not-configured', '还没有开放');
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  if (init.token) {
    if (wikiMode()) headers['X-Civ-Atlas-User'] = init.token.replace(/^wiki:/, '');
    else headers.Authorization = `Bearer ${init.token}`;
  }
  const ctl = typeof AbortController === 'undefined' ? null : new AbortController();
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : undefined;
  let res: Response;
  let raw: string;
  try {
    try {
      res = await fetch(base + path, {
        method: init.method ?? 'GET',
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        credentials: wikiMode() ? 'same-origin' : 'omit',
        signal: ctl?.signal,
      });
    } catch {
      throw new ServerError(0, 'network', ctl?.signal.aborted ? TIMEOUT_MSG : DEFAULT_MSG.network);
    }
    try {
      raw = await res.text();
    } catch {
      // 回话传到一半断了、卡住了:当连不上(服务器可能已经做了,也可能没做)
      throw new ServerError(0, 'network', ctl?.signal.aborted ? TIMEOUT_MSG : DEFAULT_MSG.network);
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  let j: any = null;
  try {
    j = raw ? JSON.parse(raw) : null;
  } catch {
    /* 不是 JSON */
  }
  if (!res.ok) {
    const e = (j && typeof j === 'object' ? j.error : null) ?? {};
    const code = typeof e.code === 'string' && e.code ? e.code : codeOf(res.status);
    const message = typeof e.message === 'string' && e.message ? e.message.slice(0, 200) : (DEFAULT_MSG[code] ?? `服务器出错了(HTTP ${res.status})，稍后再试`);
    if ((res.status === 401 || code === 'auth') && init.token) onAuthLost?.(init.token);
    const { code: _c, message: _m, ...data } = e as Record<string, unknown>;
    throw new ServerError(res.status, code, message, data);
  }
  if (res.status === 204) return null as T;
  if (j === null || typeof j !== 'object') throw new ServerError(res.status, 'bad-response', '服务器返回的内容看不懂');
  return j as T;
}
