/**
 * AI 设置窗口(阶段 5):选用哪家 AI、填密钥、选模型、测试连接;"调用记录"页签看每一次调用(AiCallLog.tsx)。
 * 最上面是「使用 AI 功能」总开关(默认开):关掉以后这一页只剩这一行,界面上的 AI 入口都不显示(client.ts 的 useAiOn)。
 *
 *   openAiSettings(tab?)  打开它(成书窗口的"AI 设置"、提示条的"去设置"、别的面板要打开 AI 设置时都用这个)
 *   AiSettingsHost        窗口本身,App 里一直挂着(所以不管从哪儿打开都在)
 *
 *   我们的 AI(积分):登录网站账号后按次扣积分(登录窗和「我的世界」那个是同一个,AccountDialogs.tsx);
 *                   服务器还没上线时显示"还在内测,暂未开放"(src/ai/providers/official.ts)
 *   DeepSeek / 阿里云百炼:用户自己的 API 密钥,只存在这个浏览器里,请求直接从浏览器发给那一家
 *   测试用假 AI:开发时、或网址带 ai=mock 时才出现(不联网)
 *
 * 各功能在"还没设置 AI"时调 openAiSettings() 打开这里(client.ts 的 setAiSettingsOpener)。
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { aiChat, getActiveProvider, setAiSettingsOpener, useAiOn, useAiStatus } from '../ai/client';
import { AiError, type AiProviderKind } from '../ai/types';
import { addCustomProvider, getCustomProvider, getCustomSecret, removeCustomProvider, setCustomSecret, updateCustomProvider, chooseProvider, cleanKey, getAiSettings, getSecrets, setAiEnabled, setSecret, updateAiSettings, useAiSettingsVersion } from '../ai/settings';
import { DEEPSEEK_MODELS } from '../ai/providers/deepseek';
import { BAILIAN_MODELS, BAILIAN_REGIONS } from '../ai/providers/bailian';
import { officialServer, refreshOfficialAccount, useOfficialAccount } from '../ai/providers/official';
import { openAccount, openLogin } from './AccountDialogs';
import { Icon } from './icons';
import { mockSelectable } from '../ai/setup';
import { useCallLog } from '../ai/callLog';
import { AiCallLog } from './AiCallLog';
import { sanitizeTuning, type AiTuning, type ReasoningFormat, type ReasoningEffort } from '../ai/tuning';
import { PRIVACY_URL } from './links';
import './ai.css';

type Tab = 'settings' | 'log';

// ---------------------------------------------------------------------------
// 开关

let dialog: { open: boolean; tab: Tab } = { open: false, tab: 'settings' };
const subs = new Set<() => void>();
const setDialog = (d: typeof dialog) => {
  dialog = d;
  subs.forEach((f) => f());
};
function useDialog() {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => dialog,
    () => dialog,
  );
}

/** 打开 AI 设置(tab = 'log' 直接看调用记录) */
export function openAiSettings(tab: Tab = 'settings'): void {
  setDialog({ open: true, tab });
}
export function closeAiSettings(): void {
  if (dialog.open) setDialog({ ...dialog, open: false });
}

/** AI 设置窗口:App 里挂一次;各功能经 ai/client 的 openAiSettings()(没设置 AI 时)也打开这里 */
export function AiSettingsHost() {
  const d = useDialog();
  useEffect(() => {
    setAiSettingsOpener(() => openAiSettings('settings'));
    return () => setAiSettingsOpener(null);
  }, []);
  if (!d.open) return null;
  return <AiDialog tab={d.tab} onTab={(tab) => setDialog({ open: true, tab })} onClose={closeAiSettings} />;
}

const mockForced = () => typeof location !== 'undefined' && new URLSearchParams(location.search).get('ai') === 'mock';

/** 对话框开着时按 Esc 关掉(先于页面上别的 Esc) */
function useEscape(f: () => void) {
  const latest = useRef(f);
  latest.current = f;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      latest.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
}

function AiDialog({ tab, onTab, onClose }: { tab: Tab; onTab: (t: Tab) => void; onClose: () => void }) {
  useEscape(onClose);
  const log = useCallLog();
  return createPortal(
    <div className="ai-dialog-bg" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="ai-dialog" role="dialog" aria-modal="true" aria-label="AI 设置" data-testid="ai-dialog" onWheel={(e) => e.stopPropagation()}>
        <header className="ai-head">
          <h2 className="ai-title">AI 设置</h2>
          <button className="ai-x" onClick={onClose} title="关闭" aria-label="关闭">
            ✕
          </button>
        </header>
        <nav className="ai-tabs">
          <button className={tab === 'settings' ? 'on' : ''} data-tab="settings" onClick={() => onTab('settings')}>
            用哪家 AI
          </button>
          <button className={tab === 'log' ? 'on' : ''} data-tab="log" onClick={() => onTab('log')}>
            调用记录{log.calls.length ? <em>{log.calls.length}</em> : null}
          </button>
        </nav>
        <div className="ai-body">{tab === 'settings' ? <SettingsPage /> : <AiCallLog />}</div>
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// 设置页签

/** 最上面「使用 AI 功能」开关;关着时下面的都收起来 */
function SettingsPage() {
  const on = useAiOn();
  return (
    <>
      <div className={`ai-master${on ? '' : ' off'}`}>
        <div className="ai-master-text">
          <b>使用 AI 功能</b>
          <span>关掉以后，助手、写史书、名字由来、AI 起名这些入口都不显示。写过的史书和名字由来不会删，再打开就回来。</span>
        </div>
        <button className={`ai-switch${on ? ' on' : ''}`} role="switch" aria-checked={on} aria-label="使用 AI 功能" data-act="ai-master" onClick={() => setAiEnabled(!on)} />
      </div>
      {on && <SettingsTab />}
    </>
  );
}

interface Choice {
  kind: AiProviderKind;
  name: string;
  desc: string;
}

const CHOICES: Choice[] = [
  { kind: 'official', name: '我们的 AI', desc: '登录后按次扣积分' },
  { kind: 'deepseek', name: 'DeepSeek', desc: '用自己的 API 密钥,由 DeepSeek 计费' },
  { kind: 'bailian', name: '阿里云百炼', desc: '用自己的 API 密钥,由阿里云计费' },
  { kind: 'custom', name: '自定义服务', desc: '自选接口地址、API 密钥和模型（OpenAI 兼容）' },
  { kind: 'mock', name: '测试用假 AI', desc: '回一段假话,检查界面用' },
];

function SettingsTab() {
  useAiSettingsVersion();
  useAiStatus();
  const acct = useOfficialAccount();
  const s = getAiSettings();
  const sec = getSecrets();
  const active = getActiveProvider();
  const server = officialServer();
  const forced = mockForced();
  const choices = CHOICES.filter((c) => c.kind !== 'mock' || mockSelectable());

  const badge = (k: AiProviderKind): { text: string; cls?: string } => {
    if (k === 'official') {
      if (!server) return { text: '内测中,暂未开放', cls: 'off' };
      if (!acct.loggedIn) return { text: '未登录' };
      if (acct.credits === undefined) return { text: '已登录', cls: 'ok' };
      return { text: `余额 ${acct.credits} 积分`, cls: acct.credits > 0 ? 'ok' : 'warn' };
    }
    if (k === 'deepseek') return sec.deepseek ? { text: '已填密钥', cls: 'ok' } : { text: '未填密钥' };
    if (k === 'bailian') return sec.bailian ? { text: '已填密钥', cls: 'ok' } : { text: '未填密钥' };
    if (k === 'custom') return getCustomProvider()?.model && getCustomProvider()?.baseUrl && getCustomSecret(s.customProviderId ?? '') ? { text: '已配置', cls: 'ok' } : { text: '待配置' };
    return { text: forced ? '网址带 ai=mock,强制使用' : '不联网', cls: forced ? 'ok' : undefined };
  };

  return (
    <div className="ai-settings">
      <div className="ai-choices" role="radiogroup" aria-label="用哪家 AI">
        {choices.map((c) => {
          const b = badge(c.kind);
          const disabled = (c.kind === 'official' && !server) || (forced && c.kind !== 'mock');
          return (
            <button
              key={c.kind}
              role="radio"
              aria-checked={active === c.kind}
              data-ai={c.kind}
              className={`ai-choice${active === c.kind ? ' on' : ''}`}
              disabled={disabled}
              onClick={() => chooseProvider(c.kind)}
            >
              <i className="ai-radio" />
              <span className="ai-choice-text">
                <b>
                  {c.name}
                  <em className={`ai-badge${b.cls ? ` ${b.cls}` : ''}`}>{b.text}</em>
                </b>
                <span>{c.desc}</span>
              </span>
            </button>
          );
        })}
      </div>

      {forced && <p className="ai-note warn">网址带 ai=mock,只能用测试用假 AI</p>}

      {active === 'custom' && <CustomSettings key={s.customProviderId ?? 'empty'} />}

      {active === 'deepseek' && (
        <div className="ai-detail" data-detail="deepseek">
          <KeyField slot="deepseek" where={<a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noreferrer">DeepSeek 开放平台</a>} />
          <ModelField value={s.deepseek.model} presets={DEEPSEEK_MODELS} placeholder="比如 deepseek-v4-pro" onChange={(model) => updateAiSettings({ deepseek: { model } })} />
          <TuningFields id="deepseek" value={{ ...sanitizeTuning(s.deepseek.tuning), reasoningFormat: 'deepseek', ...(!s.deepseek.tuning && !s.deepseek.thinking ? { reasoningEffort: 'none' } : {}) }} onChange={tuning => updateAiSettings({ deepseek: { tuning, thinking: tuning.reasoningEffort !== 'none' } })} />
          <TestRow disabled={!sec.deepseek} sig={`deepseek|${s.deepseek.model}|${s.deepseek.thinking}|${JSON.stringify(s.deepseek.tuning)}|${sec.deepseek?.length ?? 0}`} />
        </div>
      )}
      {active === 'bailian' && (
        <div className="ai-detail" data-detail="bailian">
          <div className="ai-row">
            <label className="ai-label">地域</label>
            <div className="ai-opts">
              {BAILIAN_REGIONS.map((r) => (
                <button key={r.id} className={`ai-opt${s.bailian.region === r.id ? ' on' : ''}`} aria-pressed={s.bailian.region === r.id} onClick={() => updateAiSettings({ bailian: { region: r.id } })}>
                  {r.name}
                </button>
              ))}
            </div>
          </div>
          <p className="ai-note sub">选创建密钥时的地域</p>
          <KeyField slot="bailian" where={<a href="https://bailian.console.aliyun.com/" target="_blank" rel="noreferrer">百炼控制台</a>} />
          <ModelField value={s.bailian.model} presets={BAILIAN_MODELS} placeholder="比如 qwen-max-latest" onChange={(model) => updateAiSettings({ bailian: { model } })} />
          <TuningFields id="bailian" value={{ ...sanitizeTuning(s.bailian.tuning), reasoningFormat: 'qwen', ...(!s.bailian.tuning && !s.bailian.thinking ? { reasoningEffort: 'none' } : {}) }} onChange={tuning => updateAiSettings({ bailian: { tuning, thinking: tuning.reasoningEffort !== 'none' } })} />
          <TestRow disabled={!sec.bailian} sig={`bailian|${s.bailian.region}|${s.bailian.model}|${s.bailian.thinking}|${JSON.stringify(s.bailian.tuning)}|${sec.bailian?.length ?? 0}`} />
        </div>
      )}
      {active === 'official' && (
        <div className="ai-detail" data-detail="official">
          {!server ? (
            <p className="ai-note">内测中,暂未开放;可以先用自己的 DeepSeek 或百炼密钥</p>
          ) : acct.loggedIn ? (
            <OfficialAccountView />
          ) : (
            <SignInRow />
          )}
          {server && acct.loggedIn && <TestRow disabled={false} sig={`official|${acct.account}`} />}
        </div>
      )}
      {active === 'mock' && (
        <div className="ai-detail" data-detail="mock">
          <TestRow disabled={false} sig="mock" />
        </div>
      )}

      <label className="ai-check ai-remember" title="关掉:只在这次打开的页面里有效,刷新就忘">
        <input type="checkbox" checked={s.remember} onChange={(e) => updateAiSettings({ remember: e.target.checked })} />
        <span>下次打开时记住密钥</span>
      </label>

      <p className="ai-foot">
        <span>密钥只存在这个浏览器里</span>
        <a href={PRIVACY_URL} target="_blank" rel="noreferrer" data-link="privacy">
          隐私政策
        </a>
      </p>
    </div>
  );
}

function CustomSettings() {
  const revision = useAiSettingsVersion(), s = getAiSettings(), p = getCustomProvider();
  const [modelName, setModelName] = useState('');
  const addModel = () => {
    const name = modelName.trim();
    if (!p || !name) return;
    updateCustomProvider(p.id, { models: [...p.models, name], model: name });
    setModelName('');
  };
  return <div className="ai-detail" data-detail="custom">
    <div className="ai-row">
      <label className="ai-label" htmlFor="ai-custom-provider">服务商</label>
      {p && <select id="ai-custom-provider" className="ai-input ai-select" value={p.id} onChange={e => updateAiSettings({ customProviderId: e.target.value })}>
        {s.customProviders.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>}
      <button className="ai-mini" data-act="custom-provider-add" onClick={() => addCustomProvider()}>新增服务商</button>
      {p && <button className="ai-mini" data-act="custom-provider-delete" onClick={() => {
        if (confirm(`删除服务商「${p.name}」及其模型和保存的密钥？`)) removeCustomProvider(p.id);
      }}>删除服务商</button>}
    </div>
    {p ? <>
      <div className="ai-row"><label className="ai-label" htmlFor="ai-custom-name">服务商名称</label><input id="ai-custom-name" className="ai-input" value={p.name} maxLength={120} onChange={e => updateCustomProvider(p.id, { name: e.target.value })} /></div>
      <div className="ai-row"><label className="ai-label" htmlFor="ai-custom-url">接口地址</label><input id="ai-custom-url" className="ai-input" type="url" autoComplete="off" spellCheck={false} placeholder="https://api.example.com/v1" value={p.baseUrl} maxLength={2048} onChange={e => updateCustomProvider(p.id, { baseUrl: e.target.value })} /></div>
      <p className="ai-note sub">填写 Base URL 或完整的 /chat/completions 地址；接口需要允许浏览器跨域访问。各服务商独立保存密钥和模型。</p>
      <KeyField slot="custom" providerId={p.id} />
      <div className="ai-row">
        <label className="ai-label" htmlFor="ai-custom-model">当前模型</label>
        <select id="ai-custom-model" className="ai-input ai-select" value={p.model} disabled={!p.models.length} onChange={e => updateCustomProvider(p.id, { model: e.target.value })}>
          {!p.models.length && <option value="">请先添加模型</option>}
          {p.models.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
        <button className="ai-mini" data-act="custom-model-delete" disabled={!p.model} onClick={() => updateCustomProvider(p.id, { models: p.models.filter(m => m !== p.model) })}>删除模型</button>
      </div>
      <div className="ai-row">
        <label className="ai-label" htmlFor="ai-custom-model-name">添加模型</label>
        <input id="ai-custom-model-name" className="ai-input" autoComplete="off" spellCheck={false} placeholder="填写服务商提供的模型名称" value={modelName} maxLength={120} onChange={e => setModelName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addModel(); } }} />
        <button className="ai-mini" data-act="custom-model-add" disabled={!modelName.trim()} onClick={addModel}>添加模型</button>
      </div>
      {p.model && <TuningFields id="custom" custom value={sanitizeTuning(p.modelTuning?.[p.model])} onChange={tuning => updateCustomProvider(p.id, { modelTuning: { ...p.modelTuning, [p.model]: tuning } })} />}
      <TestRow key={revision} disabled={!getCustomSecret(p.id) || !p.baseUrl || !p.model} sig={`${p.id}|${revision}`} />
    </> : <p className="ai-note">新增服务商后，填写接口、密钥并添加模型。可以保存多个服务商，随时切换。</p>}
  </div>;
}

function KeyField({ slot, where, providerId }: { slot: 'deepseek' | 'bailian' | 'custom'; where?: React.ReactNode; providerId?: string }) {
  const saved = slot === 'custom' ? getCustomSecret(providerId ?? '') : getSecrets()[slot] ?? '';
  const save = (key: string) => {
    if (slot === 'custom') setCustomSecret(providerId ?? '', key);
    else setSecret(slot, key || undefined);
  };
  const [v, setV] = useState(saved);
  const [show, setShow] = useState(false);
  // 别处改了(比如清除)时跟上
  useEffect(() => {
    if (cleanKey(v) !== saved) setV(saved);
  }, [saved]);
  return (
    <>
      <div className="ai-row">
        <label className="ai-label" htmlFor={`ai-key-${slot}`}>
          API 密钥
        </label>
        <input
          id={`ai-key-${slot}`}
          className="ai-input ai-key"
          type={show ? 'text' : 'password'}
          autoComplete="off"
          spellCheck={false}
          placeholder="sk-……"
          value={v}
          onChange={(e) => {
            setV(e.target.value);
            save(cleanKey(e.target.value));
          }}
        />
        <button className="ai-mini" onClick={() => setShow((x) => !x)} title={show ? '把密钥遮住' : '显示密钥'}>
          {show ? '遮住' : '显示'}
        </button>
        {v && (
          <button
            className="ai-mini"
            onClick={() => {
              setV('');
              save('');
            }}
            title="从这个浏览器里删掉这个密钥"
          >
            清除
          </button>
        )}
      </div>
      {where && <p className="ai-note sub">没有密钥?到 {where} 创建</p>}
    </>
  );
}

const CUSTOM = '__custom';

function ModelField({
  value,
  presets,
  placeholder,
  onChange,
}: {
  value: string;
  presets: { id: string; note: string }[];
  placeholder: string;
  onChange: (m: string) => void;
}) {
  const isPreset = presets.some((p) => p.id === value);
  const [custom, setCustom] = useState(!isPreset);
  const [text, setText] = useState(isPreset ? '' : value);
  return (
    <div className="ai-row">
      <label className="ai-label">模型</label>
      <select
        className="ai-input ai-select"
        value={custom ? CUSTOM : value}
        onChange={(e) => {
          if (e.target.value === CUSTOM) {
            setCustom(true);
            if (text.trim()) onChange(text.trim());
          } else {
            setCustom(false);
            onChange(e.target.value);
          }
        }}
      >
        {presets.map((p) => (
          <option key={p.id} value={p.id}>
            {p.id} —— {p.note}
          </option>
        ))}
        <option value={CUSTOM}>手填模型名……</option>
      </select>
      {custom && (
        <input
          className="ai-input ai-model"
          placeholder={placeholder}
          spellCheck={false}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (e.target.value.trim()) onChange(e.target.value.trim());
          }}
        />
      )}
    </div>
  );
}

function TuningFields({ id, value, custom, onChange }: { id: string; value: AiTuning; custom?: boolean; onChange: (value: AiTuning) => void }) {
  const levels: { id: ReasoningEffort; label: string }[] = [
    { id: 'default', label: '模型默认' }, { id: 'none', label: '关闭' }, { id: 'low', label: '低' },
    { id: 'medium', label: '中' }, { id: 'high', label: '高' }, { id: 'max', label: '最高' },
  ];
  const [length, setLength] = useState(String(value.contextLength || ''));
  useEffect(() => setLength(String(value.contextLength || '')), [value.contextLength]);
  return <>
    {custom && <div className="ai-row">
      <label className="ai-label" htmlFor={`ai-${id}-reasoning-format`}>思考接口</label>
      <select id={`ai-${id}-reasoning-format`} className="ai-input ai-select" value={value.reasoningFormat} onChange={e => onChange({ ...value, reasoningFormat: e.target.value as ReasoningFormat, reasoningEffort: 'default' })}>
        <option value="none">不指定 · 使用模型默认</option><option value="openai">OpenAI 兼容</option><option value="deepseek">DeepSeek</option><option value="qwen">Qwen / 百炼</option>
      </select>
    </div>}
    <div className="ai-row">
      <label className="ai-label" htmlFor={`ai-${id}-reasoning-effort`}>思考强度</label>
      <select id={`ai-${id}-reasoning-effort`} className="ai-input ai-select" disabled={value.reasoningFormat === 'none'} value={value.reasoningEffort} onChange={e => onChange({ ...value, reasoningEffort: e.target.value as ReasoningEffort })}>
        {levels.filter(l => value.reasoningFormat !== 'deepseek' || l.id !== 'medium').map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
      </select>
    </div>
    <div className="ai-row">
      <label className="ai-label" htmlFor={`ai-${id}-context-length`}>上下文长度</label>
      <input id={`ai-${id}-context-length`} className="ai-input" type="number" min={1024} max={2000000} step={1} placeholder="模型默认" value={length} onChange={e => setLength(e.target.value)} onBlur={() => {
        const n = length === '' ? 0 : Number(length);
        if (n !== 0 && (!Number.isInteger(n) || n < 1024 || n > 2000000)) { setLength(String(value.contextLength || '')); return; }
        onChange({ ...value, contextLength: n });
      }} />
      <span className="ai-note">Token</span>
    </div>
    <p className="ai-note sub">上下文按估算 Token 控制，保留当前问题与工具结果，超限时裁掉较早对话。不能超过模型本身的上限。思考强度以模型支持为准；仅显示服务商实际返回的思考内容。{value.reasoningFormat === 'qwen' ? '强度对应思考预算：低 1024、中 4096、高 8192、最高 16384 Token。' : ''}{custom ? '设置随当前模型独立保存。' : ''}</p>
  </>;
}

const dur = (ms: number) => (ms < 1000 ? `${Math.round(ms)} 毫秒` : `${(ms / 1000).toFixed(1)} 秒`);

interface TestState {
  sig: string;
  kind: 'busy' | 'ok' | 'error';
  text: string;
}

/** "测试一下":发一个很小的请求(走 aiChat,调用记录里也会有一条) */
function TestRow({ disabled, sig }: { disabled: boolean; sig: string }) {
  const [st, setSt] = useState<TestState | null>(null);
  const ac = useRef<AbortController | null>(null);
  useEffect(() => () => ac.current?.abort(), []);
  const run = async () => {
    ac.current?.abort();
    const ctl = (ac.current = new AbortController());
    setSt({ sig, kind: 'busy', text: '正在测试……' });
    const t0 = performance.now();
    const secs = () => dur(performance.now() - t0);
    try {
      const r = await aiChat(
        {
          feature: '连接测试',
          title: 'AI 设置里点了"测试一下"',
          messages: [{ role: 'user', content: '这是一次连接测试。请只回复两个字:你好' }],
          temperature: 0,
        },
        { signal: ctl.signal },
      );
      if (ctl.signal.aborted) return;
      const reply = r.text.replace(/\s+/g, ' ').trim();
      const extra = [r.usage ? `${r.usage.inputTokens + r.usage.outputTokens} tokens` : '', r.credits !== undefined ? `扣了 ${r.credits} 积分` : '']
        .filter(Boolean)
        .join('，');
      setSt({
        sig,
        kind: 'ok',
        text: `连上了，用时 ${dur(r.ms)}，模型 ${r.model}${extra ? `，${extra}` : ''}，回复"${reply.length > 40 ? reply.slice(0, 40) + '…' : reply}"`,
      });
    } catch (e) {
      if (ctl.signal.aborted) return;
      const msg = e instanceof AiError ? e.message : String(e);
      setSt({ sig, kind: 'error', text: `${msg}(用时 ${secs()})` });
    }
  };
  const cur = st && st.sig === sig ? st : null;
  return (
    <div className="ai-row ai-test-row">
      <button className="ai-test-btn" data-act="ai-test" disabled={disabled || cur?.kind === 'busy'} onClick={run}>
        {cur?.kind === 'busy' ? '测试中……' : '测试一下'}
      </button>
      {cur ? (
        <span className={`ai-test ${cur.kind}`} data-testid="ai-test-result">
          {cur.text}
        </span>
      ) : (
        disabled && <span className="ai-test idle">先填上密钥</span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 我们的 AI:登录 / 账户

/** 没登录:一个「登录」按钮,弹出和「我的世界」同一个登录窗 */
function SignInRow() {
  return (
    <div className="ai-login">
      <div className="ai-row">
        <label className="ai-label">账号</label>
        <span className="ai-val" style={{ color: 'var(--ink-2)' }}>
          没登录
        </span>
        <button className="ai-mini primary ai-signin" data-act="ai-login" onClick={() => openLogin()}>
          <Icon name="personc" size={16} />
          登录
        </button>
      </div>
      <p className="ai-note sub">和「我的世界」云同步用同一个账号，用邮箱收验证码就能登录。</p>
    </div>
  );
}

function OfficialAccountView() {
  const acct = useOfficialAccount();
  return (
    <div className="ai-account">
      <div className="ai-row">
        <label className="ai-label">账号</label>
        <span className="ai-val">{acct.name && acct.name !== acct.account ? `${acct.name}(${acct.account})` : acct.account}</span>
        <button className="ai-mini" data-act="ai-account" onClick={() => openAccount()}>
          账号
        </button>
      </div>
      <div className="ai-row">
        <label className="ai-label">积分余额</label>
        <span className="ai-val ai-credits" data-testid="ai-credits">
          {acct.credits !== undefined ? <b>{acct.credits}</b> : '—'} 积分
        </span>
        <button className="ai-mini" disabled={acct.checking} onClick={() => void refreshOfficialAccount()}>
          {acct.checking ? '查询中……' : '刷新'}
        </button>
      </div>
      {acct.pricing && <p className="ai-note sub">{acct.pricing}</p>}
      {acct.error && <p className="ai-note err">{acct.error}</p>}
    </div>
  );
}
