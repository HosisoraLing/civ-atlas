import type { AiProvider } from '../client';
import { AiError } from '../types';
import { getCustomProvider, getCustomSecret } from '../settings';
import { compatChat } from './compat';
import { sanitizeTuning, reasoningExtra } from '../tuning';

/** Accept an OpenAI-compatible base URL or the complete chat endpoint. */
export function customEndpoint(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); }
  catch { throw new AiError('not-configured', '请填写完整的 HTTP 或 HTTPS 接口地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new AiError('not-configured', '接口地址只能使用 HTTP 或 HTTPS，不应包含账号、密钥、查询参数或锚点');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (!url.pathname.endsWith('/chat/completions')) url.pathname += '/chat/completions';
  return url.href;
}

export const customProvider: AiProvider = {
  kind: 'custom',
  get label() { return getCustomProvider()?.name ?? '自定义服务'; },
  status() {
    const s = getCustomProvider();
    if (!s) return { ready: false, model: '', reason: '请先添加自定义服务商' };
    try { customEndpoint(s.baseUrl); }
    catch (e) { return { ready: false, model: s.model, reason: (e as Error).message }; }
    if (!s.model) return { ready: false, model: '', reason: '请填写模型名称' };
    if (!getCustomSecret(s.id)) return { ready: false, model: s.model, reason: '请填写自定义服务的 API 密钥' };
    return { ready: true, model: s.model };
  },
  async chat(req, opts) {
    const s = getCustomProvider();
    if (!s) throw new AiError('not-configured', '请先添加自定义服务商');
    const key = getCustomSecret(s.id);
    const url = customEndpoint(s.baseUrl);
    if (!s.model || !key) throw new AiError('not-configured', '请先填写自定义服务的模型名称和 API 密钥');
    const tuning = sanitizeTuning(s.modelTuning?.[s.model]);
    try { return await compatChat({ name: s.name, url, key, model: s.model,
      extra: reasoningExtra(tuning), contextLength: tuning.contextLength,
      completionTokens: tuning.reasoningFormat === 'openai',
    }, req, opts); }
    catch (e) {
      if (e instanceof AiError) {
        // The service may be removed or its key replaced while this request is pending.
        const message = e.message.split(key).join('***');
        throw new AiError(e.code, message + (e.code === 'network' ? '；请确认接口允许浏览器跨域访问，HTTPS 页面应使用 HTTPS 接口' : ''));
      }
      throw e;
    }
  },
};
