import { dataStorage } from "../account/wikiStorage";
import { worldDataChanged } from "./saveStore";
/**
 * 助手面板的状态:作者问一句或说想怎么改 → 助手自己查资料、在后台试推演、看了结果再调 → 回话,要改世界的列成确认单,
 * 作者点了执行才改。纯状态,不碰 DOM(单测里用假 AI 跑完整流程)。循环、工具、提示词在 ai/agent/,面板在 Assistant.tsx。
 *
 *   sendAsk(ctx, text)       发一句话:按现在的世界跑一次助手(每一步、说到一半的话都实时更新到这一轮)
 *   stopAsk()                停下正在做的那一轮(已经做完的步骤留着)
 *   toggleItem(turn, i)      确认单上勾 / 不勾第 i 条
 *   applyProposal(turn, now) 执行勾着的几条:一次合进修改(App 在后台重推,推完提示条"已按你说的改写"带撤销)。
 *                            发出去之后世界没再改过、现在也没在重推、世界的阶段(新建 / 建好)没变才能执行
 *   undoProposal(turn)       撤销执行过的那一轮(只拿掉这一轮加的修改)
 *   redoProposal(turn)       撤销过的那一轮再做一遍(⇧⌘Z;执行和撤销都记进修改的撤销记录,见 editsStore.ts、undo.ts)
 *   dismissProposal(turn)    不要这份确认单
 *   previewProposal(turn)    先在地图上看看:地图、左边卡片、时间轴换成试推演的历史(App 读 preview);再点一下回到现在
 *   pickName(turn, i)        起名的候选里挑一个改名
 *   newConversation()        清掉这个世界的对话
 *
 * 对话按世界存在浏览器里(换世界就换成那个世界的对话);试推演出来的历史只在内存里,
 * 刷新以后点"先在地图上看看"再推一遍。试推演由 App 交给 worker(setTrialRunner)。
 * 网址带 ai=mock 时用 assistant.ts 的假 AI 按固定步骤走(冒烟检查、截图用)。
 */
import { useSyncExternalStore } from 'react';
import type { World } from '../gen/world';
import type { Raster } from '../gen/raster';
import type { Civ } from '../gen/civ/types';
import { GENERATOR_VERSION, applyNames, resolveKey, type Intervention, type ResolvedKey, type WorldEdits } from '../gen/edits';
import { aiChat, getActiveProvider, setFeatureMock } from '../ai/client';
import { AiError, type AiErrorCode } from '../ai/types';
import {
  ASSISTANT_FEATURE,
  mockAssistant,
  polityOf,
  runAssistant,
  trialView,
  type AssistantContext,
  type AssistantProposal,
  type AssistantTurn,
  type TrialView,
} from '../ai/agent/assistant';
import type { AgentStep, AgentTool } from '../ai/agent/loop';
import { cleanWish, mergeRewrite, nameAt, unmergeRewrite, type RewriteChange, type RewriteItem, type RewriteLock } from '../ai/prompts/rewrite';
import {
  defaultName,
  isMockReply,
  mockSuggestions,
  nameInfo,
  nameMaterial,
  parseSuggestions,
  suggestRequest,
  suggestionEdit,
  takenNames,
  type NameTarget,
} from '../ai/prompts/names';
import { HISTORY_STYLES, type HistoryLength, type HistoryScope, type HistoryStyle } from '../ai/prompts/history';
import { getBook, startBook } from './bookStore';
import { commitEdits, getEdits, revertEdits, setName, subscribeEdits } from './editsStore';
import { currentWorld } from './saveStore';
import { setCivTime, setSelection, type MapSelection } from './civView';
import { requestFly } from './panelStore';
import { showToast } from './toastStore';
import { noteRewrite } from './rewriteStore';

// ---------------------------------------------------------------------------
// 状态

/** 一步(界面上一行) */
export interface AsStep {
  id: string;
  tool: string;
  label: string;
  /** 下面的小字 */
  summary?: string;
  state: 'run' | 'ok' | 'error';
  /** 写史书这一步:开始写的那一部(进度看 bookStore 里同一个 id 的那部) */
  book?: { id: number; key: string; title: string };
}

/** 起名的一个候选:改名表里写什么(value = null 即恢复生成时的名字) */
export interface AsCand {
  name: string;
  meaning: string;
  latin?: string;
  key: string;
  value: string | null;
  /** 生成时的名字(挑回它时照样记成 AI 起的;旧对话里没有) */
  fallback?: string;
}

export interface AsNames {
  /** 给谁起的:"利松德" */
  shown: string;
  list: AsCand[];
  /** 挑了哪一个 */
  used?: string;
}

/** 确认单 */
export interface AsProposal {
  items: RewriteItem[];
  cannot: string[];
  /** 试推演的结果(按全部能执行的几条算的;有地形修改、不能试推演时没有) */
  trial?: TrialView;
}

/** 执行过的一轮:执行前后的修改;undone = 又撤销了 */
export interface Applied {
  before: WorldEdits;
  after: WorldEdits;
  undone?: boolean;
}

export interface AsTurn {
  id: number;
  ask: string;
  /** 发出去时时间轴的年份 */
  year: number;
  /** 发出去时的修改(执行前核对世界没变) */
  basis: WorldEdits;
  /** 发出去时世界的阶段(新建中 = history:只能改地形) */
  lock?: RewriteLock;
  status: 'working' | 'done' | 'error';
  steps: AsStep[];
  /** 回给作者的话(做的时候是这一轮模型正在说的) */
  text: string;
  reasoning?: { round: number; text: string }[];
  proposal?: AsProposal;
  /** 没勾的几条(下标) */
  off?: number[];
  dismissed?: boolean;
  /** 执行过:执行前后的修改;undone = 又撤销了 */
  applied?: Applied;
  names?: AsNames;
  error?: { code: AiErrorCode; message: string };
}

export interface AssistantState {
  /** 对话属于哪个世界(saveStore 的世界编号) */
  world: string | null;
  /** 世界现在的阶段(见 RewriteLock) */
  lock?: RewriteLock;
  turns: AsTurn[];
  /** 正在地图上看哪一轮的试推演:raw = 试推演的历史(还在推 = null),names = 套哪份改名 */
  preview: { turn: number; raw: Civ | null; names: Record<string, string> } | null;
}

let state: AssistantState = { world: null, turns: [], preview: null };
const subs = new Set<() => void>();
function set(next: AssistantState) {
  state = next;
  subs.forEach((f) => f());
}
const patch = (id: number, p: Partial<AsTurn> | ((t: AsTurn) => Partial<AsTurn>)) =>
  set({ ...state, turns: state.turns.map((t) => (t.id === id ? { ...t, ...(typeof p === 'function' ? p(t) : p) } : t)) });
const subscribe = (f: () => void) => {
  subs.add(f);
  return () => subs.delete(f);
};
const get = () => state;

export function getAssistant(): AssistantState {
  return state;
}
export function useAssistant(): AssistantState {
  return useSyncExternalStore(subscribe, get, get);
}
const getPreview = () => state.preview;
/** 只看"在地图上看哪一轮"(App 用:对话一字一字更新时不跟着重画整个页面) */
export function useAssistantPreview(): AssistantState['preview'] {
  return useSyncExternalStore(subscribe, getPreview, getPreview);
}

// ---------------------------------------------------------------------------
// 存进浏览器(一个世界一份)

const KEY = (w: string) => `wenming-ditu:assistant:${w}`;
/** 最多存几轮 */
const KEEP = 30;

interface Saved {
  gen: number;
  turns: AsTurn[];
}

function load(w: string): AsTurn[] {
  try {
    const raw = dataStorage()!.getItem(KEY(w));
    if (!raw) return [];
    const v = JSON.parse(raw) as Saved;
    // 生成算法换过:同一个种子的历史不一样了,原来的确认单、结果对不上
    if (!v || v.gen !== GENERATOR_VERSION || !Array.isArray(v.turns)) return [];
    return v.turns;
  } catch {
    return [];
  }
}

function save() {
  const w = state.world;
  if (!w) return;
  try {
    const turns = state.turns.filter((t) => t.status !== 'working').slice(-KEEP);
    if (turns.length) dataStorage()!.setItem(KEY(w), JSON.stringify({ gen: GENERATOR_VERSION, turns } satisfies Saved));
    else dataStorage()!.removeItem(KEY(w));
    worldDataChanged(w);
  } catch {
    /* 存不下 / 隐私模式:只管这一次 */
  }
}

/** 换了世界:换成那个世界的对话;同一个世界换了阶段(点了"创建世界"):只记下新的阶段 */
export function syncAssistantWorld(lock?: RewriteLock) {
  const w = currentWorld()?.id ?? null;
  if (w === state.world) {
    if (lock !== state.lock) set({ ...state, lock });
    return;
  }
  stopAsk();
  trialRaw.clear();
  cleared.clear();
  const turns = w ? load(w) : [];
  seq = Math.max(seq, ...turns.map((t) => t.id));
  set({ world: w, lock, turns, preview: null });
}

/**
 * 新对话清掉的轮里执行过的那些(轮的编号 → 执行前后的修改):提示条上的"撤销"、⌘Z / ⇧⌘Z 照样撤得了、再做得了。
 * 只在这次打开网页里留着(修改的撤销记录也只记这次的),换世界清掉
 */
const cleared = new Map<number, { applied: Applied; lock?: RewriteLock }>();

/** 新对话:清掉这个世界的对话 */
export function newConversation() {
  stopAsk();
  trialRaw.clear();
  for (const t of state.turns) if (t.applied) cleared.set(t.id, { applied: t.applied, lock: t.lock });
  set({ ...state, turns: [], preview: null });
  save();
}

// ---------------------------------------------------------------------------
// 试推演(App 交给 worker)

/** 按这些干预把历史重推一遍(不动作者的世界);返回没套改名的历史,州和宜居度和现在这份共用 */
export type TrialRunner = (interventions: Intervention[], signal?: AbortSignal) => Promise<Civ>;
let runner: TrialRunner | null = null;
export function setTrialRunner(f: TrialRunner | null) {
  runner = f;
}

/** 试推演出来的历史(套了改名的 → 没套的),确认单附带的那一次留下来给"先在地图上看看" */
const rawOf = new WeakMap<Civ, Civ>();
const trialRaw = new Map<number, { sig: string; raw: Civ }>();

/** 两份修改是不是一样(作者标记、作者的人物不算:它们不改变世界,之后加了、改了,列好的修改照样能执行) */
const sameEdits = (a: WorldEdits, b: WorldEdits) =>
  a === b || JSON.stringify({ ...a, marks: undefined, characters: undefined }) === JSON.stringify({ ...b, marks: undefined, characters: undefined });
const ivSig = (l: readonly Intervention[]) => JSON.stringify(l);

// ---------------------------------------------------------------------------
// 一次对话

export interface AskContext {
  world: World;
  raster?: Raster | null;
  /** 套上了改名的这份历史 */
  civ: Civ;
  /** 没套改名的(起名时算"恢复默认") */
  raw: Civ;
  /** 时间轴的年份 */
  year: number;
  /** 世界的阶段:建好了(terrain:地形锁住)/ 新建中(history:只能改地形) */
  lock?: RewriteLock;
}

let seq = 0;
let ctrl: AbortController | null = null;
let running = -1;

/** 前几轮(给 AI 看前情) */
function history(): AssistantTurn[] {
  return state.turns
    .filter((t) => t.status === 'done')
    .map((t) => {
      const applied = !!t.applied && !t.applied.undone;
      const off = new Set(t.off ?? []);
      return {
        ask: t.ask,
        reply: t.text,
        items: t.proposal?.items.flatMap((x, i) =>
          x.change ? [`${x.year !== undefined ? `第 ${x.year} 年起 ` : ''}${x.text}${applied && off.has(i) ? '(作者没勾,没执行)' : ''}`] : [],
        ),
        applied,
      };
    });
}

const errOf = (e: unknown): AiError => (e instanceof AiError ? e : new AiError('other', `出错了:${e instanceof Error ? e.message : String(e)}`));

/** 发一句话;返回这一轮的编号(空话 = −1) */
export async function sendAsk(ctx: AskContext, text: string): Promise<number> {
  const w = cleanWish(text);
  if (!w) return -1;
  syncAssistantWorld(ctx.lock);
  stopAsk();
  exitPreview();
  const id = ++seq;
  const year = Math.floor(ctx.year);
  const basis = getEdits();
  const prev = history();
  set({ ...state, turns: [...state.turns, { id, ask: w, year, basis, lock: ctx.lock, status: 'working', steps: [], text: '' }] });
  const c = new AbortController();
  ctrl = c;
  running = id;
  const simulate = runner
    ? async (edits: WorldEdits, signal?: AbortSignal) => {
        const raw = await runner!(edits.interventions as Intervention[], signal);
        const named = applyNames(raw, edits.names);
        rawOf.set(named, raw);
        return named;
      }
    : undefined;
  const actx: AssistantContext = { world: ctx.world, civ: ctx.civ, year, edits: basis, lock: ctx.lock, simulate };
  const ui = { book: null as AsStep['book'] | null };
  const extraTools = ctx.lock === 'history' ? [] : uiTools(ctx, id, ui);
  const mock = getActiveProvider() === 'mock';
  if (mock) setFeatureMock(ASSISTANT_FEATURE, mockAssistant(actx));
  const live = (f: (t: AsTurn) => Partial<AsTurn>) => {
    if (running === id) patch(id, f);
  };
  const stepOf = (s: AgentStep, book?: AsStep['book'] | null): AsStep => ({
    id: s.id,
    tool: s.tool,
    // 写史书开写了:这一行换成书名
    label: book ? `写史书：《${book.title}》` : s.label,
    state: s.state,
    ...(s.summary ? { summary: s.summary } : s.state === 'error' && s.result ? { summary: s.result.replace(/^出错了:/, '') } : {}),
    ...(book ? { book } : {}),
  });
  /** 交上来的确认单(之后出错、停下也留着,见 catch) */
  let got: AssistantProposal | null = null;
  const done = (p: AssistantProposal | null, text: string) => {
    if (p?.trial) {
      const raw = rawOf.get(p.trial.civ);
      if (raw) trialRaw.set(id, { sig: ivSig(p.trial.edits.interventions), raw });
    }
    live(() => ({
      status: 'done',
      text,
      ...(p ? { proposal: { items: p.items, cannot: p.cannot, ...(p.trial ? { trial: trialView(p.trial.diff) } : {}) } } : {}),
    }));
  };
  try {
    const r = await runAssistant(actx, prev, w, {
      signal: c.signal,
      extraTools,
      onProposal: (p) => (got = p),
      onEvent: (e) => {
        if (e.type === 'round') live(() => ({ text: '' }));
        else if (e.type === 'reasoning') live(t => ({ reasoning: [...(t.reasoning ?? []).filter(r => r.round !== e.round), { round: e.round, text: e.text }] }));
        else if (e.type === 'text') live(() => ({ text: e.text }));
        else if (e.type === 'step') live((t) => ({ steps: [...t.steps, stepOf(e.step)] }));
        else if (e.type === 'step-done') {
          const book = e.step.tool === 'write_book' && e.step.state === 'ok' ? ui.book : null;
          if (book) ui.book = null;
          live((t) => ({ steps: t.steps.map((s) => (s.id === e.step.id ? stepOf(e.step, book) : s)) }));
        }
      },
    });
    if (c.signal.aborted) throw new AiError('aborted', '已停下');
    done(r.proposal, r.text);
  } catch (e) {
    const err = errOf(e);
    // 确认单已经列好(最后那句话没说完就出错、停下了):留下确认单,照样能先看、执行
    if (got && running === id) {
      done(got, state.turns.find((t) => t.id === id)?.text ?? '');
      patch(id, (t) => ({ steps: t.steps.map((s) => (s.state === 'run' ? { ...s, state: 'error' as const } : s)) }));
    } else if (state.turns.some((t) => t.id === id))
      patch(id, (t) => ({
        status: 'error',
        error: { code: err.code, message: err.code === 'aborted' ? '已停下' : err.message },
        // 停下时正在做的那一步算没做成
        steps: t.steps.map((s) => (s.state === 'run' ? { ...s, state: 'error' as const } : s)),
      }));
  } finally {
    if (mock) setFeatureMock(ASSISTANT_FEATURE, null);
    if (running === id) {
      running = -1;
      ctrl = null;
    }
    save();
  }
  return id;
}

/** 停下正在做的那一轮 */
export function stopAsk() {
  ctrl?.abort();
}

// ---------------------------------------------------------------------------
// 要碰界面的工具:在地图上打开、写史书、起名(新建中不给)

/** "P3" / "C12" / "R45" / "E2" / "M7" / 国名 / 城名 → 起名、打开的对象 */
export function targetOf(civ: Civ, v: unknown): NameTarget | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).trim();
  const m = /^([PCREMpcrem])(\d{1,6})$/.exec(s);
  if (m) {
    const id = Number(m[2]);
    const k = m[1].toUpperCase();
    if (k === 'P') return id < civ.polities.length ? { kind: 'polity', id } : null;
    if (k === 'C') return id < civ.settlements.length ? { kind: 'settlement', id } : null;
    if (k === 'R') return id < civ.regions.count ? { kind: 'region', id } : null;
    if (k === 'E') return id < civ.cultures.length ? { kind: 'culture', id } : null;
    return id < civ.places.length ? { kind: 'place', id } : null;
  }
  const p = polityOf(civ, s);
  if (p >= 0) return { kind: 'polity', id: p };
  const c = civ.settlements.find((x) => x.name === s);
  if (c) return { kind: 'settlement', id: c.id };
  const pl = civ.places.findIndex((x) => x.name === s);
  return pl >= 0 ? { kind: 'place', id: pl } : null;
}

/** 对象的名字(步骤的一行用) */
function targetName(civ: Civ, t: NameTarget, year: number): string {
  if (t.kind === 'polity') return nameAt(civ.polities[t.id], year);
  return nameInfo(civ, t)?.shown ?? '';
}

/** 篇幅的说法:"约一万字" */
function charsWords(n: number): string {
  const W: Record<number, string> = { 3000: '约三千字', 10000: '约一万字', 30000: '约三万字' };
  return W[n] ?? `约 ${n} 字`;
}

/** 起名语感的短说法:"帝国(拉丁风)" → "拉丁风" */
const styleShort = (label: string) => /[((]([^))]+)[))]/.exec(label)?.[1] ?? label;

function uiTools(ctx: AskContext, turn: number, ui: { book: AsStep['book'] | null }): AgentTool[] {
  const { civ } = ctx;
  const end = Math.floor(civ.endYear);
  const year = Math.floor(ctx.year);

  const show: AgentTool = {
    def: {
      name: 'show',
      description: '在地图上打开一个国家、城或山河湖海:选中它,地图飞过去,作者旁边就能看到它的详情。回答问题时说到主角就打开它(一次对话一两次就够)。year 给了就把时间轴拨到那一年。',
      parameters: {
        type: 'object',
        properties: { target: { type: 'string', description: '编号:P3(国家)、C12(城)、M7(山河湖海)、R45(州)' }, year: { type: 'integer' } },
        required: ['target'],
      },
    },
    label: (a) => {
      const t = targetOf(civ, a.target);
      return t && t.kind !== 'culture' ? `在地图上打开${targetName(civ, t, year)}` : '在地图上打开';
    },
    run: (a) => {
      const t = targetOf(civ, a.target);
      if (!t || t.kind === 'culture') throw new Error(`找不到「${String(a.target ?? '')}」,或者它不能在地图上打开;用 P / C / M / R 编号`);
      setSelection(t as MapSelection);
      requestFly('sel');
      const y = typeof a.year === 'number' && Number.isFinite(a.year) ? Math.max(0, Math.min(end, Math.floor(a.year))) : null;
      if (y !== null) setCivTime({ year: y, playing: false, scrubbing: false, story: false });
      const n = targetName(civ, t, y ?? year);
      return { result: `已在地图上打开 ${n}${y !== null ? `,时间轴拨到第 ${y} 年` : ''}。`, summary: `在地图上打开了${n}` };
    },
  };

  const writeBook: AgentTool = {
    def: {
      name: 'write_book',
      description:
        '把这个世界的历史写成一部史书:在后台写,写好放进「成书」,不用等它写完(同一时间只写一部)。' +
        'scope:world 整个世界 / country 一个国家(给 country)/ era 一段年份(给 from、to)。' +
        'style:biography 纪传体 / annals 编年体 / plain 白话讲述。length:k3 约三千字 / k10 约一万字 / k30 约三万字。',
      parameters: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['world', 'country', 'era'] },
          country: { type: 'string', description: '国家编号,如 P3' },
          from: { type: 'integer' },
          to: { type: 'integer' },
          style: { type: 'string', enum: ['biography', 'annals', 'plain'] },
          length: { type: 'string', enum: ['k3', 'k10', 'k30'] },
        },
        required: ['scope'],
      },
    },
    label: (a) => (a.scope === 'country' && polityOf(civ, a.country) >= 0 ? `写史书：${nameAt(civ.polities[polityOf(civ, a.country)], year)}` : '写史书'),
    run: (a) => {
      let scope: HistoryScope = { kind: 'world' };
      if (a.scope === 'country') {
        const id = polityOf(civ, a.country);
        if (id < 0) throw new Error(`找不到国家「${String(a.country ?? '')}」`);
        scope = { kind: 'polity', polity: id };
      } else if (a.scope === 'era') {
        const f = Math.max(0, Math.min(end, Math.floor(Number(a.from) || 0)));
        const t = Math.max(f, Math.min(end, Math.floor(Number(a.to) || end)));
        scope = { kind: 'era', from: f, to: t };
      }
      const style: HistoryStyle = a.style === 'annals' || a.style === 'plain' ? a.style : 'biography';
      const length: HistoryLength = a.length === 'k3' || a.length === 'k30' ? a.length : 'k10';
      const busy = getBook().job;
      if (busy?.status === 'writing') throw new Error(`已经在写《${busy.title}》了,同一时间只能写一部;等它写完再写`);
      if (!startBook({ scope, style, length })) throw new Error('没能开始写:还没有设置 AI,或者这段历史里没有史事');
      const j = getBook().job!;
      ui.book = { id: j.id, key: j.key, title: j.title };
      const how = `${HISTORY_STYLES[style].label}，${charsWords(j.chars)}${j.calls > 1 ? `，分 ${j.calls} 章` : ''}`;
      return { result: `开始写《${j.title}》(${how})。写好会放进「成书」,作者不用等;现在用一句话告诉作者。`, summary: how };
    },
  };

  const suggestNames: AgentTool = {
    def: {
      name: 'suggest_names',
      description: '给一个国家、城、州、民族或山河湖海起 5 个新名字,列给作者挑(作者点了才改名)。wish 写作者对名字的要求(比如"更有气势")。',
      parameters: {
        type: 'object',
        properties: { target: { type: 'string', description: '编号:P3、C12、R45、E2、M7' }, wish: { type: 'string' } },
        required: ['target'],
      },
    },
    label: (a) => {
      const t = targetOf(civ, a.target);
      return t ? `给${targetName(civ, t, year)}起名` : '起名';
    },
    run: async (a, signal) => {
      const t = targetOf(civ, a.target);
      const info = t ? nameInfo(civ, t) : null;
      const m = t ? nameMaterial(civ, t, ctx.raster) : null;
      if (!t || !info || !m) throw new Error(`找不到「${String(a.target ?? '')}」;用 P / C / R / E / M 编号`);
      const r = await aiChat(suggestRequest(m, typeof a.wish === 'string' ? a.wish : undefined), { signal });
      const p = isMockReply(r.text) ? { ok: true as const, list: mockSuggestions(civ, t, info), dropped: 0 } : parseSuggestions(r.text, info, takenNames(civ, t));
      if (!p.ok) throw new Error(p.message);
      const fallback = defaultName(ctx.raw, t, info);
      const list: AsCand[] = p.list.map((s) => ({ ...s, ...suggestionEdit(info, s.name, fallback), fallback }));
      patch(turn, { names: { shown: info.shown, list } });
      const style = info.style ? `按${styleShort(info.style.label)}` : '';
      return {
        result: `起了 ${list.length} 个,已列给作者挑(作者点了才改):\n${list.map((c) => `- ${c.name}${c.meaning ? `:${c.meaning}` : ''}`).join('\n')}\n现在用一句话告诉作者。`,
        summary: `${style}起了 ${list.length} 个`,
      };
    },
  };

  return [show, writeBook, suggestNames];
}

// ---------------------------------------------------------------------------
// 确认单

/** 勾 / 不勾第 i 条 */
export function toggleItem(id: number, i: number) {
  const t = state.turns.find((x) => x.id === id);
  if (!t || t.applied || t.dismissed || !t.proposal?.items[i]?.change) return;
  const off = new Set(t.off ?? []);
  if (off.has(i)) off.delete(i);
  else off.add(i);
  patch(id, { off: [...off] });
  // 正在地图上看这一轮:按新勾的几条重推
  if (state.preview?.turn === id) showPreview(id);
  save();
}

/** 这一轮勾着的修改 */
export function pickedChanges(t: AsTurn): RewriteChange[] {
  const off = new Set(t.off ?? []);
  return (t.proposal?.items ?? []).flatMap((x, i) => (x.change && !off.has(i) ? [x.change] : []));
}

/** 这一轮现在能不能执行;不能 = 原因(不用说原因 = 空串) */
export function applyBlock(t: AsTurn, now: { busy?: boolean }): string | null {
  if (t.status !== 'done' || !t.proposal || t.applied || t.dismissed) return '';
  if (t.lock !== state.lock) return t.lock === 'history' ? '世界已经建好了，新建时列的改地形不能再执行' : '世界的阶段变了，这份修改不能再执行';
  if (now.busy) return '世界正在重推，推完再执行';
  if (!sameEdits(getEdits(), t.basis)) return '世界在这之后改过，这份修改是按改之前列的；再说一遍，按现在的世界重想';
  if (!pickedChanges(t).length) return '没有勾选能执行的修改';
  return null;
}

/** 执行这一轮勾着的修改;返回原因(执行了 = null) */
export function applyProposal(id: number, now: { busy?: boolean }): string | null {
  const t = state.turns.find((x) => x.id === id);
  if (!t) return '找不到这一轮了';
  const why = applyBlock(t, now);
  if (why !== null) return why || '这一轮执行过了';
  const before = getEdits();
  const after = mergeRewrite(before, pickedChanges(t));
  if (after === before) return '这些修改都已经有了';
  exitPreview();
  patch(id, { applied: { before, after } });
  save();
  const undo = () => undoProposal(id);
  // 只改名:不用重推,当场说;有干预 / 改地形:App 推完再说(带撤销)
  // 执行和撤销都记进修改的撤销记录(⌘Z / ⇧⌘Z 经 undo.ts 回到这里的 undoProposal / redoProposal)
  if (after.interventions === before.interventions && after.terrain === before.terrain) {
    commitEdits(after, { id, kind: 'apply' });
    showToast({ id: 'resim-done', kind: 'ok', text: '已按你说的改名', action: { label: '撤销', act: 'rw-undo', onClick: undo } });
  } else {
    noteRewrite({ kind: 'apply', turn: id, before, after, edits: after, undo });
    commitEdits(after, { id, kind: 'apply' });
  }
  return null;
}

/** 执行过的这一轮:还在对话里的从对话里取、改了记进对话;新对话清掉了的从 cleared 取 */
function appliedOf(id: number): { applied?: Applied; lock?: RewriteLock; set: (a: Applied) => void } | null {
  const t = state.turns.find((x) => x.id === id);
  if (t)
    return {
      applied: t.applied,
      lock: t.lock,
      set: (a) => {
        patch(id, { applied: a });
        save();
      },
    };
  const c = cleared.get(id);
  return c ? { ...c, set: (a) => void (c.applied = a) } : null;
}

/** 撤销执行过的这一轮 */
export function undoProposal(id: number) {
  const x = appliedOf(id);
  const a = x?.applied;
  // 新建时执行的改地形:点了"创建世界"以后地形锁住,不能再撤销
  if (!x || !a || a.undone || x.lock !== state.lock) return;
  const now = getEdits();
  const next = unmergeRewrite(now, a.before, a.after);
  x.set({ ...a, undone: true });
  if (next === now) return;
  if (next.interventions === now.interventions && next.terrain === now.terrain) {
    commitEdits(next, { id, kind: 'undo' });
    showToast({ id: 'resim-done', kind: 'ok', text: '已撤销这次改写', ttl: 4000 });
  } else {
    noteRewrite({ kind: 'undo', turn: id, before: a.before, after: a.after, edits: next });
    commitEdits(next, { id, kind: 'undo' });
  }
}

/** 撤销过的这一轮再做一遍(⇧⌘Z;之后没再改过 = 正好回到执行后的样子,改过别的 = 只把这一轮的修改放回去) */
export function redoProposal(id: number) {
  const x = appliedOf(id);
  const a = x?.applied;
  if (!x || !a || !a.undone || x.lock !== state.lock) return;
  const now = getEdits();
  const next = revertEdits(now, a.before, a.after);
  x.set({ ...a, undone: false });
  if (next === now) return;
  const undo = () => undoProposal(id);
  if (next.interventions === now.interventions && next.terrain === now.terrain) {
    commitEdits(next, { id, kind: 'apply' });
    showToast({ id: 'resim-done', kind: 'ok', text: '已按你说的改名', action: { label: '撤销', act: 'rw-undo', onClick: undo } });
  } else {
    noteRewrite({ kind: 'apply', turn: id, before: a.before, after: a.after, edits: next, undo });
    commitEdits(next, { id, kind: 'apply' });
  }
}

/** 不要这份确认单 */
export function dismissProposal(id: number) {
  if (state.preview?.turn === id) exitPreview();
  patch(id, { dismissed: true });
  save();
}

// ---------------------------------------------------------------------------
// 先在地图上看看

/** 这份确认单能不能先在地图上看:有历史命令、没有改地形(改地形整个世界要重新生成) */
export function previewable(t: AsTurn): boolean {
  const cs = (t.proposal?.items ?? []).flatMap((x) => (x.change ? [x.change] : []));
  return cs.some((c) => c.kind === 'intervention') && !cs.some((c) => c.kind === 'terrain');
}

/** 现在能不能先在地图上看这一轮:不能 = 原因(不用说原因 = 空串) */
export function previewBlock(t: AsTurn, now: { busy?: boolean }): string | null {
  const why = applyBlock(t, now);
  if (why !== null) return why;
  const cs = pickedChanges(t);
  if (cs.some((c) => c.kind === 'terrain')) return '含改地形：整个世界要重新生成，不能先看';
  if (!cs.some((c) => c.kind === 'intervention')) return '勾着的只有改名，历史不会变';
  if (!runner) return '这里不能试推演';
  return null;
}

/** 先在地图上看看 / 再点一下回到现在;返回原因(看了 = null) */
export function previewProposal(id: number, now: { busy?: boolean }): string | null {
  if (state.preview?.turn === id) {
    exitPreview();
    return null;
  }
  const t = state.turns.find((x) => x.id === id);
  if (!t) return '找不到这一轮了';
  const why = previewBlock(t, now);
  if (why !== null) return why;
  showPreview(id);
  return null;
}

let previewCtrl: AbortController | null = null;

/** 地图换成这一轮勾着的几条的试推演(确认单附带的那一次就是这一批 = 直接用,否则在后台再推一遍) */
function showPreview(id: number) {
  const t = state.turns.find((x) => x.id === id);
  if (!t || !runner) return;
  previewCtrl?.abort();
  previewCtrl = null;
  const edits = mergeRewrite(t.basis, pickedChanges(t));
  const sig = ivSig(edits.interventions);
  const names = edits.names;
  const cached = trialRaw.get(id);
  if (cached && cached.sig === sig) {
    set({ ...state, preview: { turn: id, raw: cached.raw, names } });
    return;
  }
  set({ ...state, preview: { turn: id, raw: null, names } });
  const c = new AbortController();
  previewCtrl = c;
  runner(edits.interventions as Intervention[], c.signal).then(
    (raw) => {
      if (c.signal.aborted || state.preview?.turn !== id) return;
      trialRaw.set(id, { sig, raw });
      set({ ...state, preview: { turn: id, raw, names } });
    },
    () => {
      if (!c.signal.aborted && state.preview?.turn === id) set({ ...state, preview: null });
    },
  );
}

/**
 * 一个键在两份历史里是不是同一个东西(在地图上看试推演时改名、下令用):州、山河湖海两边一样;
 * 国家、城、民族、信仰要两边都有、而且立国 / 建城 / 出现 / 创立的年份一样(生效年份以前的历史一字不差,这样的就是同一个;民间信仰看它的民族)
 */
export function sameInBoth(a: Civ, b: Civ, key: string): boolean {
  const x = resolveKey(a, key);
  const y = resolveKey(b, key);
  if (!x || !y || x.kind !== y.kind) return false;
  if (x.kind === 'region' || x.kind === 'place') return true;
  const born = (c: Civ, r: ResolvedKey) => {
    if (r.kind === 'settlement') return c.settlements[r.id]?.founded;
    if (r.kind === 'culture') return c.cultures[r.id]?.born;
    if (r.kind === 'faith') {
      const f = c.religion?.faiths[r.id];
      return f && (f.kind === 'folk' ? c.cultures[f.culture ?? f.id]?.born : f.founded);
    }
    return c.polities[r.id]?.founded;
  };
  const ba = born(a, x);
  const bb = born(b, y);
  if (ba === undefined || bb === undefined || Math.floor(ba) !== Math.floor(bb)) return false;
  return x.kind !== 'dynasty' || (!!a.polities[x.id].dynasties?.[x.index!] && !!b.polities[y.id].dynasties?.[y.index!]);
}

/** 在地图上看试推演时,改的东西在现在的历史里不是同一个:这样说 */
export const PREVIEW_EDIT_BLOCK = '这是试推演里的样子，和现在的历史对不上；回到现在再改';

/** 回到现在 */
export function exitPreview() {
  previewCtrl?.abort();
  previewCtrl = null;
  if (state.preview) set({ ...state, preview: null });
}

// 修改变了(执行了、撤销了、别处改了):试推演是按原来的修改算的,不再看它
subscribeEdits(() => {
  const p = state.preview;
  if (!p) return;
  const t = state.turns.find((x) => x.id === p.turn);
  if (!t || !sameEdits(getEdits(), t.basis)) exitPreview();
});

// ---------------------------------------------------------------------------
// 起名

/** 起名的候选里挑一个改名 */
export function pickName(id: number, i: number) {
  const t = state.turns.find((x) => x.id === id);
  const c = t?.names?.list[i];
  if (!t || !c || state.lock === 'history') return;
  setName(c.key, c.value, 'ai', c.fallback);
  patch(id, { names: { ...t.names!, used: c.name } });
  save();
}

/** 单测用:清掉状态 */
export function _resetAssistant() {
  stopAsk();
  exitPreview();
  trialRaw.clear();
  runner = null;
  seq = 0;
  set({ world: null, turns: [], preview: null });
}
