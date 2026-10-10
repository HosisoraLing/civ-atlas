import { AiError, type AiMessage, type AiRequest } from './types';

export type ReasoningFormat = 'none' | 'openai' | 'deepseek' | 'qwen';
export type ReasoningEffort = 'default' | 'none' | 'low' | 'medium' | 'high' | 'max';
export interface AiTuning {
  reasoningFormat: ReasoningFormat;
  reasoningEffort: ReasoningEffort;
  /** Total local context budget, including reserved output; 0 keeps the model default. */
  contextLength: number;
}
export const DEFAULT_TUNING: AiTuning = { reasoningFormat: 'none', reasoningEffort: 'default', contextLength: 0 };
export function sanitizeTuning(raw: unknown): AiTuning {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<AiTuning>;
  return {
    reasoningFormat: ['none', 'openai', 'deepseek', 'qwen'].includes(o.reasoningFormat ?? '') ? o.reasoningFormat! : 'none',
    reasoningEffort: ['default', 'none', 'low', 'medium', 'high', 'max'].includes(o.reasoningEffort ?? '') ? o.reasoningEffort! : 'default',
    contextLength: Number.isInteger(o.contextLength) && o.contextLength! >= 1024 && o.contextLength! <= 2000000 ? o.contextLength! : 0,
  };
}

/** Explicit protocol selection avoids sending vendor extensions to unrelated endpoints. */
export function reasoningExtra(t: AiTuning): Record<string, unknown> {
  const e = t.reasoningEffort;
  if (e === 'default' || t.reasoningFormat === 'none') return {};
  if (t.reasoningFormat === 'openai') return { reasoning_effort: e === 'max' ? 'xhigh' : e };
  if (t.reasoningFormat === 'deepseek') return { thinking: { type: e === 'none' ? 'disabled' : 'enabled' }, reasoning_effort: e === 'medium' ? 'high' : e };
  return e === 'none' ? { enable_thinking: false } : {
    enable_thinking: true,
    thinking_budget: { low: 1024, medium: 4096, high: 8192, max: 16384 }[e],
  };
}

// ponytail: conservative UTF-8 estimate, not a model tokenizer; actual usage comes from the provider.
export const estimateTokens = (value: unknown): number => Math.ceil(new TextEncoder().encode(JSON.stringify(value)).length / 2);

/** Keep system instructions and the entire current user/tool turn; discard only complete older turns. */
export function fitContext(req: AiRequest, length = 0): AiMessage[] {
  const messages = [...req.messages];
  if (!length) return messages;
  const fits = () => estimateTokens({ messages, tools: req.tools ?? [] }) + (req.maxTokens ?? 2000) <= length;
  while (!fits()) {
    const users = messages.flatMap((m, i) => m.role === 'user' ? [i] : []);
    if (users.length < 2) throw new AiError('other', '当前问题、世界资料和工具结果超出上下文预算，请提高上下文长度或缩短问题');
    const start = users[0], end = users[1];
    messages.splice(start, end - start, ...messages.slice(start, end).filter(m => m.role === 'system'));
  }
  return messages;
}
