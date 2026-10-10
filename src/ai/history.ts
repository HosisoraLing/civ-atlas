/**
 * AI 写史书(阶段 5):按选项整理材料(prompts/history.ts)→ 经 aiChat 一章一章地写 → 存进本地的 AI 笔记
 * (library.ts,kind = "史书",按世界存)。界面(ui/HistoryBook.tsx)只管显示和按钮;这里不碰 DOM,单测用假 AI 跑完整流程。
 *
 * - 同一个"写什么 + 文体 + 篇幅"= 同一部史书(笔记的键见 historyNoteKey):重写就覆盖,写完才存,停下 / 出错不动旧的
 * - 笔记里除了正文,还记着 book(HistoryBookMeta):写什么(国家按稳定键记)、文体、篇幅、书名、历史指纹……
 *   (AiNote 的扩展字段;library.ts 原样存取整个对象)
 * - 历史指纹对不上(改名 / 干预 / 改地形重推之后)= 旧史书"写于历史改变之前,可能对不上"
 */
import type { Civ } from '../gen/civ/types';
import { aiChat } from './client';
import { AiError, type AiProviderKind } from './types';
import { listNotes, putNote, type AiNote } from './library';
import {
  HISTORY_LENGTHS,
  HISTORY_STYLES,
  buildHistoryPrompts,
  historyFingerprint,
  historyMessages,
  historyNoteKey,
  loadScope,
  storeScope,
  type HistoryLength,
  type HistoryOptions,
  type HistoryScope,
  type HistoryStyle,
  type StoredScope,
} from './prompts/history';

export const HISTORY_KIND = '史书';

/** 一部史书的"书目信息"(存在笔记的 book 字段里) */
export interface HistoryBookMeta {
  /** 书名:"世界通史" / "大昌史" / "第 1200—1500 年史" */
  title: string;
  /** "第 0—3000 年" */
  range: string;
  scope: StoredScope;
  style: HistoryStyle;
  length: HistoryLength;
  /** 写的时候的历史指纹 */
  fp: string;
  /** 世界种子(导出时写进说明) */
  seed: number;
  /** 分几次写的 */
  calls: number;
}

export interface HistoryNote extends AiNote {
  book: HistoryBookMeta;
}

const STYLES = Object.keys(HISTORY_STYLES);
const LENGTHS = Object.keys(HISTORY_LENGTHS);

function validScope(s: unknown): s is StoredScope {
  const x = s as StoredScope | null;
  if (!x || typeof x !== 'object') return false;
  if (x.kind === 'world') return true;
  if (x.kind === 'polity') return typeof x.key === 'string' && typeof x.name === 'string';
  if (x.kind === 'era') return Number.isFinite(x.from) && Number.isFinite(x.to);
  return false;
}

/** 笔记 → 史书(不是史书、字段坏了 = null) */
export function asHistoryNote(n: AiNote | undefined | null): HistoryNote | null {
  if (!n || n.kind !== HISTORY_KIND) return null;
  const b = (n as Partial<HistoryNote>).book;
  if (!b || typeof b !== 'object' || typeof b.title !== 'string' || typeof b.fp !== 'string') return null;
  if (!STYLES.includes(b.style) || !LENGTHS.includes(b.length) || !validScope(b.scope)) return null;
  return n as HistoryNote;
}

/** 这个世界写过的史书(新写的在前) */
export function listHistoryNotes(world: string): HistoryNote[] {
  return listNotes(world, HISTORY_KIND)
    .map(asHistoryNote)
    .filter((n): n is HistoryNote => !!n)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

/** 一部史书在现在的历史里:还能不能按原来的选项重写(scope)、是不是写于历史改变之前(stale) */
export function historyNoteStatus(civ: Civ, note: HistoryNote): { scope: HistoryScope | null; stale: boolean; why?: string } {
  const scope = loadScope(civ, note.book.scope);
  if (!scope) return { scope: null, stale: true, why: `现在的历史里没有${note.book.scope.kind === 'polity' ? note.book.scope.name || '这个国家' : '这一段'}了` };
  const stale = historyFingerprint(civ, scope) !== note.book.fp;
  return { scope, stale };
}

/** 界面上的文体名:成书的三种叫"纪传体 / 编年体 / 白话通俗";旧版写史书面板的"史书体""传说故事"照旧 */
export function historyStyleLabel(style: HistoryStyle): string {
  return style === 'plain' ? '白话通俗' : HISTORY_STYLES[style].label;
}

/** 笔记列表里的标题:"世界通史 · 纪传体 · 中篇" */
export function historyNoteTitle(title: string, style: HistoryStyle, length: HistoryLength): string {
  return `${title} · ${historyStyleLabel(style)} · ${HISTORY_LENGTHS[length].label}篇`;
}

export interface WriteProgress {
  /** 到目前为止的全文(Markdown) */
  text: string;
  /** 正在写第几次调用(0 起)/ 一共几次 */
  call: number;
  calls: number;
}

export interface WriteHistoryOptions {
  /** 存到哪个世界(saveStore 的世界编号) */
  world: string;
  signal?: AbortSignal;
  onProgress?: (p: WriteProgress) => void;
  /** 写完存笔记用的时间(测试用);不给 = 现在 */
  now?: () => Date;
}

/**
 * 写一部史书:一次(短、中篇)或一章一次(长篇)地调 AI,边写边回调 onProgress;写完存进本地笔记并返回。
 * 没设置 AI / 失败 / 取消都抛 AiError(取消 = code 'aborted');这时不存,旧的那部(同一个键)不动
 */
export async function writeHistory(civ: Civ, opts: HistoryOptions, o: WriteHistoryOptions): Promise<HistoryNote> {
  const prompts = buildHistoryPrompts(civ, opts);
  if (prompts.empty || !prompts.calls.length) throw new AiError('other', '这段历史里没有史事可写');
  const n = prompts.calls.length;
  let done = '';
  let provider: AiProviderKind | '' = '';
  let model = '';
  for (let i = 0; i < n; i++) {
    if (o.signal?.aborted) throw new AiError('aborted', '已取消');
    const c = prompts.calls[i];
    const prefix = done ? `${done}\n\n` : '';
    o.onProgress?.({ text: done, call: i, calls: n });
    const r = await aiChat(
      { feature: HISTORY_KIND, title: c.title, messages: historyMessages(prompts, i, done), temperature: c.temperature, maxTokens: c.maxTokens },
      { signal: o.signal, onDelta: (_, full) => o.onProgress?.({ text: prefix + full, call: i, calls: n }) },
    );
    done = prefix + r.text.trim();
    provider = r.provider;
    model = r.model;
  }
  o.onProgress?.({ text: done, call: n - 1, calls: n });
  const stored = storeScope(civ, opts.scope);
  const note: HistoryNote = {
    key: historyNoteKey(stored, opts.style, opts.length),
    kind: HISTORY_KIND,
    title: historyNoteTitle(prompts.title, opts.style, opts.length),
    text: done,
    createdAt: (o.now?.() ?? new Date()).toISOString(),
    provider,
    model,
    book: {
      title: prompts.title,
      range: prompts.range,
      scope: stored,
      style: opts.style,
      length: opts.length,
      fp: prompts.fingerprint,
      seed: civ.seed,
      calls: n,
    },
  };
  putNote(o.world, note);
  return note;
}

/** 日期:"9 月 28 日 14:02" */
export function shortDate(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const PROVIDER_NAME: Record<string, string> = { official: '我们的 AI', deepseek: 'DeepSeek', bailian: '阿里云百炼', custom: '自定义服务', mock: '测试用假 AI' };

/** 谁写的:"DeepSeek · deepseek-chat"(导出的文件里这样写;阅读页那行小字传 sep = "，") */
export function historyWriter(note: AiNote, sep = ' · '): string {
  const who = PROVIDER_NAME[note.provider] ?? note.provider;
  return [who, note.model && note.model !== note.provider ? note.model : ''].filter(Boolean).join(sep);
}

/** 导出 Markdown:书名 + 一段说明(种子、年份、文体、谁写的)+ 正文。title:界面上显示的书名(世界起了名字时是"某某通史"),不给 = 存的书名 */
export function historyMarkdown(note: HistoryNote, title = note.book.title): string {
  const b = note.book;
  const meta = [
    `「文明与地图」种子 ${b.seed} · ${b.range}`,
    `${historyStyleLabel(b.style)} · ${HISTORY_LENGTHS[b.length].label}篇`,
    `AI 写作(${historyWriter(note)})`,
    note.createdAt.slice(0, 10),
  ].join(' · ');
  return [`# ${title}`, '', `> ${meta}  `, '> 年份、国名、胜负存亡以推演出来的编年史为准;人物、对话等细节由 AI 补写。', '', note.text.trim(), ''].join('\n');
}

/** 导出的文件名:"世界通史-史书体-种子7.md"(去掉文件名里不能用的字符) */
export function historyFileName(note: HistoryNote, title = note.book.title): string {
  const b = note.book;
  const base = `${title}-${historyStyleLabel(b.style)}-种子${b.seed}`.replace(/[\\/:*?"<>|\s]+/g, '');
  return `${base}.md`;
}
