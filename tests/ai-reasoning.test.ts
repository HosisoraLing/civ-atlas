import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fitContext, estimateTokens, reasoningExtra, sanitizeTuning } from '../src/ai/tuning';
import { compatBody, compatChat } from '../src/ai/providers/compat';
import { AiError, type AiRequest } from '../src/ai/types';
import { addCustomProvider, updateCustomProvider, getCustomProvider, setCustomSecret, chooseProvider, resetAiSettingsForTest, sanitizeSettings } from '../src/ai/settings';
import { setupAi } from '../src/ai/setup';
import { runAgent } from '../src/ai/agent/loop';
import { getCallLog } from '../src/ai/callLog';

const cfg = { name: '测试', model: 'test-model', key: 'test-only-dummy-key', url: 'https://provider.test/v1/chat/completions' };
const req: AiRequest = { feature: '测试', messages: [{ role: 'system', content: '系统规则' }, { role: 'user', content: '当前问题' }], maxTokens: 64 };
const tuning = { reasoningFormat: 'deepseek' as const, reasoningEffort: 'high' as const, contextLength: 16384 };
const tool = { name: 'lookup', description: '查询', parameters: { type: 'object' } };
const tools = [{ def: tool, run: () => '查询结果' }];
const chunk = (delta: unknown, finish_reason?: string) => ({ choices: [{ delta, finish_reason }] });
const sse = (...chunks: unknown[]) => new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });

beforeEach(() => { resetAiSettingsForTest(); setupAi(); });
afterEach(() => vi.unstubAllGlobals());

describe('思考设置与上下文预算', () => {
  it('旧配置保持原状，非法设置恢复默认', () => {
    expect(sanitizeTuning({ reasoningEffort: 'bogus', contextLength: -1 })).toMatchObject({ reasoningEffort: 'default', contextLength: 0 });
    for (const contextLength of [NaN, Infinity, 1023, 2000001, 4096.5]) expect(sanitizeTuning({ contextLength }).contextLength).toBe(0);
    expect(sanitizeTuning({ contextLength: 2000000 }).contextLength).toBe(2000000);
    expect(sanitizeSettings({ deepseek: { thinking: true } }).deepseek.thinking).toBe(true);
  });
  it('各模型独立保存选项，删除模型时清理其选项', () => {
    const id = addCustomProvider();
    updateCustomProvider(id, { models: ['one', 'two'], model: 'one', modelTuning: { one: tuning, two: { ...tuning, contextLength: 65536, reasoningEffort: 'low' } } });
    updateCustomProvider(id, { model: 'two' });
    expect(getCustomProvider()?.modelTuning?.two.contextLength).toBe(65536);
    updateCustomProvider(id, { models: ['one'] });
    expect(Object.keys(getCustomProvider()!.modelTuning!)).toEqual(['one']);
    expect(getCustomProvider()!.modelTuning!.one).toEqual(tuning);
  });
  it('协议分别映射强度，不指定时不向第三方注入参数', () => {
    expect(reasoningExtra(sanitizeTuning({ reasoningEffort: 'high' }))).toEqual({});
    expect(reasoningExtra(tuning)).toEqual({ thinking: { type: 'enabled' }, reasoning_effort: 'high' });
    expect(reasoningExtra({ ...tuning, reasoningEffort: 'none' })).toMatchObject({ thinking: { type: 'disabled' } });
    expect(reasoningExtra({ ...tuning, reasoningFormat: 'openai', reasoningEffort: 'max' })).toEqual({ reasoning_effort: 'xhigh' });
    expect(reasoningExtra({ ...tuning, reasoningFormat: 'qwen', reasoningEffort: 'medium' })).toEqual({ enable_thinking: true, thinking_budget: 4096 });
    expect(reasoningExtra({ ...tuning, reasoningFormat: 'qwen', reasoningEffort: 'none' })).toEqual({ enable_thinking: false });
  });
  it('裁剪完整旧轮次，保留系统规则、当前问题、思考和工具调用的对应关系', () => {
    const messages: AiRequest['messages'] = [
      req.messages[0], { role: 'user', content: '旧问题'.repeat(800) },
      { role: 'assistant', content: '', toolCalls: [{ id: 'old', name: 'lookup', args: '{}' }], reasoning: '旧思考' },
      { role: 'tool', toolCallId: 'old', content: '旧结果' },
      req.messages[1], { role: 'assistant', content: '', reasoning: '新思考', toolCalls: [{ id: 'new', name: 'lookup', args: '{}' }] },
      { role: 'tool', toolCallId: 'new', content: '新结果' },
    ];
    const r = { ...req, messages, tools: [tool] };
    const budget = estimateTokens({ messages: [messages[0], ...messages.slice(4)], tools: [tool] }) + 64;
    expect(fitContext(r, budget)).toEqual([messages[0], ...messages.slice(4)]);
    expect(messages).toHaveLength(7);
    expect(() => fitContext(r, budget - 1)).toThrow('超出上下文预算');
    expect(fitContext(r)).toEqual(messages);
  });
  it('估算包含工具定义、思考、输出预留；超限不悄悄截断当前资料', () => {
    expect(() => fitContext({ ...req, tools: [{ ...tool, description: '大工具说明'.repeat(400) }] }, 1024)).toThrow(AiError);
    expect(() => fitContext({ ...req, maxTokens: 2000 }, 1024)).toThrow(AiError);
    const body = compatBody({ model: cfg.model, contextLength: 2048, completionTokens: true }, req);
    expect(body.max_completion_tokens).toBe(64);
    expect(body.max_tokens).toBeUndefined();
    expect(body.messages).toEqual(req.messages);
  });
});

describe('思考流与原生 harness', () => {
  it('流式思考和正文分别回调，不把思考混入最终回复', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sse(chunk({ reasoning_content: '先查' }), chunk({ reasoning_content: '资料' }), chunk({ content: '回答' }, 'stop'))));
    const thoughts: string[] = [], text: string[] = [];
    const result = await compatChat(cfg, req, { onReasoningDelta: c => thoughts.push(c), onDelta: c => text.push(c) });
    expect(thoughts.join('')).toBe('先查资料');
    expect(result.reasoning).toBe('先查资料');
    expect(text.join('')).toBe('回答');
    expect(result.text).toBe('回答');
  });
  it('空思考字段原样保留用于工具回传，不生成可视化假思考', async () => {
    const onReasoningDelta = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => sse(chunk({ reasoning_content: '', tool_calls: [{ index: 0, id: 'empty', function: { name: 'lookup', arguments: '{}' } }] }, 'tool_calls'))));
    const result = await compatChat(cfg, { ...req, tools: [tool] }, { onReasoningDelta });
    expect(result.reasoning).toBe('');
    expect(onReasoningDelta).not.toHaveBeenCalled();
    expect((compatBody({ model: cfg.model }, { ...req, messages: [{ role: 'assistant', content: '', reasoning: result.reasoning, toolCalls: result.toolCalls }] }).messages as any[])[0].reasoning_content).toBe('');
  });
  it('非流式及兼容 reasoning 字段也能显示；仅思考的回复仍报告未完成', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { reasoning: '推理摘要', content: '结果' } }] }), { headers: { 'Content-Type': 'application/json' } })));
    expect(await compatChat(cfg, req, {})).toMatchObject({ reasoning: '推理摘要', text: '结果' });
    vi.stubGlobal('fetch', vi.fn(async () => sse(chunk({ reasoning_content: '没写完' }, 'length'))));
    await expect(compatChat(cfg, req, {})).rejects.toMatchObject({ code: 'bad-response' });
  });
  it('跨工具轮次回传思考原文，事件按轮次显示，调用记录含独立思考字段', async () => {
    const id = addCustomProvider();
    updateCustomProvider(id, { baseUrl: 'https://provider.test/v1', models: [cfg.model], model: cfg.model, modelTuning: { [cfg.model]: tuning } });
    setCustomSecret(id, cfg.key); chooseProvider('custom');
    const bodies: any[] = [], events: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return bodies.length === 1
        ? sse(chunk({ reasoning_content: '需要查资料' }), chunk({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'lookup', arguments: '{}' } }] }, 'tool_calls'))
        : sse(chunk({ reasoning_content: '资料已经齐了' }), chunk({ content: '最终回答' }, 'stop'));
    }));
    const r = await runAgent({ ...req, tools, onEvent: e => events.push(e) });
    expect(r.text).toBe('最终回答');
    expect(bodies[1].messages[2]).toMatchObject({ role: 'assistant', reasoning_content: '需要查资料', tool_calls: [{ id: 'call_1' }] });
    expect(bodies[1].messages[3]).toMatchObject({ role: 'tool', tool_call_id: 'call_1', content: '查询结果' });
    expect(bodies[0]).toMatchObject({ reasoning_effort: 'high', thinking: { type: 'enabled' } });
    expect(events.filter(e => e.type === 'reasoning')).toEqual([{ type: 'reasoning', round: 0, text: '需要查资料' }, { type: 'reasoning', round: 1, text: '资料已经齐了' }]);
    expect(getCallLog().calls[0]).toMatchObject({ reasoning: '资料已经齐了', text: '最终回答' });
    expect(r.messages.at(-1)?.reasoning).toBe('资料已经齐了');
  });
  it('取消保留已返回思考，且不在停止后继续执行工具', async () => {
    const id = addCustomProvider(); updateCustomProvider(id, { baseUrl: 'https://provider.test/v1', models: [cfg.model], model: cfg.model });
    setCustomSecret(id, cfg.key); chooseProvider('custom');
    vi.stubGlobal('fetch', vi.fn(async () => sse(chunk({ reasoning_content: '正在查资料' }), chunk({ tool_calls: [{ index: 0, id: 'call_x', function: { name: 'lookup', arguments: '{}' } }] }, 'tool_calls'))));
    const ac = new AbortController(), run = vi.fn(() => '不能执行');
    await expect(runAgent({ ...req, tools: [{ def: tool, run }], signal: ac.signal, onEvent: e => { if (e.type === 'reasoning') ac.abort(); } })).rejects.toMatchObject({ code: 'aborted' });
    expect(run).not.toHaveBeenCalled();
    expect(getCallLog().calls[0]).toMatchObject({ ok: false, reasoning: '正在查资料', error: { code: 'aborted' } });
  });
  it('实际请求裁剪旧轮次并记录裁剪后的消息，默认输出也计入预算', async () => {
    const bodies: any[] = [], recorded: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string)); return sse(chunk({ content: '结果' }, 'stop'));
    }));
    const messages = [req.messages[0], { role: 'user' as const, content: '旧消息'.repeat(4000) }, { role: 'assistant' as const, content: '旧回答' }, req.messages[1]];
    await compatChat({ ...cfg, contextLength: 4096 }, { ...req, maxTokens: undefined, messages }, { onRequestMessages: m => recorded.push(m) });
    expect(bodies[0].messages).toEqual(req.messages);
    expect(bodies[0].max_tokens).toBe(2000);
    expect(recorded[0]).toEqual(req.messages);
  });
  it('带思考的普通 assistant 消息也完整回传，不只回传工具调用的轮次', () => {
    const body = compatBody({ model: cfg.model }, { ...req, messages: [{ role: 'assistant', content: '答案', reasoning: '之前的思考' }] });
    expect(body.messages).toEqual([{ role: 'assistant', content: '答案', reasoning_content: '之前的思考' }]);
  });
});
