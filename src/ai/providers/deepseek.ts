/**
 * DeepSeek 官网 API(用户自己的密钥,浏览器直接调;费用由 DeepSeek 按它的价格从用户账户扣)。
 *
 *   地址:https://api.deepseek.com/chat/completions(OpenAI 兼容,允许网页直接调用)
 *   模型:deepseek-flash(快、便宜)、deepseek-v4-pro(更强);以官方文档为准(2026-09 查过),也能手填
 *   深度思考:DeepSeek 默认开着;我们默认关({ thinking: { type: 'disabled' } }),写史书、起名不需要,关了快很多也便宜;
 *     带工具的思考请求由 harness 原样回传 reasoning_content
 *   json 模式:response_format { type: 'json_object' }(提示词里要有 "json" 字样,compat.ts 会补)
 *   错误码(官方文档):401 密钥不对、402 余额不足、422 参数不对、429 太频繁、500 服务器出错、503 太忙
 */
import type { AiProvider } from '../client';
import { AiError } from '../types';
import { sanitizeTuning, reasoningExtra } from '../tuning';
import { getAiSettings, getSecrets } from '../settings';
import { compatChat } from './compat';

export const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';

/** 常用模型(界面上的预设;模型名会变,允许手填) */
export const DEEPSEEK_MODELS = [
  { id: 'deepseek-flash', note: '快、便宜(推荐)' },
  { id: 'deepseek-v4-pro', note: '更强,也更贵' },
];

export const deepseekProvider: AiProvider = {
  kind: 'deepseek',
  label: 'DeepSeek',
  status() {
    const s = getAiSettings().deepseek;
    if (!getSecrets().deepseek) return { ready: false, model: s.model, reason: '还没填 DeepSeek 的 API 密钥:到"AI"设置里填上' };
    return { ready: true, model: s.model };
  },
  async chat(req, opts) {
    const s = getAiSettings().deepseek;
    const tuning = { ...sanitizeTuning(s.tuning), reasoningFormat: 'deepseek' as const };
    const key = getSecrets().deepseek;
    if (!key) throw new AiError('not-configured', '还没填 DeepSeek 的 API 密钥:到"AI"设置里填上');
    return compatChat(
      {
        name: 'DeepSeek',
        url: DEEPSEEK_URL,
        key,
        model: s.model,
        extra: { thinking: { type: s.thinking ? 'enabled' : 'disabled' }, ...reasoningExtra(tuning) },
        contextLength: tuning.contextLength,
      },
      req,
      opts,
    );
  },
};
