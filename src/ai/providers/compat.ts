/**
 * OpenAI 兼容的 chat/completions 调用(DeepSeek、阿里云百炼共用):浏览器直接发给服务商,流式读回。
 *
 * - 请求:{ model, messages, stream: true, stream_options: { include_usage: true }, temperature?, max_tokens?,
 *          response_format?: { type: 'json_object' }, tools?, tool_choice? } + 各家自己的字段(深度思考开关)
 * - 回复:SSE,每条 data 是一个 JSON(choices[0].delta.content 是这段正文;深度思考的"想"在 reasoning_content 里,不算正文);
 *         最后一条带 usage(choices 为空),然后 data: [DONE]
 * - 工具调用(助手用):tools = [{ type: 'function', function: { name, description, parameters } }];
 *         模型要调用时 choices[0].delta.tool_calls 分好几段送来(按 index 拼:第一段带 id 和 function.name,
 *         之后每段带一截 function.arguments),finish_reason = 'tool_calls';
 *         交回结果:先把模型那一轮原样放回(assistant + tool_calls),再每个调用一条 { role: 'tool', tool_call_id, content }
 * - 出错:HTTP 状态码 + { error: { message, code, type } };流中途出错时 data 里是 { error: ... }
 *
 * 密钥只放在 Authorization 头里,只发给 cfg.url 这一家;不进网址、不进记录、不打印。
 */
import { AiError, type AiCallOptions, type AiMessage, type AiRequest, type AiResult, type AiToolCall, type AiUsage } from '../types';
import { idleTimer, readSse } from '../sse';
import { scrubSecrets } from '../settings';
import { fitContext } from '../tuning';

export interface CompatConfig {
  /** 界面上的名字,用在中文报错里:"DeepSeek""阿里云百炼" */
  name: string;
  url: string;
  key: string;
  model: string;
  /** 各家自己的请求字段(比如深度思考开关) */
  extra?: Record<string, unknown>;
  /** 各家特有的错误(先于通用规则);返回 null 走通用规则 */
  mapError?: (e: HttpErrorInfo) => AiError | null;
  /** 多久没收到任何数据就算超时(毫秒) */
  idleMs?: number;
  contextLength?: number;
  /** OpenAI uses max_completion_tokens for visible output plus reasoning. */
  completionTokens?: boolean;
}

export interface HttpErrorInfo {
  status: number;
  /** 服务商的错误码(error.code / error.type / code),没有就是 '' */
  code: string;
  /** 服务商的原话(已遮掉密钥、截短) */
  message: string;
}

const IDLE_MS = 90_000;
const clipMsg = (s: string) => {
  // 百炼的报错后面常跟一句 "For details, see: https://…" 长链接,占地方又看不懂,去掉
  const t = scrubSecrets(s.replace(/\s*For details,?\s*see:?\s*https?:\/\/\S+/gi, '').replace(/\s+/g, ' ').trim());
  return t.length > 200 ? t.slice(0, 200) + '…' : t;
};

/** json 模式:两家都要求提示词里出现 "json" 字样,没有就补一句 */
export function withJsonHint(messages: AiMessage[]): AiMessage[] {
  if (messages.some((m) => /json/i.test(m.content))) return messages;
  return [{ role: 'system', content: '请只输出一个 JSON 对象(json),不要输出别的文字。' }, ...messages];
}

/** 拼请求体(单测检查 json 模式等参数) */
export function compatBody(cfg: Pick<CompatConfig, 'model' | 'extra' | 'contextLength' | 'completionTokens'>, req: AiRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: fitContext({ ...req, messages: req.json ? withJsonHint(req.messages) : req.messages }, cfg.contextLength).map(wireMessage),
    stream: true,
    stream_options: { include_usage: true },
  };
  if (req.temperature !== undefined && !cfg.completionTokens) body.temperature = req.temperature;
  if (req.maxTokens !== undefined) body[cfg.completionTokens ? 'max_completion_tokens' : 'max_tokens'] = req.maxTokens;
  if (req.json) body.response_format = { type: 'json_object' };
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    if (req.toolChoice) body.tool_choice = req.toolChoice;
  }
  return { ...body, ...cfg.extra };
}

/** 一条消息 → OpenAI 兼容的写法(带工具调用的 assistant、工具结果) */
export function wireMessage(m: AiMessage): Record<string, unknown> {
  if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId ?? '', content: m.content };
  if (m.role === 'assistant' && m.toolCalls?.length) {
    return {
      role: 'assistant',
      // 没说话时写空串:两家自己回的就是空串(写 null 有的兼容接口不认)
      content: m.content ?? '',
      ...(m.reasoning !== undefined ? { reasoning_content: m.reasoning } : {}),
      tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args } })),
    };
  }
  return { role: m.role, content: m.content, ...(m.role === 'assistant' && m.reasoning !== undefined ? { reasoning_content: m.reasoning } : {}) };
}

/** 流式送来的工具调用:按 index 一段段拼起来 */
export class ToolCallAcc {
  private parts: { id: string; name: string; args: string }[] = [];
  add(list: unknown): void {
    if (!Array.isArray(list)) return;
    for (const raw of list as any[]) {
      if (!raw || typeof raw !== 'object') continue;
      const i = Number.isInteger(raw.index) ? raw.index : this.parts.length;
      const p = (this.parts[i] ??= { id: '', name: '', args: '' });
      if (typeof raw.id === 'string' && raw.id) p.id = raw.id;
      const f = raw.function;
      if (f && typeof f === 'object') {
        if (typeof f.name === 'string' && f.name) p.name = f.name;
        if (typeof f.arguments === 'string') p.args += f.arguments;
        else if (f.arguments && typeof f.arguments === 'object') p.args += JSON.stringify(f.arguments);
      }
    }
  }
  /** 拼好的调用(没名字的丢掉;没 id 的补一个) */
  calls(): AiToolCall[] {
    return this.parts
      .filter((p) => p && p.name)
      .map((p, i) => ({ id: p.id || `call_${i}`, name: p.name, args: p.args.trim() || '{}' }));
  }
}

function readUsage(u: any): AiUsage | undefined {
  if (!u || typeof u !== 'object') return undefined;
  const i = Number(u.prompt_tokens ?? u.input_tokens);
  const o = Number(u.completion_tokens ?? u.output_tokens);
  if (!Number.isFinite(i) && !Number.isFinite(o)) return undefined;
  return { inputTokens: Number.isFinite(i) ? i : 0, outputTokens: Number.isFinite(o) ? o : 0 };
}

function errorInfo(status: number, body: string): HttpErrorInfo {
  let code = '';
  let message = '';
  try {
    const j = JSON.parse(body);
    const e = j?.error ?? j;
    if (e && typeof e === 'object') {
      code = String(e.code ?? e.type ?? j.code ?? '');
      message = String(e.message ?? j.message ?? '');
    } else if (typeof e === 'string') message = e;
  } catch {
    message = body;
  }
  return { status, code: code === 'null' || code === 'undefined' ? '' : code, message: clipMsg(message) };
}

const has = (e: HttpErrorInfo, re: RegExp) => re.test(e.code) || re.test(e.message);

/** HTTP 错误 → 中文 AiError(通用规则) */
export function mapHttpError(name: string, e: HttpErrorInfo, model: string): AiError {
  const said = e.message ? `(${name} 说:${e.message})` : '';
  if (has(e, /model[_ ]?not[_ ]?(found|exist|supported)|model.*(not exist|does not exist)|模型不存在/i)) {
    return new AiError('other', `${name} 没有叫"${model}"的模型:到 AI 设置里换一个预设模型,或检查手填的名字${said}`);
  }
  // 内容安全审核(DeepSeek 回 400 "Content Exists Risk";别家多带 content_filter / inappropriate 字样)
  if (e.status === 400 && has(e, /content.?exists.?risk|content[_ ]?filter|inappropriate/i)) {
    return new AiError('content-filter', `${name} 的内容安全审核拦下了这次请求(战争、杀戮的描写有时会被误判),可以再试一次或换个文体${said}`);
  }
  switch (e.status) {
    case 401:
      return new AiError('auth', `${name} 的 API 密钥不对或已失效,请到 AI 设置里检查后重填${said}`);
    case 402:
      return new AiError('quota', `${name} 账户余额不足,请到 ${name} 官网充值后再试`);
    case 403:
      return new AiError('auth', `${name} 拒绝了这次请求:这个密钥可能没有权限使用"${model}"${said}`);
    case 429:
      return new AiError('rate-limit', `调用太频繁,${name} 让等一会儿再试${said}`);
    case 400:
    case 422:
      return new AiError('other', `${name} 不接受这次请求的参数${said || `(HTTP ${e.status})`}`);
    case 500:
    case 502:
    case 504:
      return new AiError('other', `${name} 的服务器出错了(HTTP ${e.status}),稍后再试`);
    case 503:
      return new AiError('rate-limit', `${name} 现在太忙(HTTP 503),稍后再试`);
    default:
      return new AiError('other', `${name} 返回了错误(HTTP ${e.status})${said}`);
  }
}

/** 调一次 OpenAI 兼容接口:流式读回,返回全文和用量 */
export async function compatChat(cfg: CompatConfig, req: AiRequest, opts: AiCallOptions): Promise<Omit<AiResult, 'provider' | 'ms'>> {
  if (opts.signal?.aborted) throw new AiError('aborted', '已取消');
  const idleMs = cfg.idleMs ?? IDLE_MS;
  // Allow thinking output without consuming the entire context on a small configured window.
  const thinking = cfg.extra?.enable_thinking === true || (cfg.extra?.thinking as { type?: string })?.type === 'enabled' || (cfg.extra?.reasoning_effort && cfg.extra.reasoning_effort !== 'none');
  if (thinking) {
    const output = req.maxTokens ?? 2000;
    const budget = Math.max(8192, Number(cfg.extra?.thinking_budget ?? 0) + output);
    const available = cfg.contextLength ? Math.floor(cfg.contextLength / 2) : 32768;
    req = { ...req, maxTokens: Math.max(output, Math.min(budget, available)) };
  } else if (cfg.contextLength && req.maxTokens === undefined) {
    req = { ...req, maxTokens: 2000 };
  }
  const prepared = { ...req, messages: fitContext({ ...req, messages: req.json ? withJsonHint(req.messages) : req.messages }, cfg.contextLength) };
  opts.onRequestMessages?.(prepared.messages);
  if (opts.signal?.aborted) throw new AiError('aborted', '已取消');
  const idle = idleTimer(opts.signal, idleMs);
  const arm = idle.arm;
  const fail = (e: unknown, phase: 'connect' | 'read'): AiError => {
    if (e instanceof AiError) return e;
    if (opts.signal?.aborted) return new AiError('aborted', '已取消');
    if (idle.timedOut()) return new AiError('network', `${cfg.name} 超过 ${Math.round(idleMs / 1000)} 秒没有回应,可能网络不好或服务商太忙,稍后再试`);
    return phase === 'connect'
      ? new AiError('network', `连不上 ${cfg.name}:请检查网络(代理、防火墙)后再试`)
      : new AiError('network', `和 ${cfg.name} 的连接中途断了,请再试一次`);
  };

  try {
    let res: Response;
    try {
      res = await fetch(cfg.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', Authorization: `Bearer ${cfg.key}` },
        body: JSON.stringify(compatBody(cfg, prepared)),
        signal: idle.signal,
        // 不带 cookie、不带来源页地址:只把请求本身发给服务商
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
    } catch (e) {
      throw fail(e, 'connect');
    }
    arm();
    if (!res.ok) {
      const info = errorInfo(res.status, await res.text().catch(() => ''));
      throw cfg.mapError?.(info) ?? mapHttpError(cfg.name, info, cfg.model);
    }

    let text = '';
    let reasoning = '';
    let hasReasoning = false;
    let usage: AiUsage | undefined;
    let model = cfg.model;
    let finish = '';
    const tools = new ToolCallAcc();
    const take = (j: any) => {
      if (j?.error) {
        const info = errorInfo(Number(j.error.status ?? j.status ?? 500) || 500, JSON.stringify(j));
        throw cfg.mapError?.(info) ?? mapHttpError(cfg.name, info, cfg.model);
      }
      if (typeof j?.model === 'string' && j.model) model = j.model;
      const u = readUsage(j?.usage);
      if (u) usage = u;
      const ch = Array.isArray(j?.choices) ? j.choices[0] : undefined;
      const piece = ch?.delta?.content ?? ch?.message?.content;
      if (typeof piece === 'string' && piece) {
        text += piece;
        opts.onDelta?.(piece, text);
      }
      const thought = ch?.delta?.reasoning_content ?? ch?.message?.reasoning_content ?? ch?.delta?.reasoning ?? ch?.message?.reasoning;
      if (typeof thought === 'string') {
        hasReasoning = true;
        reasoning += thought;
        if (thought) opts.onReasoningDelta?.(thought, reasoning);
      }
      tools.add(ch?.delta?.tool_calls ?? ch?.message?.tool_calls);
      if (ch?.finish_reason) finish = String(ch.finish_reason);
      if (opts.signal?.aborted) throw new AiError('aborted', '已取消');
    };

    const type = res.headers.get('content-type') ?? '';
    if (!res.body || /application\/json/i.test(type)) {
      // 不是流(个别代理会把流合成一整段):整段读
      let j: unknown;
      try {
        j = JSON.parse(await res.text());
      } catch (e) {
        throw e instanceof AiError ? e : new AiError('bad-response', `${cfg.name} 返回的内容看不懂`);
      }
      take(j);
    } else {
      let done = false;
      try {
        for await (const ev of readSse(res.body, arm)) {
          if (ev.data.trim() === '[DONE]') {
            done = true;
            break;
          }
          let j: unknown;
          try {
            j = JSON.parse(ev.data);
          } catch {
            throw new AiError('bad-response', `${cfg.name} 返回的内容看不懂`);
          }
          take(j);
        }
      } catch (e) {
        throw fail(e, 'read');
      }
      if (!done && !finish && !text && !tools.calls().length) throw new AiError('bad-response', `${cfg.name} 没有返回任何内容,请再试一次`);
    }
    if (finish === 'content_filter' || finish === 'sensitive') {
      throw new AiError('content-filter', `${cfg.name} 的内容安全审核拦下了这次回复,换个说法再试`);
    }
    const toolCalls = tools.calls();
    if (toolCalls.length) return { text, ...(hasReasoning ? { reasoning } : {}), toolCalls, model, usage };
    // 带着工具、刚交回工具结果:模型看结果已经摆在那儿,正常收尾不说话也行(要不要算空回复由助手循环定)
    if (!text && finish === 'stop' && req.tools?.length && req.messages.some((m) => m.role === 'tool')) return { text, ...(hasReasoning ? { reasoning } : {}), model, usage };
    if (!text) {
      throw new AiError(
        'bad-response',
        finish === 'length' ? `${cfg.name} 还没写出正文就到了长度上限(开着深度思考时容易这样),可以关掉深度思考再试` : `${cfg.name} 返回了空回复,请再试一次`,
      );
    }
    return { text, ...(hasReasoning ? { reasoning } : {}), model, usage };
  } finally {
    idle.dispose();
  }
}
