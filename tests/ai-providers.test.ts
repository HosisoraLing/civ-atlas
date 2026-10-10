/**
 * AI 接入层:流式解析、DeepSeek / 百炼 / 我们的 AI 三个服务商(全部用假 fetch,不联网)。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SseParser, readSse } from '../src/ai/sse';
import { aiChat, getAiStatus } from '../src/ai/client';
import { addCustomProvider, getCustomProvider, getCustomSecret, updateCustomProvider, removeCustomProvider, setCustomSecret, chooseProvider, setSecret, updateAiSettings, getAiSettings, getSecrets, sanitizeSettings, scrubSecrets, resetAiSettingsForTest } from '../src/ai/settings';
import { customEndpoint, customProvider } from '../src/ai/providers/custom';
import { setupAi } from '../src/ai/setup';
import { getCallLog } from '../src/ai/callLog';
import { compatBody, compatChat } from '../src/ai/providers/compat';
import { DEEPSEEK_URL } from '../src/ai/providers/deepseek';
import { BAILIAN_URLS } from '../src/ai/providers/bailian';
import {
  getOfficialAccount,
  loginOfficial,
  logoutOfficial,
  refreshOfficialAccount,
  sendLoginCode,
  setOfficialServerForTest,
} from '../src/ai/providers/official';
import { AiError, type AiRequest } from '../src/ai/types';
import { createFakeAiServer, FAKE_CODE } from '../scripts/lib/fakeAiServer';
import { getSession } from '../src/account/session';

const KEY = 'sk-test-secret-0123456789';
function configureCustom(p: { name?: string; baseUrl: string; model: string }): string {
  const id = addCustomProvider();
  updateCustomProvider(id, { ...p, models: [p.model] });
  return id;
}

describe('自定义 OpenAI 兼容服务商', () => {
  it('接受 Base URL 或完整端点，拒绝凭据和非 HTTP 地址', () => {
    expect(customEndpoint('https://provider.test/v1/')).toBe('https://provider.test/v1/chat/completions');
    expect(customEndpoint('http://localhost:1234/v1/chat/completions')).toBe('http://localhost:1234/v1/chat/completions');
    for (const url of ['file:///tmp/api', 'javascript:alert(1)', 'https://user:password@provider.test/v1', 'https://provider.test/v1?key=secret', 'https://provider.test/v1#key']) expect(() => customEndpoint(url)).toThrow(AiError);
    expect(sanitizeSettings({ provider: 'custom', custom: { baseUrl: 'https://provider.test/v1', model: 'model-name' } }).customProviders[0].model).toBe('model-name');
  });
  it('通过统一 AI 入口发送模型、工具和流式结果，密钥只放请求头', async () => {
    const id = configureCustom({ name: '测试服务', baseUrl: 'https://provider.test/v1', model: 'custom-model' });
    setCustomSecret(id, KEY); chooseProvider('custom');
    const calls = fakeFetch(() => sseResponse(sseBody([
      { model: 'custom-model', choices: [{ delta: { content: '你好', tool_calls: [{ index: 0, id: 'tool_1', function: { name: 'lookup', arguments: '{"year":100}' } }] }, finish_reason: 'tool_calls' }] },
      { usage: { prompt_tokens: 10, completion_tokens: 4 }, choices: [] },
    ])));
    const result = await aiChat({ ...REQ, json: true, tools: [{ name: 'lookup', description: '查询历史', parameters: { type: 'object' } }] });
    expect(result.provider).toBe('custom'); expect(result.text).toBe('你好'); expect(result.toolCalls?.[0].name).toBe('lookup');
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
    expect(getAiStatus().label).toBe('测试服务');
    expect(calls[0].url).toBe('https://provider.test/v1/chat/completions');
    expect(calls[0].headers.authorization).toBe('Bearer ' + KEY);
    expect(calls[0].body.model).toBe('custom-model'); expect(calls[0].body.response_format).toEqual({ type: 'json_object' });
    expect(JSON.stringify(calls[0].body)).not.toContain(KEY);
    expect(JSON.stringify(await getCallLog())).not.toContain(KEY);
  });
  it('服务商报错中回显的自定义密钥会被遮掉，未配置时不联网', async () => {
    const id = configureCustom({ baseUrl: 'https://provider.test/v1', model: 'custom-model' });
    setCustomSecret(id, KEY); chooseProvider('custom');
    fakeFetch(() => errResponse(401, { message: 'Invalid key ' + KEY }));
    await expect(aiChat(REQ)).rejects.toMatchObject({ code: 'auth' });
    expect(JSON.stringify(await getCallLog())).not.toContain(KEY);
    expect(scrubSecrets(KEY)).toBe('***');
    setCustomSecret(id, ''); expect(customProvider.status().ready).toBe(false);
    const calls = fakeFetch(() => { throw Error('must not fetch'); });
    await expect(customProvider.chat(REQ, {})).rejects.toMatchObject({ code: 'not-configured' });
    expect(calls).toHaveLength(0);
  });
  it('按记住密钥开关恢复或移除配置，不将密钥存进普通设置', () => {
    const stored = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value), removeItem: (key: string) => stored.delete(key) });
    resetAiSettingsForTest();
    updateAiSettings({ remember: true });
    const id = configureCustom({ baseUrl: 'https://provider.test/v1', model: 'restored-model' }); setCustomSecret(id, KEY); chooseProvider('custom');
    expect(stored.get('civ-atlas:ai-settings')).not.toContain(KEY);
    resetAiSettingsForTest(); expect(getAiSettings().provider).toBe('custom'); expect(getCustomSecret(id)).toBe(KEY);
    updateAiSettings({ remember: false }); expect(stored.has('civ-atlas:ai-secrets')).toBe(false);
    resetAiSettingsForTest(); expect(getCustomSecret(id)).toBe('');
  });
});

describe('多个自定义服务商与模型', () => {
  it('旧单服务商、选中模型和密钥自动迁移，不把密钥混入普通设置', () => {
    const stored = new Map([
      ['civ-atlas:ai-settings', JSON.stringify({ provider: 'custom', remember: true, custom: { name: '旧服务', baseUrl: 'https://old.test/v1', model: 'old-model' } })],
      ['civ-atlas:ai-secrets', JSON.stringify({ custom: KEY, deepseek: 'deepseek-test-key' })],
    ]);
    vi.stubGlobal('localStorage', { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => stored.set(k, v), removeItem: (k: string) => stored.delete(k) });
    resetAiSettingsForTest();
    expect(getCustomProvider()).toEqual({ id: 'custom-legacy', name: '旧服务', baseUrl: 'https://old.test/v1', models: ['old-model'], model: 'old-model' });
    expect(getCustomSecret('custom-legacy')).toBe(KEY);
    expect(getSecrets().deepseek).toBe('deepseek-test-key');
    expect(JSON.parse(stored.get('civ-atlas:ai-settings')!)).not.toHaveProperty('custom');
    expect(stored.get('civ-atlas:ai-settings')).not.toContain(KEY);
    resetAiSettingsForTest(); expect(getCustomSecret('custom-legacy')).toBe(KEY);
  });
  it('切换服务商和模型后，只发送所选端点、模型和独立密钥', async () => {
    const first = configureCustom({ name: '甲', baseUrl: 'https://first.test/v1', model: 'first-one' });
    updateCustomProvider(first, { models: ['first-one', 'first-two'], model: 'first-two' });setCustomSecret(first, 'first-secret-key');
    const second = configureCustom({ name: '乙', baseUrl: 'https://second.test/v1', model: 'second-one' });
    updateCustomProvider(second, { models: ['second-one', 'second-two'] });setCustomSecret(second, 'second-secret-key');chooseProvider('custom');
    const calls = fakeFetch(c => new Response(JSON.stringify({ choices: [{ message: { content: '你好' } }], model: c.body.model }), { headers: { 'content-type': 'application/json' } }));
    await aiChat(REQ);
    updateAiSettings({ customProviderId: first });await aiChat(REQ);
    updateCustomProvider(first, { model: 'first-one' });await aiChat(REQ);
    expect(calls.map(c => [c.url, c.body.model, c.headers.authorization])).toEqual([
      ['https://second.test/v1/chat/completions', 'second-one', 'Bearer second-secret-key'],
      ['https://first.test/v1/chat/completions', 'first-two', 'Bearer first-secret-key'],
      ['https://first.test/v1/chat/completions', 'first-one', 'Bearer first-secret-key'],
    ]);
    expect(getAiStatus().label).toBe('甲');
    expect(getCallLog().calls.find(c => c.model === 'first-two')?.providerLabel).toBe('甲');
    expect(getCallLog().calls.find(c => c.model === 'second-one')?.providerLabel).toBe('乙');
  });
  it('删除模型和服务商会选择有效后备，清理对应密钥，忘记开关同时清理全部密钥', () => {
    const stored = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => stored.set(k, v), removeItem: (k: string) => stored.delete(k) });
    resetAiSettingsForTest();
    const first = configureCustom({ baseUrl: 'https://first.test/v1', model: 'one' });setCustomSecret(first, 'first-secret-key');
    updateCustomProvider(first, { models: ['one', 'two'], model: 'two' });
    updateCustomProvider(first, { models: ['one'] });expect(getCustomProvider()?.model).toBe('one');
    const second = configureCustom({ baseUrl: 'https://second.test/v1', model: 'three' });setCustomSecret(second, 'second-secret-key');
    resetAiSettingsForTest();expect(getAiSettings().customProviderId).toBe(second);expect(getCustomSecret(first)).toBe('first-secret-key');
    removeCustomProvider(second);expect(getAiSettings().customProviderId).toBe(first);expect(getCustomSecret(second)).toBe('');
    expect(stored.get('civ-atlas:ai-secrets')).not.toContain('second-secret-key');
    updateAiSettings({ remember: false });expect(stored.has('civ-atlas:ai-secrets')).toBe(false);
    resetAiSettingsForTest();expect(getCustomSecret(first)).toBe('');
    removeCustomProvider(first);expect(getCustomProvider()).toBeUndefined();expect(customProvider.status().ready).toBe(false);
  });
  it('请求期间删除服务商，服务商报错回显的原密钥仍不会进入日志', async () => {
    const id = configureCustom({ baseUrl: 'https://first.test/v1', model: 'one' });const key = 'removed-provider-secret';setCustomSecret(id, key);chooseProvider('custom');
    let release!: (r: Response) => void;
    const pending = new Promise<Response>(resolve => { release = resolve; });fakeFetch(() => pending);
    const request = aiChat(REQ);removeCustomProvider(id);release(errResponse(401, { message: 'Invalid credential ' + key }));
    const error = await request.catch(e => e);expect(error.code).toBe('auth');expect(error.message).not.toContain(key);
    expect(JSON.stringify(await getCallLog())).not.toContain(key);
  });
  it('坏设置和重复模型不产生孤立选择或串用密钥', () => {
    const s = sanitizeSettings({ customProviderId: 'missing', customProviders: [
      { id: 'custom-test', name: '甲', models: ['one', 'one', null, ' two '], model: 'missing' },
      { id: 'custom-test', models: ['duplicate'] }, { id: '__proto__', models: ['bad'] }, null,
    ] });
    expect(s.customProviders).toHaveLength(1);expect(s.customProviders[0].models).toEqual(['one', 'two']);expect(s.customProviders[0].model).toBe('one');expect(s.customProviderId).toBe('custom-test');
  });
});

/** 把字符串按给定的字节块切开,做成一个流(模拟网络上任意位置断开) */
function byteStream(text: string, cut = 7): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let i = 0;
  return new ReadableStream({
    pull(ctl) {
      if (i >= bytes.length) return ctl.close();
      ctl.enqueue(bytes.slice(i, i + cut));
      i += cut;
    },
  });
}

const sseBody = (events: unknown[], done = true) =>
  events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : '');

const chunk = (content: string, extra: Record<string, unknown> = {}) => ({ id: 'x', model: 'deepseek-flash', choices: [{ index: 0, delta: { content, ...extra } }] });

function sseResponse(body: string, cut = 7) {
  return new Response(byteStream(body, cut), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function errResponse(status: number, error: unknown) {
  return new Response(JSON.stringify({ error }), { status, headers: { 'Content-Type': 'application/json' } });
}

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: any;
}

/** 装一个假 fetch:记下请求,回 reply 给的 Response */
function fakeFetch(reply: (c: Captured) => Response | Promise<Response>) {
  const calls: Captured[] = [];
  const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const c: Captured = {
      url: String(url),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(c);
    if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    return reply(c);
  });
  vi.stubGlobal('fetch', f);
  return calls;
}

const REQ: AiRequest = { feature: '史书', title: '大昌', messages: [{ role: 'user', content: '写一段大昌的兴起' }] };

beforeAll(() => {
  setupAi();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SSE 流式解析', () => {
  it('任意位置断开(含 CRLF、注释、多行 data、事件名)都能拼回完整消息', () => {
    const text = ': keep-alive\r\n\r\nevent: delta\r\ndata: {"a":1}\r\n\r\ndata: 第一行\ndata: 第二行\n\nid: 7\ndata: x\n\n';
    const whole = new SseParser();
    const expected = [...whole.push(text), ...whole.end()];
    expect(expected).toEqual([
      { event: 'delta', data: '{"a":1}' },
      { event: 'message', data: '第一行\n第二行' },
      { event: 'message', data: 'x', id: '7' },
    ]);
    for (const step of [1, 2, 3, 5]) {
      const p = new SseParser();
      const got = [];
      for (let i = 0; i < text.length; i += step) got.push(...p.push(text.slice(i, i + step)));
      got.push(...p.end());
      expect(got).toEqual(expected);
    }
  });

  it('汉字的 UTF-8 字节被切开也能拼回;最后一条没有空行收尾也算', async () => {
    const out = [];
    for await (const ev of readSse(byteStream('data: 大昌王朝兴起于碧溪谷\n\ndata: 尾巴', 1))) out.push(ev.data);
    expect(out).toEqual(['大昌王朝兴起于碧溪谷', '尾巴']);
  });
});

describe('DeepSeek(假 fetch)', () => {
  it('只发给 DeepSeek;密钥只在请求头里;流式拼出全文、读出用量;深度思考默认关;思考过程不算正文', async () => {
    setSecret('deepseek', KEY);
    chooseProvider('deepseek');
    const calls = fakeFetch(() =>
      sseResponse(
        sseBody([
          chunk('', { reasoning_content: '先想一想……' }),
          chunk('大昌'),
          chunk('兴于'),
          chunk('碧溪谷。'),
          { id: 'x', choices: [], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } },
        ]),
      ),
    );
    const deltas: string[] = [];
    const r = await aiChat(REQ, { onDelta: (c) => deltas.push(c) });
    expect(r.text).toBe('大昌兴于碧溪谷。');
    expect(deltas.join('')).toBe(r.text);
    expect(r.usage).toEqual({ inputTokens: 12, outputTokens: 8 });
    expect(r.provider).toBe('deepseek');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(DEEPSEEK_URL);
    expect(calls[0].url).not.toContain(KEY);
    expect(calls[0].headers.authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0].body).toMatchObject({ model: 'deepseek-flash', stream: true, stream_options: { include_usage: true }, thinking: { type: 'disabled' } });
    expect(calls[0].body.response_format).toBeUndefined();
    // 调用记录里有这一条,且哪里都没有密钥
    const rec = getCallLog().calls[0];
    expect(rec.ok).toBe(true);
    expect(rec.usage).toEqual({ inputTokens: 12, outputTokens: 8 });
    expect(JSON.stringify(rec)).not.toContain(KEY);
  });

  it('json 模式:带 response_format json_object;提示词里没有 "json" 字样时补一句', () => {
    const b = compatBody({ model: 'm' }, { ...REQ, json: true, temperature: 0.3, maxTokens: 500 });
    expect(b.response_format).toEqual({ type: 'json_object' });
    expect(b.temperature).toBe(0.3);
    expect(b.max_tokens).toBe(500);
    const msgs = b.messages as { role: string; content: string }[];
    expect(msgs[0].role).toBe('system');
    expect(msgs[0].content).toMatch(/json/i);
    const b2 = compatBody({ model: 'm' }, { feature: 'x', json: true, messages: [{ role: 'user', content: '回一个 JSON' }] });
    expect(b2.messages).toHaveLength(1);
  });

  it('深度思考开着时 thinking.type = enabled', async () => {
    updateAiSettings({ deepseek: { thinking: true } });
    const calls = fakeFetch(() => sseResponse(sseBody([chunk('好')])));
    await aiChat(REQ);
    expect(calls[0].body.thinking).toEqual({ type: 'enabled' });
    updateAiSettings({ deepseek: { thinking: false } });
  });

  it.each([
    [401, { message: `Authentication Fails, Your api key: ${KEY} is invalid`, type: 'authentication_error' }, 'auth'],
    [402, { message: 'Insufficient Balance', type: 'unknown_error' }, 'quota'],
    [429, { message: 'Rate Limit Reached' }, 'rate-limit'],
    [503, { message: 'Server Overloaded' }, 'rate-limit'],
    [500, { message: 'Server Error' }, 'other'],
    [400, { message: 'Model Not Exist', type: 'invalid_request_error' }, 'other'],
    [400, { message: 'Content Exists Risk', type: 'invalid_request_error' }, 'content-filter'],
  ] as const)('HTTP %i → %s(中文说明,不带密钥)', async (status, error, code) => {
    fakeFetch(() => errResponse(status, error));
    const e = (await aiChat(REQ).catch((x) => x)) as AiError;
    expect(e).toBeInstanceOf(AiError);
    expect(e.code).toBe(code);
    expect(e.message).toMatch(/[一-鿿]/);
    expect(e.message).not.toContain(KEY);
    if (code === 'other' && status === 400) expect(e.message).toContain('deepseek-flash');
    if (code === 'content-filter') expect(e.message).toContain('审核');
    const rec = getCallLog().calls[0];
    expect(rec.ok).toBe(false);
    expect(rec.error?.code).toBe(code);
    expect(JSON.stringify(rec)).not.toContain(KEY);
  });

  it('断网 → network;流中途断 → network;取消 → aborted', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    await expect(aiChat(REQ)).rejects.toMatchObject({ code: 'network' });

    // 发了两段就断
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const enc = new TextEncoder();
        let n = 0;
        const body = new ReadableStream<Uint8Array>({
          pull(ctl) {
            if (n++ === 0) ctl.enqueue(enc.encode(`data: ${JSON.stringify(chunk('一半'))}\n\n`));
            else ctl.error(new TypeError('network error'));
          },
        });
        return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }),
    );
    await expect(aiChat(REQ)).rejects.toMatchObject({ code: 'network' });

    fakeFetch(() => sseResponse(sseBody([chunk('好')])));
    const ac = new AbortController();
    ac.abort();
    await expect(aiChat(REQ, { signal: ac.signal })).rejects.toMatchObject({ code: 'aborted' });
  });

  it('很久没回应 → network(超时)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: string, init: RequestInit) => {
        const body = new ReadableStream<Uint8Array>({
          start(ctl) {
            init.signal?.addEventListener('abort', () => ctl.error(new DOMException('aborted', 'AbortError')));
          },
        });
        return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }),
    );
    const e = await compatChat({ name: 'DeepSeek', url: DEEPSEEK_URL, key: KEY, model: 'm', idleMs: 30 }, REQ, {}).catch((x) => x);
    expect(e).toMatchObject({ code: 'network' });
    expect(e.message).toContain('没有回应');
  });

  it('流里只有思考、没有正文(到长度上限)→ bad-response,并提示关掉深度思考', async () => {
    fakeFetch(() =>
      sseResponse(sseBody([chunk('', { reasoning_content: '想了很久' }), { choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }])),
    );
    const e = (await aiChat(REQ).catch((x) => x)) as AiError;
    expect(e.code).toBe('bad-response');
    expect(e.message).toContain('深度思考');
  });

  it('没填密钥时不发请求,抛 not-configured', async () => {
    setSecret('deepseek', undefined);
    const calls = fakeFetch(() => sseResponse(sseBody([chunk('好')])));
    expect(getAiStatus().ready).toBe(false);
    await expect(aiChat(REQ)).rejects.toMatchObject({ code: 'not-configured' });
    expect(calls).toHaveLength(0);
  });
});

describe('阿里云百炼(假 fetch)', () => {
  it('按地域选地址;流式 + 用量;深度思考开关一律明说(关 = false);json 模式', async () => {
    setSecret('bailian', KEY);
    chooseProvider('bailian');
    updateAiSettings({ bailian: { region: 'intl', model: 'qwen-max' } });
    const calls = fakeFetch(() =>
      sseResponse(
        sseBody([
          { choices: [{ delta: { content: '{"名":', role: 'assistant' }, index: 0 }], model: 'qwen-max' },
          { choices: [{ delta: { content: '"碧溪"}' }, index: 0, finish_reason: 'stop' }], model: 'qwen-max' },
          { choices: [], usage: { prompt_tokens: 30, completion_tokens: 6, total_tokens: 36 } },
        ]),
        5,
      ),
    );
    const r = await aiChat({ ...REQ, json: true });
    expect(JSON.parse(r.text)).toEqual({ 名: '碧溪' });
    expect(r.usage).toEqual({ inputTokens: 30, outputTokens: 6 });
    expect(r.model).toBe('qwen-max');
    expect(calls[0].url).toBe(BAILIAN_URLS.intl);
    expect(calls[0].body.response_format).toEqual({ type: 'json_object' });
    // 新一代模型不传就默认思考:关着时也要明说 false
    expect(calls[0].body.enable_thinking).toBe(false);
    expect(calls[0].body.model).toBe('qwen-max');

    updateAiSettings({ bailian: { region: 'cn', thinking: true } });
    const calls2 = fakeFetch(() => sseResponse(sseBody([chunk('好')])));
    await aiChat(REQ);
    expect(calls2[0].url).toBe(BAILIAN_URLS.cn);
    expect(calls2[0].body.enable_thinking).toBe(true);
    // json 模式时不开思考(思考模式不支持结构化输出)
    const calls3 = fakeFetch(() => sseResponse(sseBody([chunk('{}')])));
    await aiChat({ ...REQ, json: true });
    expect(calls3[0].body.enable_thinking).toBe(false);
    updateAiSettings({ bailian: { thinking: false, model: 'qwen-plus' } });
  });

  it.each([
    [401, { message: 'Incorrect API key provided.', type: 'invalid_request_error', code: 'invalid_api_key' }, 'auth', '地域'],
    [400, { message: 'Access denied, please make sure your account is in good standing.', code: 'Arrearage' }, 'quota', '欠费'],
    [403, { message: 'The free tier of the model has been exhausted.', code: 'AllocationQuota.FreeTierOnly' }, 'quota', '免费额度'],
    [400, { message: 'Input data may contain inappropriate content.', code: 'data_inspection_failed' }, 'content-filter', '审核'],
    [429, { message: 'Requests rate limit exceeded', code: 'Throttling' }, 'rate-limit', '限流'],
    [404, { message: 'The model `qwen-xxx` does not exist', code: 'model_not_found' }, 'other', '模型'],
  ] as const)('HTTP %i %o → %s', async (status, error, code, word) => {
    fakeFetch(() => errResponse(status, error));
    const e = (await aiChat(REQ).catch((x) => x)) as AiError;
    expect(e.code).toBe(code);
    expect(e.message).toContain(word);
  });

  it('报错里百炼附带的 "For details, see: 链接" 去掉(实测 401 就带这一句)', async () => {
    fakeFetch(() =>
      errResponse(401, { message: 'Incorrect API key provided. For details, see: https://help.aliyun.com/zh/model-studio/error-code#apikey-error', code: 'invalid_api_key' }),
    );
    const e = (await aiChat(REQ).catch((x) => x)) as AiError;
    expect(e.message).toContain('Incorrect API key provided.');
    expect(e.message).not.toContain('https://');
  });

  it('流中途返回错误对象 → 按错误码翻译', async () => {
    fakeFetch(() => sseResponse(sseBody([chunk('一'), { error: { code: 'DataInspectionFailed', message: 'Output data may contain inappropriate content.' } }], false)));
    await expect(aiChat(REQ)).rejects.toMatchObject({ code: 'content-filter', message: expect.stringContaining('拦下了 AI 写出来的内容') });
  });
});

describe('我们的 AI(开发假服务器,假 fetch 直连,不开端口)', () => {
  it('没配置服务器地址:不可用,说明"还在内测"', () => {
    setOfficialServerForTest(null);
    chooseProvider('official');
    const s = getAiStatus();
    expect(s.ready).toBe(false);
    expect(s.reason).toContain('内测');
  });

  it('没选 AI 时的说明:我们的 AI 开放了才提它', () => {
    chooseProvider(null);
    setOfficialServerForTest(null);
    expect(getAiStatus().reason).toBe('还没有设置 AI:可以填上自己的 DeepSeek / 阿里云百炼密钥，或配置自定义服务');
    setOfficialServerForTest('http://fake-ai.test');
    expect(getAiStatus().reason).toBe('还没有设置 AI:可以用我们提供的 AI(消耗积分),或填上自己的 DeepSeek / 阿里云百炼密钥，或配置自定义服务');
    setOfficialServerForTest(undefined);
  });

  it('登录 → 看积分 → 调用扣积分 → 积分不够报错 → 令牌失效要重新登录', async () => {
    const fake = createFakeAiServer({ startCredits: 7, chunkDelayMs: 0 });
    const BASE = 'http://fake-ai.test';
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (u: string, init?: RequestInit) => {
        seen.push(String(u));
        return fake.handle(new Request(String(u), init));
      }),
    );
    setOfficialServerForTest(BASE);
    chooseProvider('official');
    expect(getAiStatus().reason).toContain('登录');
    await expect(aiChat(REQ)).rejects.toMatchObject({ code: 'not-configured' });

    const sent = await sendLoginCode('writer@example.com');
    expect(sent.devCode).toBe(FAKE_CODE);
    await expect(loginOfficial('writer@example.com', '000000')).rejects.toMatchObject({ code: 'auth' });
    await loginOfficial('writer@example.com', FAKE_CODE);
    await refreshOfficialAccount();
    expect(getOfficialAccount()).toMatchObject({ loggedIn: true, account: 'writer@example.com', credits: 7 });
    expect(getAiStatus().ready).toBe(true);

    const deltas: string[] = [];
    const r = await aiChat(REQ, { onDelta: (c) => deltas.push(c) });
    expect(r.provider).toBe('official');
    expect(r.credits).toBe(3);
    expect(r.model).toBe('fake-ai-1');
    expect(deltas.join('')).toBe(r.text);
    expect(r.usage?.outputTokens).toBe(r.text.length);
    expect(getOfficialAccount().credits).toBe(4);
    expect(getCallLog().calls[0]).toMatchObject({ ok: true, provider: 'official', credits: 3 });

    await aiChat(REQ);
    expect(getOfficialAccount().credits).toBe(1);
    const e = (await aiChat(REQ).catch((x) => x)) as AiError;
    expect(e.code).toBe('quota');
    expect(e.message).toContain('积分不够');
    expect(getOfficialAccount().credits).toBe(1);
    expect(getCallLog().calls[0]).toMatchObject({ ok: false, error: { code: 'quota' } });

    // 请求只发给我们的服务器
    expect(seen.every((u) => u.startsWith(BASE))).toBe(true);

    // 服务器那边令牌作废 → 401 → 本地清掉令牌,请用户重新登录
    await logoutOfficial();
    expect(getOfficialAccount().loggedIn).toBe(false);
    await loginOfficial('writer@example.com', FAKE_CODE);
    // 让服务器忘掉所有令牌:换一个新的假服务器
    const fake2 = createFakeAiServer({ chunkDelayMs: 0 });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (u: string, init?: RequestInit) => fake2.handle(new Request(String(u), init))),
    );
    await expect(aiChat(REQ)).rejects.toMatchObject({ code: 'auth' });
    expect(getOfficialAccount().loggedIn).toBe(false);
    expect(getAiStatus().ready).toBe(false);
    setOfficialServerForTest(undefined);
  });

  it('退出后换了账号:旧账号晚回来的 401 不把新登录踢掉', async () => {
    const fake = createFakeAiServer({ chunkDelayMs: 0 });
    let hold: Promise<void> | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (u: string, init?: RequestInit) => {
        const req = new Request(String(u), init);
        if (hold && new URL(req.url).pathname === '/v1/chat') {
          const h = hold;
          hold = null;
          await h;
        }
        return fake.handle(req);
      }),
    );
    setOfficialServerForTest('http://fake-ai.test');
    chooseProvider('official');
    await loginOfficial('writer@example.com', FAKE_CODE);
    let release!: () => void;
    hold = new Promise<void>((r) => (release = r));
    const late = aiChat(REQ).catch((e: unknown) => e);
    await logoutOfficial();
    await loginOfficial('other@example.com', FAKE_CODE);
    release();
    expect(await late).toMatchObject({ code: 'auth' });
    expect(getOfficialAccount()).toMatchObject({ loggedIn: true, account: 'other@example.com' });
    expect(getAiStatus().ready).toBe(true);
    await logoutOfficial();
    setOfficialServerForTest(undefined);
  });

  it('写的工夫换了账号:原来那个账号写的不交给新账号', async () => {
    const fake = createFakeAiServer({ chunkDelayMs: 0 });
    let hold: Promise<void> | null = null;
    let reached!: () => void;
    const hit = new Promise<void>((r) => (reached = r));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (u: string, init?: RequestInit) => {
        const req = new Request(String(u), init);
        const res = await fake.handle(req);
        // 服务器写好了、回话还在路上
        if (hold && new URL(req.url).pathname === '/v1/chat') {
          const h = hold;
          hold = null;
          reached();
          await h;
        }
        return res;
      }),
    );
    setOfficialServerForTest('http://fake-ai.test');
    chooseProvider('official');
    await loginOfficial('writer@example.com', FAKE_CODE);
    let release!: () => void;
    hold = new Promise<void>((r) => (release = r));
    const late = aiChat(REQ).catch((e: unknown) => e);
    await hit;
    // 不退出就换成另一个账号(另一个标签页里登录的;原来的令牌在服务器上还有效)
    await loginOfficial('other@example.com', FAKE_CODE);
    release();
    expect(await late).toMatchObject({ code: 'auth' });
    expect(getOfficialAccount()).toMatchObject({ loggedIn: true, account: 'other@example.com' });
    await logoutOfficial();
    setOfficialServerForTest(undefined);
  });

  it('退出后换了账号:旧账号晚回来的账号资料不会套到新登录上', async () => {
    const fake = createFakeAiServer({ chunkDelayMs: 0 });
    let hold: Promise<void> | null = null;
    let reached!: () => void;
    const hit = new Promise<void>((r) => (reached = r));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (u: string, init?: RequestInit) => {
        const req = new Request(String(u), init);
        const res = await fake.handle(req);
        // 服务器回了话、还在路上
        if (hold && new URL(req.url).pathname === '/v1/me') {
          const h = hold;
          hold = null;
          reached();
          await h;
        }
        return res;
      }),
    );
    setOfficialServerForTest('http://fake-ai.test');
    chooseProvider('official');
    let release!: () => void;
    hold = new Promise<void>((r) => (release = r));
    // 登录后顺手查一次积分:这一次晚回来
    await loginOfficial('writer@example.com', FAKE_CODE);
    await hit;
    await logoutOfficial();
    await loginOfficial('other@example.com', FAKE_CODE);
    await refreshOfficialAccount();
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(getSession()?.user.account).toBe('other@example.com');
    expect(getOfficialAccount()).toMatchObject({ loggedIn: true, account: 'other@example.com' });
    await logoutOfficial();
    setOfficialServerForTest(undefined);
  });
});

describe('工具调用(助手用,假 fetch)', () => {
  const TOOLS: AiRequest['tools'] = [
    { name: 'country', description: '查一个国家', parameters: { type: 'object', properties: { country: { type: 'string' } }, required: ['country'] } },
    { name: 'situation', description: '查某一年的格局', parameters: { type: 'object', properties: { year: { type: 'integer' } } } },
  ];
  /** 第二轮的请求:模型上一轮调了工具,结果交回去 */
  const ROUND2: AiRequest = {
    feature: '助手',
    messages: [
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '大昌后来怎么样了' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_a', name: 'country', args: '{"country":"P3"}' }] },
      { role: 'tool', toolCallId: 'call_a', content: 'P3 大昌王朝 · 第 812—3000 年' },
    ],
    tools: TOOLS,
    toolChoice: 'auto',
  };
  /** 一个工具调用拆成好几段送来(两个调用交错) */
  const toolChunk = (calls: unknown[], finish?: string) => ({ id: 'x', model: 'deepseek-flash', choices: [{ index: 0, delta: { tool_calls: calls }, ...(finish ? { finish_reason: finish } : {}) }] });

  it('DeepSeek:请求里带 tools、tool_choice,交回的消息按 OpenAI 写法;分段送来的调用拼回完整;保留思考开关', async () => {
    setSecret('deepseek', KEY);
    chooseProvider('deepseek');
    updateAiSettings({ deepseek: { thinking: true } });
    const calls = fakeFetch(() =>
      sseResponse(
        sseBody([
          toolChunk([{ index: 0, id: 'call_1', type: 'function', function: { name: 'country', arguments: '' } }]),
          toolChunk([{ index: 0, function: { arguments: '{"coun' } }]),
          toolChunk([{ index: 1, id: 'call_2', type: 'function', function: { name: 'situation', arguments: '{"year":' } }]),
          toolChunk([{ index: 0, function: { arguments: 'try":"P5"}' } }]),
          toolChunk([{ index: 1, function: { arguments: '2850}' } }], 'tool_calls'),
          { id: 'x', choices: [], usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 } },
        ]),
        9,
      ),
    );
    const r = await aiChat(ROUND2);
    expect(r.text).toBe('');
    expect(r.toolCalls).toEqual([
      { id: 'call_1', name: 'country', args: '{"country":"P5"}' },
      { id: 'call_2', name: 'situation', args: '{"year":2850}' },
    ]);
    const body = calls[0].body;
    expect(body.thinking).toEqual({ type: 'enabled' });
    expect(body.tool_choice).toBe('auto');
    expect(body.tools).toEqual(TOOLS!.map((t) => ({ type: 'function', function: t })));
    expect(body.messages[2]).toEqual({
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'country', arguments: '{"country":"P3"}' } }],
    });
    expect(body.messages[3]).toEqual({ role: 'tool', tool_call_id: 'call_a', content: 'P3 大昌王朝 · 第 812—3000 年' });
    // 调用记录里记下了模型要调用的工具
    expect(getCallLog().calls[0].toolCalls).toEqual(r.toolCalls);
    // 没带工具的请求照旧按设置开深度思考
    const calls2 = fakeFetch(() => sseResponse(sseBody([chunk('好')])));
    await aiChat(REQ);
    expect(calls2[0].body.thinking).toEqual({ type: 'enabled' });
    expect(calls2[0].body.tools).toBeUndefined();
    updateAiSettings({ deepseek: { thinking: false } });
  });

  it('百炼:带工具时保留深度思考;只回工具调用、没有正文不算出错', async () => {
    setSecret('bailian', KEY);
    chooseProvider('bailian');
    updateAiSettings({ bailian: { thinking: true } });
    const calls = fakeFetch(() =>
      sseResponse(
        sseBody([
          { choices: [{ index: 0, delta: { role: 'assistant', content: '我先查一下。' } }], model: 'qwen-plus' },
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_q', type: 'function', function: { name: 'country', arguments: '{"country":"P3"}' } }] }, finish_reason: 'tool_calls' }] },
        ]),
      ),
    );
    const r = await aiChat({ ...ROUND2, toolChoice: 'none' });
    expect(calls[0].body.enable_thinking).toBe(true);
    expect(calls[0].body.tool_choice).toBe('none');
    expect(r.text).toBe('我先查一下。');
    expect(r.toolCalls).toEqual([{ id: 'call_q', name: 'country', args: '{"country":"P3"}' }]);
    updateAiSettings({ bailian: { thinking: false } });
  });

  it('交回工具结果以后正常收尾、不说话:不算出错(由助手循环判断);没有工具结果的照旧算空回复', async () => {
    setSecret('deepseek', KEY);
    chooseProvider('deepseek');
    const end = [{ id: 'x', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }];
    fakeFetch(() => sseResponse(sseBody(end)));
    expect((await aiChat(ROUND2)).text).toBe('');
    fakeFetch(() => sseResponse(sseBody(end)));
    const e = (await aiChat({ ...ROUND2, messages: ROUND2.messages.slice(0, 2) }).catch((x) => x)) as AiError;
    expect(e.code).toBe('bad-response');
  });

  it('我们的 AI:tools、toolChoice、带工具调用的消息原样转给服务器;done.tool_calls 读回', async () => {
    const fake = createFakeAiServer({ chunkDelayMs: 0 });
    const BASE = 'http://fake-ai.test';
    const bodies: any[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (u: string, init?: RequestInit) => {
        if (String(u).endsWith('/v1/chat') && init?.body) bodies.push(JSON.parse(String(init.body)));
        return fake.handle(new Request(String(u), init));
      }),
    );
    setOfficialServerForTest(BASE);
    chooseProvider('official');
    await loginOfficial('writer@example.com', FAKE_CODE);
    const r = await aiChat({ ...ROUND2, messages: ROUND2.messages.slice(0, 2) });
    expect(r.toolCalls).toEqual([{ id: 'call_fake_0', name: 'country', args: '{}' }]);
    expect(bodies[0].tools).toEqual(TOOLS!.map((t) => ({ type: 'function', function: t })));
    expect(bodies[0].toolChoice).toBe('auto');
    const r2 = await aiChat(ROUND2);
    expect(r2.toolCalls).toBeUndefined();
    expect(r2.text).toContain('助手');
    expect(bodies[1].messages[2].tool_calls[0]).toEqual({ id: 'call_a', type: 'function', function: { name: 'country', arguments: '{"country":"P3"}' } });
    expect(bodies[1].messages[3]).toEqual({ role: 'tool', tool_call_id: 'call_a', content: 'P3 大昌王朝 · 第 812—3000 年' });
    await logoutOfficial();
    setOfficialServerForTest(undefined);
  });
});
