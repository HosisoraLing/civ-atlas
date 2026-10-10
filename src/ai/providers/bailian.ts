/**
 * 阿里云百炼(通义千问)API(用户自己的密钥,浏览器直接调;费用由阿里云按它的价格从用户账户扣)。
 *
 *   地址(OpenAI 兼容,允许网页直接调用;密钥分地域,北京的密钥只能调北京的地址):
 *     中国大陆(北京)https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions
 *     国际(新加坡)  https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions
 *   模型:qwen-plus(均衡)、qwen3.8-max(最准)、qwen3.7-plus(居中)、qwen-flash(最便宜);以官方文档为准,也能手填
 *   深度思考:enable_thinking,每次都明说开或关(qwen3.7 / 3.8 系、百炼上的 deepseek-v4 等新模型不传就默认思考;
 *     开了要流式,我们一直是流式);json 模式时不开(思考模式不支持结构化输出);助手支持带工具的思考请求
 *   json 模式:response_format { type: 'json_object' }(提示词里要有 "json" 字样,compat.ts 会补)
 *   错误码(官方文档):401 invalid_api_key、400 Arrearage(欠费)/ DataInspectionFailed(内容审核)/ InvalidParameter、
 *     403 AccessDenied(.Unpurchased)/ AllocationQuota.FreeTierOnly、404 model_not_found、429 Throttling / insufficient_quota(限流)
 */
import type { AiProvider } from '../client';
import { AiError } from '../types';
import { sanitizeTuning, reasoningExtra } from '../tuning';
import { getAiSettings, getSecrets, type BailianRegion } from '../settings';
import { compatChat, type HttpErrorInfo } from './compat';

export const BAILIAN_URLS: Record<BailianRegion, string> = {
  cn: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
  intl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions',
};

export const BAILIAN_REGIONS: { id: BailianRegion; name: string }[] = [
  { id: 'cn', name: '中国大陆(北京)' },
  { id: 'intl', name: '国际(新加坡)' },
];

/**
 * 常用模型(界面上的预设;模型名会变,允许手填)。2026-09 用写史书、释名起名实测过:
 * qwen-plus 最快最省;qwen3.8-max 最准,约贵十几倍;qwen3.7-plus 居中
 */
export const BAILIAN_MODELS = [
  { id: 'qwen-plus', note: '均衡(推荐):快、便宜' },
  { id: 'qwen3.8-max', note: '最准,约贵十几倍' },
  { id: 'qwen3.7-plus', note: '较准,约贵三四倍' },
  { id: 'qwen-flash', note: '最便宜' },
];

const NAME = '阿里云百炼';

/** 百炼特有的错误码(先于通用规则) */
export function mapBailianError(e: HttpErrorInfo): AiError | null {
  const t = `${e.code} ${e.message}`;
  const said = e.message ? `(百炼说:${e.message})` : '';
  if (/arrearage|overdue|欠费/i.test(t)) return new AiError('quota', `阿里云账户欠费了,请到阿里云控制台充值后再试${said}`);
  if (/FreeTierOnly|free tier|免费额度/i.test(t)) return new AiError('quota', `这个模型的免费额度用完了:到百炼控制台关掉"仅用免费额度",或换一个模型${said}`);
  if (/DataInspectionFailed|data_inspection|inappropriate/i.test(t)) {
    // 拦的是回复(Output data …):写到一半被拦,多半是战争、屠城之类的描写被误判;拦的是请求:提示词本身(比如作者加的要求)
    if (/output/i.test(t)) {
      return new AiError('content-filter', `阿里云的内容安全审核拦下了 AI 写出来的内容(战争、杀戮的描写有时会被误判),可以再试一次,或换个文体、换个模型${said}`);
    }
    return new AiError('content-filter', `阿里云的内容安全审核拦下了这次请求,换个说法再试${said}`);
  }
  if (/Unpurchased|not.*(activated|opened)|未开通/i.test(t)) return new AiError('auth', `这个阿里云账号还没开通百炼服务,请先到百炼控制台开通${said}`);
  if (e.status === 401 || /invalid_api_key|InvalidApiKey/i.test(t)) {
    return new AiError('auth', `阿里云百炼的 API 密钥不对:检查有没有填错;另外密钥分地域,北京的密钥要选"中国大陆",新加坡的选"国际"${said}`);
  }
  if (e.status === 429) return new AiError('rate-limit', `调用太频繁,超过了百炼的限流,等一会儿再试${said}`);
  return null;
}

export const bailianProvider: AiProvider = {
  kind: 'bailian',
  label: NAME,
  status() {
    const s = getAiSettings().bailian;
    if (!getSecrets().bailian) return { ready: false, model: s.model, reason: '还没填阿里云百炼的 API 密钥:到"AI"设置里填上' };
    return { ready: true, model: s.model };
  },
  async chat(req, opts) {
    const s = getAiSettings().bailian;
    const tuning = { ...sanitizeTuning(s.tuning), reasoningFormat: 'qwen' as const };
    const key = getSecrets().bailian;
    if (!key) throw new AiError('not-configured', '还没填阿里云百炼的 API 密钥:到"AI"设置里填上');
    return compatChat(
      {
        name: NAME,
        url: BAILIAN_URLS[s.region],
        key,
        model: s.model,
        // 开关一律明说:新一代模型(qwen3.7 / 3.8、百炼上的 deepseek-v4 等)不传就默认思考 ——
        // 一句话的回复也要先想十几二十秒、多花几十倍的输出 token。老模型(qwen-plus / max / flash / turbo)传 false 也照常(2026-09 实测)
        extra: { enable_thinking: s.thinking, ...reasoningExtra(tuning), ...(req.json ? { enable_thinking: false } : {}) },
        contextLength: tuning.contextLength,
        mapError: mapBailianError,
      },
      req,
      opts,
    );
  },
};
