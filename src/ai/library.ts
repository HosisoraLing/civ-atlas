import { dataStorage, storageEventKey } from "../account/wikiStorage";
/**
 * AI 写出来的东西(史书、释名……)按世界存在本地浏览器里(阶段 5)。登录了网站账号的,跟着世界同步进账号(account/sync.ts)。
 * 世界 = saveStore 的世界编号(每个世界一个);浏览器存储不可用(隐私模式)时只在内存里。
 * 内存里有一份,每次用之前和浏览器里的原文对一下(同一个网站开了几个标签页,别的标签页可能改过)。
 * 只是看看的世界(打开的种子、分享链接)存进一条:这个世界跟着存进"我的世界",刷新以后还找得到。
 *
 * 各功能用自己的 kind 区分("史书""释名"……),key 由功能自己定(比如 "史书:polity:c4567#0" 或 "释名:settlement:c123#0")。
 */
import { useSyncExternalStore } from 'react';
import { keepWorld, persistent } from '../ui/saveStore';

export interface AiNote {
  /** 功能内唯一的键 */
  key: string;
  /** 哪个功能写的:"史书""释名"…… */
  kind: string;
  /** 显示用的标题 */
  title: string;
  text: string;
  /** ISO 时间 */
  createdAt: string;
  provider: string;
  model: string;
}

const PREFIX = 'civ-atlas:ai-notes:';
const mem = new Map<string, AiNote[]>();
/** 内存里那份对应的浏览器原文(别的标签页改了,原文就对不上了,重读) */
const seen = new Map<string, string | null>();
const subs = new Set<() => void>();
let version = 0;
const emit = () => {
  version++;
  for (const f of subs) f();
};

/** 浏览器里存着的原文;undefined = 浏览器存储用不了(隐私模式) */
function stored(world: string): string | null | undefined {
  try {
    return dataStorage()!.getItem(PREFIX + world);
  } catch {
    return undefined;
  }
}

function read(world: string): AiNote[] {
  const raw = stored(world);
  const m = mem.get(world);
  if (m && (raw === undefined || seen.get(world) === raw)) return m;
  let list: AiNote[] = [];
  try {
    if (raw) {
      const v = JSON.parse(raw);
      if (Array.isArray(v)) list = v.filter((x) => x && typeof x.key === 'string' && typeof x.text === 'string');
    }
  } catch {
    /* 坏数据:当作没有 */
  }
  mem.set(world, list);
  seen.set(world, raw ?? null);
  return list;
}

/** 返回写进浏览器没有(浏览器本来就不让存、整个只在内存里的,算写进去了) */
function write(world: string, list: AiNote[]): boolean {
  mem.set(world, list);
  let ok = true;
  try {
    const raw = list.length ? JSON.stringify(list) : null;
    if (raw) dataStorage()!.setItem(PREFIX + world, raw);
    else dataStorage()!.removeItem(PREFIX + world);
    seen.set(world, raw);
  } catch {
    /* 存不下 / 隐私模式:只留在内存里(浏览器里还是原来那份,别的标签页没改它就一直用内存里的) */
    ok = !persistent();
    seen.set(world, stored(world) ?? null);
  }
  emit();
  return ok;
}

// 别的标签页写了、删了笔记:这里跟着重画(重读时按原文对上没有)
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    const k = storageEventKey(e.key);
    if (k === null || k?.startsWith(PREFIX)) emit();
  });
}

export function listNotes(world: string, kind?: string): AiNote[] {
  const list = read(world);
  return kind ? list.filter((n) => n.kind === kind) : list.slice();
}

export function getNote(world: string, key: string): AiNote | undefined {
  return read(world).find((n) => n.key === key);
}

/** 存一条(同 key 覆盖) */
export function putNote(world: string, note: AiNote): void {
  const list = read(world).filter((n) => n.key !== note.key);
  list.push(note);
  write(world, list);
  keepWorld(world);
}

/**
 * 把一个世界的 AI 笔记复制给另一个世界(我的世界里"复制一份"时用)。内存里的一定带上;
 * 原来那份存在浏览器里、复制的这份存不下(存储满了)= false,原来那份本来就只在内存里的不算
 */
export function copyNotes(from: string, to: string): boolean {
  const list = read(from);
  if (!list.length) return true;
  mem.set(to, list.slice());
  seen.set(to, stored(to) ?? null);
  emit();
  // 原来那份在浏览器里没有(隐私模式、存不下只在内存里):复制的这份也只放内存里
  if (!stored(from)) return true;
  try {
    const raw = JSON.stringify(list);
    dataStorage()!.setItem(PREFIX + to, raw);
    seen.set(to, raw);
    return true;
  } catch {
    return false;
  }
}

export function deleteNote(world: string, key: string): void {
  const list = read(world);
  if (!list.some((n) => n.key === key)) return;
  write(
    world,
    list.filter((n) => n.key !== key),
  );
}

/** 一个世界的笔记原样(同步用) */
export function exportNotes(world: string): AiNote[] {
  return read(world).slice();
}

/** 这个世界的笔记都写进浏览器了没有(存储满了、只留在页面里的 = false;浏览器本来就不让存的算写进去了) */
export function notesSaved(world: string): boolean {
  const list = read(world);
  const raw = stored(world);
  if (raw === undefined || !persistent()) return true;
  return (list.length ? JSON.stringify(list) : null) === raw;
}

/** 同步下来的笔记换上(null / 空 = 没有);不存这个世界(它已经在"我的世界"里了)。返回写进浏览器没有(存储满了 = false) */
export function replaceNotes(world: string, list: AiNote[] | null): boolean {
  const clean = (list ?? []).filter((x) => x && typeof x.key === 'string' && typeof x.text === 'string');
  return write(world, clean);
}

/** 世界删掉了:内存里的也忘掉(浏览器里的由 saveStore 删) */
export function forgetNotes(world?: string): void {
  if (world === undefined) {
    mem.clear();
    seen.clear();
  } else {
    mem.delete(world);
    seen.delete(world);
  }
  emit();
}

/** 笔记变了就调 f(返回取消函数) */
export function subscribeNotes(f: () => void): () => void {
  subs.add(f);
  return () => void subs.delete(f);
}

/** React:某个世界的笔记变了就重渲染(返回一个递增的版本号) */
export function useNotesVersion(): number {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => version,
    () => version,
  );
}
