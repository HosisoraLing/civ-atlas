import { dataStorage } from "../account/wikiStorage";
/**
 * AI 设置与密钥的本地存储(阶段 5)。只存在用户自己的浏览器里,不上传。
 *
 *   设置(用不用 AI、用哪家、模型、地域、深度思考、记不记密钥)→ localStorage 'civ-atlas:ai-settings'
 *   密钥(DeepSeek / 百炼 / 自定义服务的 API 密钥、我们 AI 的登录令牌)→
 *       "记住密钥"开着:localStorage 'civ-atlas:ai-secrets'(下次打开还在)
 *       关着:只在内存里(这次打开的页面有效,刷新 / 关掉就忘),同时把存过的删掉
 *
 * 浏览器存储不可用(隐私模式)时一律只在内存里。
 * 规矩:密钥不进网址、不进调用记录、不打印到控制台。
 */
import { useSyncExternalStore } from 'react';
import { notifyAiChanged, setActiveProvider, setAiOn } from './client';
import type { AiProviderKind } from './types';
import { sanitizeTuning, type AiTuning } from './tuning';

export type BailianRegion = 'cn' | 'intl';

export interface CustomAiConfig {
  id: string;
  name: string;
  baseUrl: string;
  models: string[];
  model: string;
  /** Independent runtime options for each model. */
  modelTuning?: Record<string, AiTuning>;
}

export interface AiSettings {
  /** 「使用 AI 功能」:关掉 = 界面上所有 AI 入口都不显示(只管这个浏览器;写过的史书、名字由来不删) */
  enabled: boolean;
  /** 用哪家;null = 还没选 */
  provider: AiProviderKind | null;
  /** 在这个浏览器里记住密钥和登录 */
  remember: boolean;
  deepseek: { model: string; thinking: boolean; tuning?: AiTuning };
  bailian: { model: string; region: BailianRegion; thinking: boolean; tuning?: AiTuning };
  customProviders: CustomAiConfig[];
  customProviderId: string | null;
}

/** 存密钥的格子:内置与自定义服务商的 API 密钥 + 我们的 AI 的登录令牌 */
export interface AiSecrets {
  deepseek?: string;
  bailian?: string;
  customProviders?: Record<string, string>;
  official?: { token: string; account?: string };
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
  enabled: true,
  provider: null,
  remember: true,
  deepseek: { model: 'deepseek-flash', thinking: false },
  bailian: { model: 'qwen-plus', region: 'cn', thinking: false },
  customProviders: [],
  customProviderId: null,
};

const SETTINGS_KEY = 'civ-atlas:ai-settings';
const SECRETS_KEY = 'civ-atlas:ai-secrets';
const KINDS: AiProviderKind[] = ['official', 'deepseek', 'bailian', 'custom', 'mock'];

function storage(): Storage | null {
  try {
    return dataStorage() ?? null;
  } catch {
    return null;
  }
}

function readJson(key: string): unknown {
  try {
    const raw = storage()?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, v: unknown | null) {
  try {
    const s = storage();
    if (!s) return;
    if (v === null) s.removeItem(key);
    else s.setItem(key, JSON.stringify(v));
  } catch {
    /* 存不下 / 隐私模式:只留在内存里 */
  }
}

const str = (v: unknown, d: string) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 120) : d);
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);

/** 读存档里的设置,坏的字段用默认值 */
export function sanitizeSettings(v: unknown): AiSettings {
  const d = DEFAULT_AI_SETTINGS;
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, any>;
  const ds = (o.deepseek && typeof o.deepseek === 'object' ? o.deepseek : {}) as Record<string, unknown>;
  const bl = (o.bailian && typeof o.bailian === 'object' ? o.bailian : {}) as Record<string, unknown>;
  // Previous releases stored one custom config and one key; its stable ID keeps them paired.
  const legacy = o.custom && typeof o.custom === 'object' ? o.custom : null;
  const rawProviders = Array.isArray(o.customProviders) ? o.customProviders : legacy
    ? [{ ...legacy, id: 'custom-legacy', models: [legacy.model] }] : [];
  const ids = new Set<string>();
  const customProviders: CustomAiConfig[] = [];
  for (const item of rawProviders) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !/^custom-[\w-]{1,80}$/.test(item.id) || ids.has(item.id)) continue;
    ids.add(item.id);
    const models = [...new Set<string>((Array.isArray(item.models) ? item.models : []).map((m: unknown) => str(m, '')).filter(Boolean))];
    customProviders.push({
      id: item.id, name: str(item.name, '自定义服务'),
      baseUrl: typeof item.baseUrl === 'string' ? item.baseUrl.trim().slice(0, 2048) : '',
      models, model: models.includes(item.model) ? item.model : models[0] ?? '',
      ...(item.modelTuning && typeof item.modelTuning === 'object' ? { modelTuning: Object.fromEntries(models.filter(m => Object.hasOwn(item.modelTuning, m)).map(m => [m, sanitizeTuning(item.modelTuning[m])])) } : {}),
    });
  }
  const customProviderId = ids.has(o.customProviderId) ? o.customProviderId : customProviders[0]?.id ?? null;
  return {
    enabled: bool(o.enabled, d.enabled),
    provider: KINDS.includes(o.provider) ? o.provider : null,
    remember: bool(o.remember, d.remember),
    deepseek: { model: str(ds.model, d.deepseek.model), thinking: bool(ds.thinking, d.deepseek.thinking), ...(ds.tuning ? { tuning: sanitizeTuning(ds.tuning) } : {}) },
    bailian: {
      model: str(bl.model, d.bailian.model),
      region: bl.region === 'intl' ? 'intl' : 'cn',
      thinking: bool(bl.thinking, d.bailian.thinking),
      ...(bl.tuning ? { tuning: sanitizeTuning(bl.tuning) } : {}),
    },
    customProviders, customProviderId,
  };
}

function sanitizeSecrets(v: unknown, configs: CustomAiConfig[]): AiSecrets {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, any>;
  const out: AiSecrets = {};
  if (typeof o.deepseek === 'string' && o.deepseek) out.deepseek = o.deepseek;
  if (typeof o.bailian === 'string' && o.bailian) out.bailian = o.bailian;
  const keys = o.customProviders && typeof o.customProviders === 'object' ? o.customProviders : {};
  const paired = configs.flatMap(p => {
    const key = keys[p.id] ?? (p.id === 'custom-legacy' ? o.custom : undefined);
    return typeof key === 'string' && key ? [[p.id, key]] : [];
  });
  if (paired.length) out.customProviders = Object.fromEntries(paired);
  if (o.official && typeof o.official.token === 'string' && o.official.token) {
    out.official = { token: o.official.token, account: typeof o.official.account === 'string' ? o.official.account : undefined };
  }
  return out;
}

let settings: AiSettings | null = null;
let secrets: AiSecrets | null = null;
const subs = new Set<() => void>();
let version = 0;
const emit = () => {
  version++;
  for (const f of subs) f();
  notifyAiChanged();
};

function load() {
  if (settings && secrets) return;
  const stored = readJson(SETTINGS_KEY) as Record<string, unknown> | null;
  settings = sanitizeSettings(stored);
  secrets = settings.remember ? sanitizeSecrets(readJson(SECRETS_KEY), settings.customProviders) : {};
  if (stored?.custom && !Array.isArray(stored.customProviders)) {
    writeJson(SETTINGS_KEY, settings);
    writeJson(SECRETS_KEY, settings.remember && hasAny(secrets) ? secrets : null);
  }
  setAiOn(settings.enabled);
}

export function getAiSettings(): AiSettings {
  load();
  return settings!;
}

export function updateAiSettings(patch: Partial<Omit<AiSettings, 'deepseek' | 'bailian'>> & {
  deepseek?: Partial<AiSettings['deepseek']>;
  bailian?: Partial<AiSettings['bailian']>;
}): void {
  const cur = getAiSettings();
  settings = sanitizeSettings({
    ...cur,
    ...patch,
    deepseek: { ...cur.deepseek, ...patch.deepseek },
    bailian: { ...cur.bailian, ...patch.bailian },
  });
  writeJson(SETTINGS_KEY, settings);
  setAiOn(settings.enabled);
  if (patch.customProviders) secrets = sanitizeSecrets(secrets, settings.customProviders);
  if (patch.remember !== undefined || patch.customProviders) writeJson(SECRETS_KEY, settings.remember && hasAny(secrets!) ? secrets : null);
  emit();
}

const hasAny = (s: AiSecrets) => !!(s.deepseek || s.bailian || (s.customProviders && Object.keys(s.customProviders).length) || s.official);

export function getSecrets(): Readonly<AiSecrets> {
  load();
  return secrets!;
}

/** Current custom service and its separately stored credential. */
export function getCustomProvider(): CustomAiConfig | undefined {
  const s = getAiSettings();
  return s.customProviders.find(p => p.id === s.customProviderId);
}
export const getCustomSecret = (id: string): string => getSecrets().customProviders?.[id] ?? '';

export function addCustomProvider(): string {
  const id = `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const configs = getAiSettings().customProviders;
  let n = 1;
  while (configs.some(p => p.name === `服务商 ${n}`)) n++;
  updateAiSettings({ customProviders: [...configs, { id, name: `服务商 ${n}`, baseUrl: '', models: [], model: '' }], customProviderId: id });
  return id;
}
export function updateCustomProvider(id: string, patch: Partial<Omit<CustomAiConfig, 'id'>>): void {
  updateAiSettings({ customProviders: getAiSettings().customProviders.map(p => p.id === id ? { ...p, ...patch } : p) });
}
export function removeCustomProvider(id: string): void {
  updateAiSettings({ customProviders: getAiSettings().customProviders.filter(p => p.id !== id) });
}
export function setCustomSecret(id: string, value: string): void {
  if (!getAiSettings().customProviders.some(p => p.id === id)) return;
  const keys = { ...getSecrets().customProviders };
  const key = cleanKey(value);
  if (key) keys[id] = key; else delete keys[id];
  setSecret('customProviders', Object.keys(keys).length ? keys : undefined);
}

/** 粘贴进来的密钥去掉空白和误带的 "Bearer " */
export function cleanKey(k: string): string {
  return k.replace(/^\s*bearer\s+/i, '').replace(/\s+/g, '');
}

export function setSecret<K extends keyof AiSecrets>(slot: K, value: AiSecrets[K] | undefined): void {
  load();
  const next = { ...secrets! };
  if (value === undefined || value === '') delete next[slot];
  else next[slot] = value;
  secrets = next;
  writeJson(SECRETS_KEY, settings!.remember && hasAny(next) ? next : null);
  emit();
}

/** 选用哪家(设置面板的单选);立刻生效 */
export function chooseProvider(kind: AiProviderKind | null): void {
  updateAiSettings({ provider: kind });
  setActiveProvider(kind);
}

/** 「使用 AI 功能」开 / 关 */
export function setAiEnabled(on: boolean): void {
  updateAiSettings({ enabled: on });
}

/** React:设置或密钥变了就重渲染 */
export function useAiSettingsVersion(): number {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => version,
    () => version,
  );
}

/** 单测用:忘掉内存里的,下次从存储重读 */
export function resetAiSettingsForTest(): void {
  settings = null;
  secrets = null;
}

/** 把一段文字里出现的密钥遮掉(服务商的报错偶尔会原样带回密钥) */
export function scrubSecrets(text: string): string {
  let out = text;
  const s = secrets ?? {};
  for (const k of [s.deepseek, s.bailian, s.official?.token]) {
    if (k && k.length >= 6) out = out.split(k).join('***');
  }
  for (const k of Object.values(s.customProviders ?? {})) {
    if (k) out = out.split(k).join('***');
  }
  return out.replace(/\bsk-[A-Za-z0-9_-]{6,}/g, 'sk-***');
}
