/**
 * AI 调用的唯一入口(阶段 5):各功能只调 aiChat(),不直接碰服务商。
 *
 * - 服务商(provider)在这里登记:setup.ts 启动时登记 official / deepseek / bailian,本文件自带 mock(测试用假 AI,不联网)
 * - 当前用哪家 = setActiveProvider(...)(设置面板改);网址带 `ai=mock` 时一律用假 AI(冒烟测试、开发用)
 * - 每次调用(成功或失败)都交给"调用记录器"(setCallRecorder,启动时换成 callLog.ts 里存本地的那个);默认只在内存里留最近 50 条
 * - 失败一律抛 AiError(中文说明),功能里 catch 了直接给用户看
 * - 「使用 AI 功能」总开关(AI 设置最上面,存在 settings.ts):关着时界面上所有 AI 入口都不显示(useAiOn),aiChat 也不调
 *
 * 类型见 types.ts。
 */
import { useSyncExternalStore } from 'react';
import { worldKey } from '../gen/savefile';
import { currentWorld } from '../ui/saveStore';
import { AiError, type AiCallOptions, type AiCallRecord, type AiProviderKind, type AiRequest, type AiResult, type AiToolCall } from './types';

export interface AiProviderStatus {
  ready: boolean;
  /** 当前用的模型名(显示用) */
  model: string;
  /** 不可用时给用户看的原因("还没填 DeepSeek 的 API 密钥") */
  reason?: string;
}

export interface AiProvider {
  kind: AiProviderKind;
  /** 界面上的名字:"我们的 AI(积分)""DeepSeek""阿里云百炼""测试用假 AI" */
  label: string;
  status(): AiProviderStatus;
  /** 这家现在开没开放(我们的 AI 没配置服务器时 = false);不写 = 开放 */
  offered?(): boolean;
  /** 真正去调;provider / ms / 记录由 aiChat 统一补 */
  chat(req: AiRequest, opts: AiCallOptions): Promise<Omit<AiResult, 'provider' | 'ms'>>;
}

// ---------------------------------------------------------------------------
// 登记与切换

const providers = new Map<AiProviderKind, AiProvider>();
let active: AiProviderKind | null = null;
const subs = new Set<() => void>();
let version = 0;
const emit = () => {
  version++;
  for (const f of subs) f();
};

export function registerProvider(p: AiProvider): void {
  providers.set(p.kind, p);
  emit();
}

export function getProvider(kind: AiProviderKind): AiProvider | undefined {
  return providers.get(kind);
}

export function listProviders(): AiProvider[] {
  return [...providers.values()];
}

function mockForced(): boolean {
  return typeof location !== 'undefined' && new URLSearchParams(location.search).get('ai') === 'mock';
}

/** 当前用哪家(网址带 ai=mock 时一律是 mock) */
export function getActiveProvider(): AiProviderKind | null {
  return mockForced() ? 'mock' : active;
}

export function setActiveProvider(kind: AiProviderKind | null): void {
  if (kind === active) return;
  active = kind;
  emit();
}

// 总开关:settings.ts 读到设置、改了设置时同步过来(这个文件不读设置,免得互相引用)
let aiOff = false;
export function setAiOn(on: boolean): void {
  if (aiOff === !on) return;
  aiOff = !on;
  emit();
}
/** 「使用 AI 功能」开着吗(默认开) */
export function aiOn(): boolean {
  return !aiOff;
}
/** React:总开关开着吗;关着时各处的 AI 入口(助手、写史书、名字由来、AI 起名……)都不显示 */
export function useAiOn(): boolean {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    aiOn,
    aiOn,
  );
}

/** 服务商的状态变了(比如填了密钥、积分变了)时,设置面板调一下,让界面刷新 */
export function notifyAiChanged(): void {
  emit();
}

export interface AiStatus extends AiProviderStatus {
  provider: AiProviderKind | null;
  label: string;
}

export function getAiStatus(): AiStatus {
  const kind = getActiveProvider();
  const p = kind ? providers.get(kind) : undefined;
  if (!p) return { provider: kind, label: '未设置', ready: false, model: '', reason: unsetReason() };
  return { provider: p.kind, label: p.label, ...p.status() };
}

/** 没选 AI 时的说明:我们的 AI 开放了才提它 */
function unsetReason(): string {
  const own = '填上自己的 DeepSeek / 阿里云百炼密钥，或配置自定义服务';
  return providers.get('official')?.offered?.() ? `还没有设置 AI:可以用我们提供的 AI(消耗积分),或${own}` : `还没有设置 AI:可以${own}`;
}

let statusCache: { v: number; s: AiStatus } | null = null;
function statusSnapshot(): AiStatus {
  if (!statusCache || statusCache.v !== version) statusCache = { v: version, s: getAiStatus() };
  return statusCache.s;
}

/** React:当前 AI 状态(没配置时 ready = false、reason 是中文原因) */
export function useAiStatus(): AiStatus {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    statusSnapshot,
    statusSnapshot,
  );
}

// ---------------------------------------------------------------------------
// 打开设置面板(面板在 src/ui/AiSettings.tsx;功能里"还没设置 AI"时调它)

type Opener = () => void;
let settingsOpener: Opener | null = null;
export function setAiSettingsOpener(f: Opener | null): void {
  settingsOpener = f;
}
export function openAiSettings(): void {
  settingsOpener?.();
}

// ---------------------------------------------------------------------------
// 调用记录

type Recorder = (rec: AiCallRecord) => void;
const memory: AiCallRecord[] = [];
let recorder: Recorder = (rec) => {
  memory.unshift(rec);
  if (memory.length > 50) memory.length = 50;
};
/** 换成"存本地"的记录器(启动时 callLog.ts 调) */
export function setCallRecorder(f: Recorder): void {
  recorder = f;
}
/** 默认记录器里的最近几条(测试用) */
export function recentCallsInMemory(): readonly AiCallRecord[] {
  return memory;
}

let seq = 0;
const MAX_KEEP = 20000;
const clip = (s: string) => (s.length > MAX_KEEP ? s.slice(0, MAX_KEEP) + '……(已截断)' : s);

// ---------------------------------------------------------------------------
// 调用

/** 调用时在看哪颗星球(种子 + 参数,记录里写"调用时在看:种子 7") */
function worldOf(): string | undefined {
  const cur = currentWorld();
  return cur ? worldKey(cur.params) : undefined;
}

/** 调一次 AI。没配置 / 失败抛 AiError(中文说明);成功返回全文。每次调用都记一条记录 */
export async function aiChat(req: AiRequest, opts: AiCallOptions = {}): Promise<AiResult> {
  const kind = getActiveProvider();
  const p = kind ? providers.get(kind) : undefined;
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  const base = {
    id: `${Date.now().toString(36)}-${(seq++).toString(36)}`,
    at: new Date().toISOString(),
    feature: req.feature,
    title: req.title,
    messages: req.messages.map((m) => ({ ...m, content: clip(m.content) })),
    world: worldOf(),
    ...(p?.kind === 'custom' ? { providerLabel: p.label } : {}),
  };
  if (aiOff) {
    const err = new AiError('not-configured', 'AI 功能已关(AI 设置里可以打开)');
    recorder({ ...base, provider: kind ?? 'none', model: '', ok: false, error: { code: err.code, message: err.message }, ms: 0 });
    throw err;
  }
  if (!p) {
    const err = new AiError('not-configured', getAiStatus().reason ?? '还没有设置 AI');
    recorder({ ...base, provider: kind ?? 'none', model: '', ok: false, error: { code: err.code, message: err.message }, ms: 0 });
    throw err;
  }
  const st = p.status();
  if (!st.ready) {
    const err = new AiError('not-configured', st.reason ?? `${p.label} 还没设置好`);
    recorder({ ...base, provider: p.kind, model: st.model, ok: false, error: { code: err.code, message: err.message }, ms: 0 });
    throw err;
  }
  // 记下已经收到的部分:停止 / 中途断线时也写进记录(这部分服务商照样计费,用户能看到写到了哪)
  let partial = '';
  let partialReasoning = '';
  const tracked: AiCallOptions = {
    ...opts,
    onRequestMessages: (messages) => {
      base.messages = messages.map(m => ({ ...m, content: clip(m.content), ...(m.reasoning ? { reasoning: clip(m.reasoning) } : {}) }));
      opts.onRequestMessages?.(messages);
    },
    onReasoningDelta: (chunk, full) => {
      partialReasoning = full;
      opts.onReasoningDelta?.(chunk, full);
    },
    onDelta: (chunk, full) => {
      partial = full;
      opts.onDelta?.(chunk, full);
    },
  };
  try {
    const r = await p.chat(req, tracked);
    const res: AiResult = { ...r, provider: p.kind, ms: Math.round(now()) };
    recorder({
      ...base,
      provider: p.kind,
      model: r.model,
      ok: true,
      usage: r.usage,
      credits: r.credits,
      ms: res.ms,
      text: clip(r.text),
      ...(r.reasoning ? { reasoning: clip(r.reasoning) } : {}),
      ...(r.toolCalls?.length ? { toolCalls: r.toolCalls.map((c) => ({ ...c, args: clip(c.args) })) } : {}),
    });
    return res;
  } catch (e) {
    const err =
      e instanceof AiError
        ? e
        : opts.signal?.aborted
          ? new AiError('aborted', '已取消')
          : new AiError('other', `AI 调用失败:${e instanceof Error ? e.message : String(e)}`);
    recorder({
      ...base,
      provider: p.kind,
      model: st.model,
      ok: false,
      error: { code: err.code, message: err.message },
      ms: Math.round(now()),
      ...(partial ? { text: clip(partial) } : {}),
      ...(partialReasoning ? { reasoning: clip(partialReasoning) } : {}),
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 测试用假 AI(不联网):网址带 ai=mock 时启用;单测里可以 setMockResponder 定制回复

/** 假 AI 的回复:一段文字,或者(给了 tools 时)要调用的工具 + 可选的一段文字 */
type MockReply = string | { text?: string; toolCalls?: AiToolCall[] };
type MockResponder = (req: AiRequest) => MockReply;
const defaultMockResponder: MockResponder = (req) => {
  if (req.json) return JSON.stringify({ mock: true, feature: req.feature });
  const last = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  return `【测试用假 AI · ${req.feature}】${req.title ? `「${req.title}」` : ''}这是一段假的回复,用来检查界面和流程,不代表真实效果。收到的请求约 ${last.length} 字。`;
};
let mockResponder: MockResponder = defaultMockResponder;
/** 假 AI 每段回复之间等多久(网址 mockms=N,最多 5 秒;不给 = 0) */
function mockDelay(): number {
  if (typeof location === 'undefined') return 0;
  const n = Number(new URLSearchParams(location.search).get('mockms'));
  return Number.isFinite(n) && n > 0 ? Math.min(5000, n) : 0;
}
/** 定制假 AI 的回复;传 null 恢复默认 */
export function setMockResponder(f: MockResponder | null): void {
  mockResponder = f ?? defaultMockResponder;
}
/** 各功能自己的假回复(助手要按世界走固定的步骤);setMockResponder 定制过的优先 */
const featureMocks = new Map<string, MockResponder>();
/** 给某个功能挂一个假回复;传 null 拿掉 */
export function setFeatureMock(feature: string, f: MockResponder | null): void {
  if (f) featureMocks.set(feature, f);
  else featureMocks.delete(feature);
}

registerProvider({
  kind: 'mock',
  label: '测试用假 AI',
  status: () => ({ ready: true, model: 'mock' }),
  async chat(req, opts) {
    const reply = (mockResponder === defaultMockResponder ? featureMocks.get(req.feature) : undefined)?.(req) ?? mockResponder(req);
    const text = typeof reply === 'string' ? reply : (reply.text ?? '');
    const toolCalls = typeof reply === 'string' ? undefined : reply.toolCalls?.length ? reply.toolCalls : undefined;
    // 模拟流式:切成几段,每段让出一次事件循环(网址带 mockms=N 时每段等 N 毫秒:冒烟、截图看"正在写"用)
    let full = '';
    const step = Math.max(8, Math.ceil(text.length / 6));
    const wait = mockDelay();
    for (let i = 0; i < text.length; i += step) {
      if (opts.signal?.aborted) throw new AiError('aborted', '已取消');
      const chunk = text.slice(i, i + step);
      full += chunk;
      opts.onDelta?.(chunk, full);
      await new Promise((r) => setTimeout(r, wait));
    }
    if (!text) {
      // 只调用工具、不说话:同样让出一次事件循环、认取消
      if (opts.signal?.aborted) throw new AiError('aborted', '已取消');
      await new Promise((r) => setTimeout(r, wait));
    }
    const input = req.messages.reduce((s, m) => s + m.content.length, 0);
    const out = full.length + (toolCalls?.reduce((s, c) => s + c.args.length, 0) ?? 0);
    return { text: full, ...(toolCalls ? { toolCalls } : {}), model: 'mock', usage: { inputTokens: input, outputTokens: out } };
  },
});
