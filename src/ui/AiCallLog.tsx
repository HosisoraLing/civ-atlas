/**
 * "AI → 调用记录"页签(阶段 5):每次 AI 调用一行 —— 时间、功能、说明、服务商 / 模型、用量、积分、耗时、成功 / 失败原因;
 * 点开看发出去的内容和收到的全文;删一条、清空、导出 JSON。记录只存在这个浏览器里(src/ai/callLog.ts)。
 */
import { useState } from 'react';
import { clearCalls, deleteCall, exportCallsJson, MAX_CALLS, useCallLog } from '../ai/callLog';
import type { AiCallRecord, AiProviderKind } from '../ai/types';

const PROVIDER_NAME: Record<AiProviderKind | 'none', string> = {
  none: '未设置',
  official: '我们的 AI',
  deepseek: 'DeepSeek',
  bailian: '阿里云百炼',
  custom: '自定义服务',
  mock: '测试用假 AI',
};

const ROLE: Record<string, string> = { system: '系统提示', user: '发给 AI', assistant: 'AI(之前的回复)', tool: '工具的结果(交回 AI)' };
/** 模型要调用的工具,一行一个:"country {"country":"P3"}" */
const callsText = (cs?: readonly { name: string; args: string }[]) => (cs ?? []).map((c) => `→ ${c.name} ${c.args}`).join('\n');

const pad = (n: number) => String(n).padStart(2, '0');

/** 9月28日 14:05:12(不是今年的带年份) */
function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const y = d.getFullYear() === new Date().getFullYear() ? '' : `${d.getFullYear()}年`;
  return `${y}${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 调用时在看的星球(种子 + 参数)→ "调用时在看:种子 7" */
function worldText(id: string | undefined): string {
  if (!id) return '';
  const q = new URLSearchParams(id);
  const seed = q.get('seed');
  if (!seed) return '';
  return `调用时在看:种子 ${seed}`;
}

const secs = (ms: number) => (ms < 1000 ? `${Math.round(ms)} 毫秒` : `${(ms / 1000).toFixed(1)} 秒`);
const n = (x: number) => x.toLocaleString('zh-CN');

function download(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function AiCallLog() {
  const { calls, persistent, loaded } = useCallLog();
  const [openId, setOpenId] = useState<string | null>(null);
  const [armClear, setArmClear] = useState(false);
  const exportJson = () => {
    const d = new Date();
    download(exportCallsJson(), `文明与地图-AI调用记录-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`);
  };
  const credits = calls.reduce((s, c) => s + (c.credits ?? 0), 0);
  const tokens = calls.reduce((s, c) => s + (c.usage ? c.usage.inputTokens + c.usage.outputTokens : 0), 0);
  return (
    <div className="ai-log">
      <div className="ai-log-top">
        <span className="ai-log-sum">
          {calls.length ? `共 ${calls.length} 条` : '还没有记录'}
          {tokens ? `，合计 ${n(tokens)} tokens` : ''}
          {credits ? `，共扣 ${n(credits)} 积分` : ''}
          <em>
            {persistent || !loaded ? `最多留最近 ${MAX_CALLS} 条` : '这个浏览器不让存,刷新就没了'}
          </em>
        </span>
        <button className="ai-mini" data-act="ai-log-export" disabled={!calls.length} onClick={exportJson} title="把全部记录存成 .json 文件">
          导出 JSON
        </button>
        <button
          className={`ai-mini${armClear ? ' danger' : ''}`}
          data-act="ai-log-clear"
          disabled={!calls.length}
          onClick={() => {
            if (!armClear) {
              setArmClear(true);
              setTimeout(() => setArmClear(false), 4000);
              return;
            }
            setArmClear(false);
            clearCalls();
          }}
          onBlur={() => setArmClear(false)}
        >
          {armClear ? '再点一次清空' : '清空'}
        </button>
      </div>
      {!calls.length ? (
        <p className="ai-log-empty">每次用 AI 都会在这里记一条</p>
      ) : (
        <div className="ai-log-list">
          {calls.map((c) => (
            <Row key={c.id} c={c} open={openId === c.id} onToggle={() => setOpenId((o) => (o === c.id ? null : c.id))} />
          ))}
        </div>
      )}
    </div>
  );
}

function Row({ c, open, onToggle }: { c: AiCallRecord; open: boolean; onToggle: () => void }) {
  const meta = [
    c.providerLabel ?? PROVIDER_NAME[c.provider] ?? c.provider,
    c.model ? `模型 ${c.model}` : '',
    c.usage ? `${n(c.usage.inputTokens)} → ${n(c.usage.outputTokens)} tokens` : '',
    c.credits !== undefined ? `扣 ${c.credits} 积分` : '',
    c.ms ? secs(c.ms) : '',
  ].filter(Boolean);
  return (
    <div className={`ai-log-row ${c.ok ? 'ok' : 'err'}${open ? ' open' : ''}`} data-id={c.id}>
      <button className="ai-log-head" onClick={onToggle} aria-expanded={open}>
        <span className="ai-log-l1">
          <b className="ai-log-st">{c.ok ? '✓' : '✗'}</b>
          <b className="ai-log-feat">{c.feature}</b>
          {c.title && <span className="ai-log-title">{c.title}</span>}
          <time dateTime={c.at}>{when(c.at)}</time>
        </span>
        <span className="ai-log-l2">
          {meta.join('，')}
          {!c.ok && c.error && <em className="ai-log-err">{c.error.message}</em>}
        </span>
      </button>
      {open && (
        <div className="ai-log-body">
          <h5>发出去的内容</h5>
          {c.messages.map((m, i) => (
            <div key={i} className={`ai-msg ${m.role}`}>
              <span className="ai-msg-role">{ROLE[m.role] ?? m.role}</span>
              <pre>{[m.content, callsText(m.toolCalls)].filter(Boolean).join('\n')}</pre>
            </div>
          ))}
          {c.reasoning && <details className="ai-reasoning"><summary>思考过程</summary><pre>{c.reasoning}</pre></details>}
          <h5>{c.ok ? '收到的全文' : '失败原因'}</h5>
          {c.ok ? (
            <pre className="ai-reply">{[c.text, callsText(c.toolCalls)].filter(Boolean).join('\n') || '(空)'}</pre>
          ) : (
            <p className="ai-log-fail">
              {c.error?.message ?? '未知错误'}
              {c.error?.code ? <span>(错误类型:{c.error.code})</span> : null}
            </p>
          )}
          <div className="ai-log-acts">
            <span className="ai-log-world">{worldText(c.world)}</span>
            {c.ok && c.text && (
              <button className="ai-mini" onClick={() => void navigator.clipboard?.writeText(c.text ?? '').catch(() => {})}>
                复制回复
              </button>
            )}
            <button className="ai-mini" data-act="ai-log-del" onClick={() => deleteCall(c.id)}>
              删除这条
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
