import { acknowledgeMigration, dataStorage, wikiMode } from "./wikiStorage";
/**
 * 云同步:登录了网站账号,"我的世界"里的世界(存档、几项本地信息、缩略图、AI 写的东西)自动存进账号,
 * 换电脑、换手机登录同一个账号就能接着改。服务器只管"版本号对上才存"(cloud.ts),怎么合并在这里定:
 *
 * - 记着每个世界上次同步到的版本号(rev)和那时内容的指纹(sum);指纹变了 = 这台设备上改过
 *   (存在 localStorage 'civ-atlas:sync',跟着账号:换了账号从头来,这台设备上的世界都存进新账号;
 *   原来那个账号的记录另外收着,换回来接着用,没告诉服务器的删除不会丢;
 *   几个标签页共用这一份,写回去时只换上自己改过的那几条)
 * - 内容指纹按键名排好序算(键的先后不同不算改过);同步途中用户又改了、删了的,按现在的样子对,不覆盖
 * - 什么时候同步:登录后、打开网页时、回到这个页面 / 联网时、每分钟一次(都是"全看一遍");
 *   改了以后 2 秒(只把改过的存上去,不看服务器那边)
 * - 全看一遍时逐个对:
 *     只有服务器变了   → 取回来覆盖本地
 *     只有本地变了     → 带上次的版本号存上去
 *     两边都变了       → 两份都留:本地这份照旧用原来的编号存上去,服务器那份另存成一个新世界,名字后面加"(另一台设备)"
 *     服务器上删了     → 本地没改过就跟着删;改过就存回去(改过的那份赢)
 *     服务器上有、本地没有 → 取回来("我的世界"满了就先不取);本地有、服务器上没有 → 存上去
 * - 用户删掉一个世界(saveStore 的 deleteWorld):带上次的版本号去删;断网、没登录时先记着,下次同步时删
 *   (为了腾地方删掉的旧世界不算,账号里的还在;正在存上去的工夫被挤掉的也不算)
 * - 还用老编号存着的世界(浏览器存储满了没换成新编号)存不进账号:卡片上写没同步上,退出登录不让选"删掉"
 * - 正在看的那个世界不被别的设备的改动覆盖、删掉:提示一句,点"载入"再换(回到"我的世界"以后照常同步)
 * - 没同步上(断网、服务器出错)的,"我的世界"卡片上写"还没同步上",下次再试
 */
import { useSyncExternalStore } from 'react';
import { exportNotes, forgetNotes, replaceNotes, subscribeNotes, type AiNote } from '../ai/library';
import { TITLE_MAX, cleanTitle } from '../gen/savefile';
import {
  MAX_WORLDS,
  cleanSyncMeta,
  currentUnsaved,
  currentWorld,
  legacyIds,
  listWorlds,
  newWorldId,
  putSyncedWorld,
  rawWorld,
  removeAllWorlds,
  removeSyncedWorld,
  setDeleteHook,
  storedCount,
  storedIds,
  subscribe as subscribeSaves,
  syncable,
  type RawWorld,
} from '../ui/saveStore';
import { getStage, subscribeStage } from '../ui/stageStore';
import { clearToast, getToast, showToast } from '../ui/toastStore';
import { deleteCloud, getCloud, listCloud, putCloud, type CloudEntry, type CloudWorld, type PutBody } from './cloud';
import { authed, getSession, logout, onLogin, onSessionChange, refreshSession, updateUser } from './session';
import { ServerError, serverBase } from './server';

// ---------------------------------------------------------------------------
// 记着的同步状态

interface Known {
  /** 上次同步到的版本号 */
  rev: number;
  /** 那时内容的指纹 */
  sum: string;
  /** 那时不算缩略图的指纹(看哪边改过时用:缩略图会自己重画,不算改了这个世界) */
  core?: string;
  /** 那是什么时候(ISO) */
  at: string;
}

/** Known.rev 记成这个 = 这里的那份比账号里的旧、缺了东西(退出时删了一半没能放回去),下次同步取回来。服务器的版本号从 1 起 */
const STALE_REV = 0;

interface SyncState {
  /** 哪个账号的 */
  user: string;
  worlds: Record<string, Known>;
  /** 删掉了、还没告诉服务器的:编号 → 删的时候的版本号 */
  deletes: Record<string, number>;
}

const KEY = 'civ-atlas:sync';
/** 换了账号时,原来那个账号的记录另外收在 STASH + 账号编号 */
const STASH = 'civ-atlas:sync:';
let memState: SyncState | null = null;
/** memState 比浏览器里的新(上次没写进去:存不下、隐私模式) */
let dirty = false;

/** 浏览器里存着的记录(key 默认是现在这份;undefined = 浏览器存储用不了) */
function storedState(key = KEY): SyncState | null | undefined {
  try {
    if (!dataStorage()) return undefined;
    const raw = dataStorage()!.getItem(key);
    if (!raw) return null;
    const v = JSON.parse(raw) as SyncState;
    return v && typeof v.user === 'string' && v.worlds && typeof v.worlds === 'object' && v.deletes && typeof v.deletes === 'object' ? v : null;
  } catch {
    return undefined;
  }
}

/**
 * 一份记录从浏览器里读出来(或上次写进去)时的样子。同一个网站开着几个标签页时,它们共用浏览器里的记录,
 * 各自同步、各自记删除:写回去时只换上这边改过的那几条,别的照浏览器里现在的(别的标签页刚记下的删除不会被盖掉)
 */
const bases = new WeakMap<SyncState, SyncState>();
const copyState = (st: SyncState): SyncState => ({ user: st.user, worlds: { ...st.worlds }, deletes: { ...st.deletes } });
const sameKnown = (a: Known | undefined, b: Known | undefined) => a === b || (!!a && !!b && a.rev === b.rev && a.sum === b.sum && a.core === b.core && a.at === b.at);

/** 三方合:这边没动过的(ours 和 base 一样)换成浏览器里现在的(theirs) */
function mergeInto<T>(ours: Record<string, T>, base: Record<string, T>, theirs: Record<string, T>, same: (a: T | undefined, b: T | undefined) => boolean) {
  for (const id of new Set([...Object.keys(base), ...Object.keys(theirs)])) {
    if (!same(ours[id], base[id])) continue;
    if (id in theirs) ours[id] = theirs[id];
    else delete ours[id];
  }
}

function readState(): SyncState | null {
  const v = storedState();
  if (v === undefined) return memState;
  if (!v) {
    // 写进去过、现在没了:别的标签页清掉了(退出时删了这台设备上的世界、注销了账号)
    if (memState && bases.has(memState)) {
      memState = null;
      dirty = false;
    }
    return memState;
  }
  if (dirty && memState && memState.user === v.user) {
    // 上次没写进去:内存里这份新(刚记下的删除在这里),这边没动过的那几条照浏览器里现在的(别的标签页写的)
    const base = bases.get(memState) ?? { user: v.user, worlds: {}, deletes: {} };
    const merged = copyState(memState);
    mergeInto(merged.worlds, base.worlds, v.worlds, sameKnown);
    mergeInto(merged.deletes, base.deletes, v.deletes, (a, b) => a === b);
    bases.set(merged, copyState(v));
    memState = merged;
    return merged;
  }
  bases.set(v, copyState(v));
  return v;
}

function writeState(st: SyncState | null) {
  if (!st) {
    memState = null;
    dirty = false;
    try {
      dataStorage()?.removeItem(KEY);
    } catch {
      /* 隐私模式 */
    }
    return;
  }
  const base = bases.get(st);
  let key = KEY;
  let now = storedState();
  if (base && now && now.user !== st.user) {
    // 别的标签页换了账号,这个账号的记录它另外收着了:写进收着的那份
    key = STASH + st.user;
    now = storedState(key);
  }
  if (base && now === null) {
    // 别的标签页把记录清掉了:不写回去
    if (key === KEY) {
      memState = null;
      dirty = false;
    }
    return;
  }
  if (base && now) {
    mergeInto(st.worlds, base.worlds, now.worlds, sameKnown);
    mergeInto(st.deletes, base.deletes, now.deletes, (a, b) => a === b);
  }
  if (key === KEY) memState = st;
  try {
    if (!dataStorage()) return;
    dataStorage()!.setItem(key, JSON.stringify(st));
    bases.set(st, copyState(st));
    if (key === KEY) dirty = false;
  } catch {
    // 存不下:只在内存里(之后读的时候以内存里这份为准)
    if (key === KEY) dirty = true;
  }
}

// ---------------------------------------------------------------------------
// 内容指纹

function cyrb53(str: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${str.length.toString(36)}-${(h2 >>> 0).toString(16).padStart(8, '0')}${(h1 >>> 0).toString(16).padStart(8, '0')}`;
}

/** 按键名排好序再转成字(同样的内容,键的先后不同也算一样:服务器那边存取可能换了顺序) */
function canon(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x,
  );
}

/** 存档原文 → 排好序的样子(不算存的时刻;存档大,同一份只算一次) */
const canonSaves = new Map<string, string>();
function canonSave(text: string): string {
  let c = canonSaves.get(text);
  if (c === undefined) {
    try {
      const save: unknown = JSON.parse(text);
      // 存的时刻不算内容:两台设备各自做了一样的改动(比如改成同一个名字),只差存的时刻,不算两边都改了
      if (save && typeof save === 'object' && !Array.isArray(save)) delete (save as { savedAt?: unknown }).savedAt;
      c = canon(save);
    } catch {
      c = text;
    }
    if (canonSaves.size >= 200) canonSaves.delete(canonSaves.keys().next().value as string);
    canonSaves.set(text, c);
  }
  return c;
}

const notesText = (n: AiNote[] | null | undefined) => (n && n.length ? canon(n) : '');

const rawAssistant = (w: RawWorld) => wikiMode() ? [canon(w.assistant ?? null)] : [];

function sumOf(w: RawWorld, notes: AiNote[] | null | undefined): string {
  return cyrb53([canonSave(w.save), canon(w.meta), w.thumb ?? '', notesText(notes), ...(rawAssistant(w))].join('\u0000'));
}

/** 不算缩略图的指纹:两边做了同样的改动,不同的浏览器画出来的图也可能差一点点;打开世界时缩略图也会重画 */
const coreOf = (w: RawWorld, notes: AiNote[] | null | undefined) => sumOf({ ...w, thumb: null }, notes);

interface Local {
  raw: RawWorld;
  notes: AiNote[];
  sum: string;
  core: string;
}

function localOf(raw: RawWorld, notes: AiNote[]): Local {
  return { raw, notes, sum: sumOf(raw, notes), core: coreOf(raw, notes) };
}

function localWorld(id: string): Local | null {
  const raw = rawWorld(id);
  if (!raw) return null;
  return localOf(raw, exportNotes(id));
}

/** 上次同步以后这里有没有改过这个世界(只重画了缩略图不算) */
const unchanged = (k: Known | undefined, l: Local) => !!k && (k.sum === l.sum || (k.core !== undefined && k.core === l.core));

/** 存着的世界按什么顺序同步:最近打开或改过的在前(换台设备最可能接着用的先传上去) */
function syncOrder(): string[] {
  const ids = new Set(storedIds());
  const recent = listWorlds()
    .map((w) => w.id)
    .filter((id) => ids.has(id));
  return [...new Set([...recent, ...ids])];
}

/** 服务器上那份 → 写进浏览器的样子(和本地的指纹一样算法) */
function remoteRaw(w: CloudWorld, save: unknown = w.save): RawWorld {
  return { save: JSON.stringify(save), meta: cleanSyncMeta(w.meta), thumb: typeof w.thumb === 'string' && w.thumb ? w.thumb : null, ...(wikiMode() ? { assistant: w.assistant ?? null } : {}) };
}

// ---------------------------------------------------------------------------
// 状态(界面显示)

export type SyncPhase = 'off' | 'idle' | 'syncing' | 'offline' | 'error';

export interface SyncView {
  phase: SyncPhase;
  /** 正在同步的世界 */
  busy: ReadonlySet<string>;
  /** 没同步上的世界 → 原因 */
  failed: ReadonlyMap<string, string>;
  /** 上次全部同步好的时间(ISO) */
  lastOk: string | null;
  /** 连不上、出错时的原因 */
  message?: string;
}

let view: SyncView = { phase: 'off', busy: new Set(), failed: new Map(), lastOk: null };
let viewVersion = 0;
const viewSubs = new Set<() => void>();
function setView(patch: Partial<SyncView>) {
  view = { ...view, ...patch };
  viewVersion++;
  for (const f of viewSubs) f();
}

export function getSyncView(): SyncView {
  return view;
}

/** 还没同步上的世界有几个:同步没成的,加上还用老编号存着、存不进账号的(同步不碰它们,不在 failed 里) */
export function unsyncedCount(v: SyncView = view): number {
  return new Set([...v.failed.keys(), ...legacyIds()]).size;
}

/** React:同步状态变了就重渲染 */
export function useSyncView(): SyncView {
  useSyncExternalStore(
    (f) => (viewSubs.add(f), () => void viewSubs.delete(f)),
    () => viewVersion,
    () => viewVersion,
  );
  return view;
}

export interface WorldSync {
  state: 'synced' | 'busy' | 'failed';
  /** 同步好的时间(ISO) */
  at?: string;
  message?: string;
}

/** 一个世界同步得怎么样(没登录 = null) */
export function worldSync(id: string): WorldSync | null {
  if (view.phase === 'off') return null;
  if (!syncable(id)) return { state: 'failed', message: LEGACY_WHY };
  const why = view.failed.get(id);
  if (why !== undefined) return { state: 'failed', message: why };
  if (view.busy.has(id)) return { state: 'busy' };
  const k = readState()?.worlds[id];
  const l = k ? localWorld(id) : null;
  if (k && l && k.sum === l.sum) return { state: 'synced', at: k.at };
  return { state: view.phase === 'offline' || view.phase === 'error' ? 'failed' : 'busy', message: view.message };
}

const FULL_WHY = '浏览器存储满了，账号里这个世界的样子没能放进来：先删掉几个世界';
const LIST_FULL_WHY = `「我的世界」满了（最多 ${MAX_WORLDS} 个），账号里的这个世界放不进来：先删掉几个世界`;
const LEGACY_WHY = '以前存的世界，浏览器存储满了，没能换成新的存法，存不进账号；删掉几个世界、刷新页面再试';

// ---------------------------------------------------------------------------
// 一次同步

const nowIso = () => new Date().toISOString();
/** 写进浏览器的是同步带来的(不为它再排一次同步) */
let applying = false;
/**
 * 存不上去的(太大、账号里放满了):内容没再变、账号里也没腾出地方就不重试。跟着账号(换了账号从头试:可能是那个账号自己的上限)。
 * room = 记下时的 roomMark:之后账号里删掉了世界(可能腾出了地方)就再试一次
 */
const rejected = new Map<string, { sum: string; why: string; room: number }>();
let rejectedFor: string | null = null;
/** 账号里删掉了世界(这里删的告诉了服务器、全看一遍时发现别的设备删了)就加一 */
let roomMark = 0;
/** 上次全看一遍时账号里还在的世界 */
let lastAlive = new Set<string>();
/** 正在看的世界在别的设备上改过,已经提示过的版本 */
const offered = new Map<string, number>();
/** 两边都改过、两份都留的世界名字(这一次同步里) */
let forks: { name: string; other: string }[] = [];
/** 这一次同步里没同步上的 */
let failedNow = new Map<string, string>();
let busyNow = new Set<string>();
/** 正在看的、账号里比这里新的世界(别的设备改过,还没「载入」):最近一次全看一遍时记下的 */
let behind = new Set<string>();
let behindNow = new Set<string>();
/**
 * 两边都改过、另存好了另一份,存本地这份时回话断了(不知道服务器收到没有):另存的那份留着(收到了的话服务器上原来那份已经被盖掉,
 * 它是唯一的一份)。记下是为服务器上哪个版本另存的:下次再对还是那个版本,就用这一份,不再另存
 */
const forkedFor = new Map<string, { rev: number; nid: string }>();

/** 正在看的这个世界(不在"我的世界"那一页):别的设备的改动先不覆盖它 */
/** 正在看的世界(不被别的设备的改动覆盖、删掉);因为它先放着没做的,回到"我的世界"时再全看一遍 */
let pinnedSkipped = false;
function pinned(id: string): boolean {
  const c = currentWorld();
  const on = !!c && c.id === id && getStage().stage !== 'home';
  if (on) pinnedSkipped = true;
  return on;
}

function done(id: string) {
  if (!busyNow.delete(id)) return;
  setView({ busy: new Set(busyNow) });
}

const FORK_SUFFIX = '（另一台设备）';
function otherTitle(t: unknown): string {
  const root = cleanTitle(typeof t === 'string' ? t : '') || '未命名世界';
  return [...root].slice(0, TITLE_MAX - FORK_SUFFIX.length).join('') + FORK_SUFFIX;
}

/**
 * 写进浏览器(同步带来的);写不下 = false,什么都不动。AI 写的东西先写:它写不下而存档写进去了的话,
 * 刷新以后那些东西没了,下一轮会当成这里删了、把服务器上的也冲掉
 */
function store(id: string, raw: RawWorld, notes: AiNote[] | null): boolean {
  applying = true;
  try {
    const before = exportNotes(id);
    if (!replaceNotes(id, notes) || !putSyncedWorld(id, raw)) {
      replaceNotes(id, before);
      return false;
    }
    return true;
  } finally {
    applying = false;
  }
}

const thumbOf = (t: string | null) => (t && t.length <= 200_000 ? t : null);
/** 正在存上去的世界;存的工夫用户删掉了的(只认用户删的,为了腾地方挤掉的不算) */
const uploading = new Set<string>();
const deletedWhileUp = new Set<string>();
/** AI 写的东西最多存多少字(服务器的上限) */
const NOTES_MAX = 1_000_000;

async function upload(st: SyncState, id: string, l: Local, baseRev: number, revive = false) {
  // AI 写的东西太多:存不进账号,算没同步上(不能当存好了:退出登录选"删掉"时会把唯一的一份删了)
  if (l.notes.length && JSON.stringify(l.notes).length > NOTES_MAX) {
    throw new ServerError(400, 'bad-request', 'AI 给这个世界写的东西太多了，存不进账号');
  }
  const body: PutBody = { baseRev, save: JSON.parse(l.raw.save), meta: { ...l.raw.meta }, thumb: thumbOf(l.raw.thumb), notes: l.notes.length ? l.notes : null, ...(wikiMode() ? { assistant: l.raw.assistant ?? null } : {}) };
  if (revive) body.revive = true;
  uploading.add(id);
  deletedWhileUp.delete(id);
  let r: { rev: number };
  try {
    r = await net(() => putCloud(id, body));
  } catch (e) {
    // 没收到回话(断网、服务器出错、换了账号):存上去没有说不准。这期间用户删了它的,删除照样记着,下一轮不按版本号直接删
    // (要是存上去了,版本号已经变了,按原来的版本号删会对不上,又被取回来)
    const unsure = e instanceof SessionChanged || (e instanceof ServerError && (e.code === 'network' || e.status === 0 || e.status >= 500));
    if (deletedWhileUp.delete(id) && unsure) {
      st.deletes[id] = 0;
      delete st.worlds[id];
      writeState(st);
    }
    throw e;
  } finally {
    uploading.delete(id);
  }
  if (deletedWhileUp.delete(id)) {
    // 存上去的工夫用户把它删了:按删掉算,下一轮告诉服务器
    st.deletes[id] = r.rev;
    delete st.worlds[id];
    return;
  }
  // 存上去的工夫为了腾地方被挤出浏览器的也算存好了:账号里的那份留着,有地方了再取回来
  st.worlds[id] = { rev: r.rev, sum: l.sum, core: l.core, at: nowIso() };
  behind.delete(id);
  acknowledgeMigration(id, l.raw.save, l.raw.assistant, l.notes);
}

/** 存上去;版本号对不上就按"全看一遍"的规矩合并 */
async function push(st: SyncState, id: string, l: Local, baseRev: number, revive = false, depth = 0): Promise<void> {
  const no = rejected.get(id);
  if (no && no.sum === l.sum && no.room === roomMark) {
    failedNow.set(id, no.why);
    return;
  }
  try {
    await upload(st, id, l, baseRev, revive);
  } catch (e) {
    if (e instanceof ServerError && e.code === 'conflict' && depth < 2) {
      const entry: CloudEntry = { id, rev: Number(e.data.rev) || 0, deleted: e.data.deleted === true };
      return reconcile(st, id, entry, depth + 1);
    }
    if (e instanceof ServerError && e.status === 400) {
      rejected.set(id, { sum: l.sum, why: e.message, room: roomMark });
      failedNow.set(id, e.message);
      return;
    }
    throw e;
  }
}

/**
 * 取回来覆盖本地(本地没有就新存一个;"我的世界"满了、写不下就先不取)。
 * expect = 决定取回来时本地的指纹(null = 本地没有):等服务器回话的工夫用户又改了、删了,就不覆盖,下一轮再对
 */
async function pull(st: SyncState, id: string, expect?: string | null): Promise<boolean> {
  let w: CloudWorld;
  try {
    w = await net(() => getCloud(id));
  } catch (e) {
    if (e instanceof ServerError && e.code === 'not-found') return false;
    throw e;
  }
  if (id in st.deletes) return false;
  if (expect !== undefined && (localWorld(id)?.sum ?? null) !== expect) return false;
  // 取的工夫用户新建了世界、放满了:新的这个先不放(下次有地方再取),算没同步上
  if (!storedIds().includes(id) && storedCount() >= MAX_WORLDS) {
    failedNow.set(id, LIST_FULL_WHY);
    return false;
  }
  const raw = remoteRaw(w);
  const notes = Array.isArray(w.notes) ? w.notes : null;
  if (!store(id, raw, notes)) {
    // 存不进浏览器:算没同步上(不然卡片、账号窗都说同步好了,可这个世界在这里还是旧的、或者根本没有)
    failedNow.set(id, FULL_WHY);
    return false;
  }
  const l = localWorld(id);
  if (l) st.worlds[id] = { rev: w.rev, sum: l.sum, core: l.core, at: nowIso() };
  forgetOffer(id);
  behind.delete(id);
  return true;
}

function forgetOffer(id: string) {
  if (!offered.delete(id)) return;
  const t = getToast();
  if (t?.id === 'sync-reload') clearToast('sync-reload');
}

/** 正在看的世界在别的设备上改过:提示一句,点"载入"再换 */
let reloadHandler: ((id: string) => void) | null = null;
export function setReloadHandler(f: ((id: string) => void) | null) {
  reloadHandler = f;
}
function offerReload(id: string, rev: number) {
  if (offered.get(id) === rev) return;
  offered.set(id, rev);
  showToast({
    id: 'sync-reload',
    kind: 'info',
    text: '这个世界在另一台设备上改过',
    more: ['载入那边改过的样子'],
    action: { label: '载入', act: 'sync-reload', onClick: () => void pullWorld(id).then((ok) => ok && reloadHandler?.(id)) },
    ttl: 0,
  });
}

/**
 * "载入":把正在看的这个世界换成账号里的那份(之后 App 重新打开它)。
 * 和同步排队(不同时改同步记录);只替点"载入"时登着的那个账号做,等的工夫、取的工夫退出了、换了账号就不载入
 */
export async function pullWorld(id: string): Promise<boolean> {
  const token = getSession()?.token;
  if (!token) return false;
  // 点"载入"时这个世界的样子:等的工夫又改了,就不拿账号里的盖掉(下次同步两份都留)
  const expect = localWorld(id)?.sum ?? null;
  clearToast('sync-reload');
  return serial(async () => {
    const s = getSession();
    const st = readState();
    if (!s || s.token !== token || !st || st.user !== s.user.id) return false;
    cycleToken = token;
    active = st;
    failedNow = new Map();
    try {
      const ok = await pull(st, id, expect);
      writeState(st);
      if (!ok && (localWorld(id)?.sum ?? null) !== expect) {
        showToast({ id: 'sync', kind: 'info', text: '没有载入', more: ['等的工夫这里又改过了；下次同步时两边改的都会留下'] });
      }
      const why = failedNow.get(id);
      if (why) {
        showToast({ id: 'sync', kind: 'error', text: '没能载入', more: [why] });
        setView({ failed: new Map([...view.failed, [id, why]]) });
      }
      return ok;
    } catch (e) {
      if (!(e instanceof SessionChanged)) showToast({ id: 'sync', kind: 'error', text: '没能载入', more: [e instanceof Error ? e.message : String(e)] });
      return false;
    } finally {
      active = null;
    }
  });
}

/** 两边都改过:服务器那份另存成新世界(名字加"(另一台设备)"),本地这份存上去 */
async function fork(st: SyncState, id: string, l: Local, remote: CloudWorld) {
  const save = remote.save && typeof remote.save === 'object' ? { ...(remote.save as Record<string, unknown>) } : remote.save;
  const other = otherTitle((save as { title?: unknown })?.title);
  if (save && typeof save === 'object') (save as Record<string, unknown>).title = other;
  const no = rejected.get(id);
  if (no && no.sum === l.sum && no.room === roomMark) {
    failedNow.set(id, no.why);
    return;
  }
  const prior = forkedFor.get(id);
  const reuse = prior && prior.rev === remote.rev && localWorld(prior.nid) ? prior.nid : null;
  if (!reuse && storedCount() >= MAX_WORLDS) {
    // 另一份放不下:先不覆盖服务器上的(两份都还在),等腾出地方
    failedNow.set(id, `「我的世界」满了（最多 ${MAX_WORLDS} 个），两台设备上改的没法都留下：先删掉一个世界`);
    return;
  }
  const nid = reuse ?? newWorldId();
  const forkRaw = remoteRaw(remote, save);
  const forkNotes = Array.isArray(remote.notes) ? remote.notes : null;
  if (!reuse && !store(nid, forkRaw, forkNotes)) {
    // 存不下另一份:先不覆盖服务器上的(两份都还在),等腾出地方
    failedNow.set(id, '浏览器存储满了，两台设备上改的没法都留下');
    return;
  }
  // 存本地这份的工夫,另存的那份可能被挤出浏览器(为别的世界腾地方),也可能被用户删掉:只有用户删的才算不要了
  uploading.add(nid);
  deletedWhileUp.delete(nid);
  let dropped = false;
  try {
    await upload(st, id, l, remote.rev);
  } catch (e) {
    const unsure = e instanceof SessionChanged || (e instanceof ServerError && (e.code === 'network' || e.status === 0 || e.status >= 500));
    if (unsure) {
      // 不知道服务器收到没有:另存的那份留着,下次用它
      forkedFor.set(id, { rev: remote.rev, nid });
      throw e;
    }
    // 服务器明确没收:刚另存的那份撤掉(服务器上还是那份),下次重来,不然每试一次多一份
    forkedFor.delete(id);
    applying = true;
    try {
      removeSyncedWorld(nid);
      forgetNotes(nid);
    } finally {
      applying = false;
    }
    if (e instanceof ServerError && e.status === 400) {
      rejected.set(id, { sum: l.sum, why: e.message, room: roomMark });
      failedNow.set(id, e.message);
      return;
    }
    throw e;
  } finally {
    uploading.delete(nid);
    dropped = deletedWhileUp.delete(nid);
  }
  // 被挤出去了也照样存进账号(服务器上原来那份已经被本地这份盖掉,另存的这份是它唯一的去处),有地方了再取回来
  const n = localWorld(nid) ?? (dropped ? null : localOf(forkRaw, forkNotes ?? []));
  forkedFor.delete(id);
  if (n) await push(st, nid, n, 0);
  const name = cleanTitle((JSON.parse(l.raw.save) as { title?: string }).title) || '未命名世界';
  forks.push({ name, other });
}

/** 一个世界:本地、上次同步(st.worlds)、服务器上(s)三方对一遍。本地按现在的样子(同步途中用户可能又改了、删了) */
async function reconcile(st: SyncState, id: string, s: CloudEntry | null, depth = 0): Promise<void> {
  const l = localWorld(id);
  // 刚删掉、还没告诉服务器的:下一轮去删,这次不取回来
  if (!l && id in st.deletes) return;
  let k = st.worlds[id];
  // 以前记下的没有不算缩略图的指纹:这里和那时一样,就补上(之后只重画了缩略图也认得出没改过)
  if (k && k.core === undefined && l && k.sum === l.sum) k = st.worlds[id] = { ...k, core: l.core };
  if (!s) {
    if (l) await push(st, id, l, 0, false, depth);
    else delete st.worlds[id];
    return;
  }
  if (s.deleted) {
    if (!l) {
      delete st.worlds[id];
      return;
    }
    if (unchanged(k, l)) {
      // 这里没改过:跟着删(正在看的先不删)
      if (pinned(id)) return;
      applying = true;
      try {
        removeSyncedWorld(id);
        forgetNotes(id);
      } finally {
        applying = false;
      }
      delete st.worlds[id];
      return;
    }
    // 改过的那份赢:存回去
    await push(st, id, l, s.rev, true, depth);
    return;
  }
  if (!l) {
    // 「我的世界」满了放不下:算没同步上(不然账号窗说都同步好了,这台设备上却看不到它)
    if (storedCount() < MAX_WORLDS) await pull(st, id, null);
    else failedNow.set(id, LIST_FULL_WHY);
    return;
  }
  if (k && k.rev === s.rev) {
    if (k.sum !== l.sum) await push(st, id, l, s.rev, false, depth);
    return;
  }
  if (unchanged(k, l)) {
    // 只有服务器变了(这里顶多重画了缩略图:换成那边的)
    if (pinned(id)) {
      behindNow.add(id);
      return offerReload(id, s.rev);
    }
    await pull(st, id, l.sum);
    return;
  }
  // 两边都变了(或者这台设备不知道上次同步到哪):先取回来看看是不是一样
  let remote: CloudWorld;
  try {
    remote = await net(() => getCloud(id));
  } catch (e) {
    if (e instanceof ServerError && e.code === 'not-found') return push(st, id, l, s.rev, true, depth);
    throw e;
  }
  // 一样就不算两边都改过(缩略图不比,各留各的)
  const core = coreOf(remoteRaw(remote), Array.isArray(remote.notes) ? remote.notes : null);
  if (core === l.core) {
    st.worlds[id] = { rev: remote.rev, sum: l.sum, core: l.core, at: nowIso() };
    return;
  }
  // 那边只是重画了缩略图(内容和上次同步时一样):只有这边改了,接着那边的版本存上去
  if (k?.core !== undefined && core === k.core) return push(st, id, l, remote.rev, false, depth);
  await fork(st, id, l, remote);
}

/** 换了账号:原来那个账号的同步记录另外收着(STASH + 账号编号;里面可能有还没告诉服务器的删除),换回来时接着用 */
function stash(st: SyncState): boolean {
  try {
    if (typeof localStorage === 'undefined') return true;
    dataStorage()!.setItem(STASH + st.user, JSON.stringify(st));
    return true;
  } catch {
    return false;
  }
}
function unstash(user: string): SyncState | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = dataStorage()!.getItem(STASH + user);
    if (!raw) return null;
    localStorage.removeItem(STASH + user);
    const v = JSON.parse(raw) as SyncState;
    return v && v.user === user && v.worlds && typeof v.worlds === 'object' && v.deletes && typeof v.deletes === 'object' ? v : null;
  } catch {
    return null;
  }
}

function stateFor(user: string): SyncState {
  const st = readState();
  if (st && st.user === user) return st;
  // 原来那个账号的记录收不起来(浏览器存储满了):先不换,不然它没告诉服务器的删除就丢了,换回去时删掉的世界又回来
  if (st && !stash(st)) throw new Error('浏览器存储满了，没能收好原来那个账号的同步记录：先删掉几个世界再同步');
  const next: SyncState = unstash(user) ?? { user, worlds: {}, deletes: {} };
  writeState(next);
  return next;
}

/** 正在跑的这次同步用的记录(这期间用户删了世界,记在它上面,免得被这次同步写回去盖掉) */
let active: SyncState | null = null;

/** 这次同步是替哪一次登录(令牌)做的 */
let cycleToken: string | null = null;
/** 同步途中退出了、换了账号:这次停下(剩下的请求会带上新账号的令牌,记录却是原来那个账号的) */
class SessionChanged extends Error {}
function sameSession(): void {
  if (getSession()?.token !== cycleToken) throw new SessionChanged('换了账号');
}
/** 同步里的每个请求都过这里:发之前、回来以后都看一眼还是不是同一次登录 */
async function net<T>(f: () => Promise<T>): Promise<T> {
  sameSession();
  try {
    return await f();
  } finally {
    sameSession();
  }
}

/** 同步一次:full = 全看一遍;否则只把改过的存上去 */
async function cycle(full: boolean): Promise<void> {
  let s = getSession();
  if (!s || !serverBase()) {
    setView({ phase: 'off', busy: new Set(), failed: new Map() });
    return;
  }
  cycleToken = s.token;
  if (!s.user.id) {
    // 以前只为 AI 登录的(没记账号编号):问一次服务器
    const me = await net(() => authed<{ user?: { id?: unknown; account?: unknown; name?: unknown } }>('/v1/me'));
    updateUser(me.user, cycleToken);
    s = getSession();
    if (!s?.user.id) return;
  }
  const st = stateFor(s.user.id);
  if (rejectedFor !== s.user.id) {
    rejected.clear();
    forkedFor.clear();
    rejectedFor = s.user.id;
    lastAlive = new Set();
  }
  active = st;
  try {
    await cycleWith(st, full);
  } finally {
    active = null;
  }
}

async function cycleWith(st: SyncState, full: boolean): Promise<void> {
  const local = new Map<string, Local>();
  for (const id of syncOrder()) {
    const l = localWorld(id);
    if (l) local.set(id, l);
  }
  failedNow = new Map();
  forks = [];
  busyNow = new Set([...local].filter(([id, l]) => st.worlds[id]?.sum !== l.sum).map(([id]) => id));
  setView({ phase: 'syncing', busy: new Set(busyNow) });

  // 删掉的先告诉服务器(之后别的设备又改过的,改过的那份赢:不删,下面取回来)
  for (const [id, baseRev] of Object.entries(st.deletes)) {
    if (!local.has(id)) {
      try {
        await net(() => deleteCloud(id, baseRev || undefined));
        // 腾出了地方:存不上去的再试一次
        roomMark++;
      } catch (e) {
        if (!(e instanceof ServerError && e.code === 'conflict')) throw e;
        full = true;
      }
    }
    delete st.deletes[id];
    delete st.worlds[id];
    writeState(st);
  }

  // 有记成"比账号里的旧"的(退出时删了一半):这次也全看一遍,先把完整的取回来,不按这里缺了东西的那份存上去
  if (!full && [...local.keys()].some((id) => st.worlds[id]?.rev === STALE_REV)) full = true;
  if (full) {
    behindNow = new Set();
    const list = await net(() => listCloud());
    const server = new Map(list.map((e) => [e.id, e]));
    // 别的设备删了世界,可能腾出了地方:存不上去的再试一次
    const alive = new Set(list.filter((e) => !e.deleted).map((e) => e.id));
    if ([...lastAlive].some((id) => !alive.has(id))) roomMark++;
    lastAlive = alive;
    for (const e of list) if (!e.deleted && st.worlds[e.id]?.rev !== e.rev && !pinned(e.id)) busyNow.add(e.id);
    setView({ busy: new Set(busyNow) });
    for (const id of new Set([...local.keys(), ...server.keys()])) {
      await reconcile(st, id, server.get(id) ?? null);
      writeState(st);
      done(id);
    }
    behind = behindNow;
  } else {
    for (const id of local.keys()) {
      // 按现在的样子(前面几个存上去的工夫,用户可能又改了、删了)
      const l = localWorld(id);
      const k = st.worlds[id];
      if (!l || (k && k.sum === l.sum)) {
        done(id);
        continue;
      }
      await push(st, id, l, k?.rev ?? 0);
      writeState(st);
      done(id);
    }
  }

  if (forks.length) {
    const f = forks[0];
    showToast({
      id: 'sync',
      kind: 'warn',
      text: forks.length > 1 ? `${forks.length} 个世界在两台设备上都改过` : `「${f.name}」在两台设备上都改过`,
      more: [forks.length > 1 ? '两份都留着了，另一台设备上的那份名字后面加了"（另一台设备）"' : `两份都留着了，另一台设备上的那份叫「${f.other}」`],
    });
  }
  setView({ phase: 'idle', busy: new Set(), failed: failedNow, lastOk: failedNow.size ? view.lastOk : nowIso(), message: undefined });
}

// ---------------------------------------------------------------------------
// 排队:同一时间只跑一次;跑的时候又要同步,跑完再来一次

let running: Promise<void> | null = null;
let again: 'full' | 'push' | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let timerMode: 'full' | 'push' | null = null;
/** 每次同步完成(成功或失败)后调(登录后的提示、退出前的同步等它) */
const afterRun = new Set<() => void>();

function failAll(e: unknown) {
  const msg =
    e instanceof ServerError
      ? e.code === 'network' || e.status === 0
        ? '连不上服务器，联网后会自动同步'
        : e.message
      : e instanceof Error
        ? e.message
        : String(e);
  const offline = e instanceof ServerError && (e.code === 'network' || e.status === 0 || e.status === 429 || e.status >= 500);
  const failed = new Map(failedNow);
  for (const id of busyNow) failed.set(id, msg);
  busyNow = new Set();
  setView({ phase: getSession() ? (offline ? 'offline' : 'error') : 'off', busy: new Set(), failed, message: msg });
}

async function runOnce(mode: 'full' | 'push') {
  try {
    await cycle(mode === 'full');
  } catch (e) {
    if (e instanceof SessionChanged) {
      // 新登录的账号会另外同步一次(登录时排上了);这一次的不算出错
      busyNow = new Set();
      if (getSession()) setView({ busy: new Set() });
      return;
    }
    failAll(e);
  }
}

/** 排一次同步(delay 毫秒以后;已经排了更早的就不动) */
export function requestSync(mode: 'full' | 'push' = 'full', delay = 0): void {
  if (!getSession() || !serverBase()) return;
  if (running) {
    again = again === 'full' || mode === 'full' ? 'full' : 'push';
    return;
  }
  if (timer !== undefined) {
    if (mode === 'full') timerMode = 'full';
    if (delay > 0) return;
    clearTimeout(timer);
  }
  timerMode = timerMode === 'full' || mode === 'full' ? 'full' : 'push';
  timer = setTimeout(() => {
    timer = undefined;
    const m = timerMode ?? mode;
    timerMode = null;
    void kick(m);
  }, delay);
}

/**
 * 同一时间只做一件(一次同步,或者"载入"):前面那件做完再开始,做完接着把这期间排上的同步跑掉。
 * 返回这一件的结果(不等后面接着跑的同步)
 */
async function serial<T>(job: () => Promise<T>): Promise<T> {
  while (running) await running;
  let release!: () => void;
  running = new Promise<void>((r) => (release = r));
  const result = Promise.resolve().then(job);
  void (async () => {
    await result.then(
      () => {},
      () => {},
    );
    for (let m = again; m; m = again) {
      again = null;
      await runOnce(m);
    }
    running = null;
    release();
    for (const f of [...afterRun]) f();
  })();
  return result;
}

/** 同步一次(正在做别的就排在后面);等它和接着跑的都做完 */
async function kick(mode: 'full' | 'push') {
  if (running) {
    again = again === 'full' || mode === 'full' ? 'full' : 'push';
    return running;
  }
  void serial(() => runOnce(mode));
  return running;
}

/** 马上全看一遍,等它做完 */
export async function syncNow(): Promise<SyncView> {
  if (timer !== undefined) {
    clearTimeout(timer);
    timer = undefined;
    timerMode = null;
  }
  if (running) {
    again = 'full';
    await new Promise<void>((r) => {
      const f = () => {
        if (running) return;
        afterRun.delete(f);
        r();
      };
      afterRun.add(f);
    });
    return view;
  }
  await kick('full');
  return view;
}

/**
 * 正在看的这个世界在别的设备上改过、还没「载入」:账号里的比这里看到的新(看最近一次全看一遍;分享前先 syncNow)。
 * 这时分享出去的会是那边的样子,不是眼前这个
 */
export function behindCloud(id: string): boolean {
  return behind.has(id);
}

// ---------------------------------------------------------------------------
// 登录、退出、删除

/** 这个世界已经存进现在登录的账号了(删掉以后能在「最近删除」里找回;还没传上去的删了就没了) */
export function inAccount(id: string): boolean {
  const s = getSession();
  const st = active ?? readState();
  return !!s?.user.id && !!st && st.user === s.user.id && !!st.worlds[id];
}

/**
 * 删除记在哪份同步记录上:现在登着的这个账号的(没登录 = 上次登录的那个,下次登录时删)。
 * 别的标签页刚换了账号、这个账号还没开始同步:记在它另外收着的那份上(没有 = 这台设备上它还什么都没同步过,不用记)
 */
function stateForDelete(): { st: SyncState; save: () => void } | null {
  const uid = getSession()?.user.id;
  if (active && (!uid || active.user === uid)) {
    const st = active;
    return { st, save: () => writeState(st) };
  }
  const st = readState();
  if (!st) return null;
  if (!uid || st.user === uid) return { st, save: () => writeState(st) };
  const key = STASH + uid;
  const v = storedState(key);
  if (!v || v.user !== uid) return null;
  return {
    st: v,
    save: () => {
      try {
        dataStorage()!.setItem(key, JSON.stringify(v));
      } catch {
        /* 存不下:算了 */
      }
    },
  };
}

/** 用户删掉一个世界:记下来,告诉服务器(断网、没登录时等下次) */
function onLocalDelete(id: string) {
  rejected.delete(id);
  if (uploading.has(id)) deletedWhileUp.add(id);
  const t = stateForDelete();
  const k = t?.st.worlds[id];
  if (t && k) {
    t.st.deletes[id] = k.rev;
    delete t.st.worlds[id];
    t.save();
  }
  if (view.failed.has(id)) {
    const failed = new Map(view.failed);
    failed.delete(id);
    setView({ failed });
  }
  requestSync('push', 300);
}

/** 刚登录:顶上说一句"正在存进账号",同步完收起 */
function onLoggedIn() {
  const n = storedIds().length;
  if (n) {
    showToast({ id: 'sync-login', kind: 'info', text: `已登录，正在把这个浏览器里的 ${n} 个世界存进账号`, more: ['传完以后在别的设备上登录就能看到'], ttl: 0 });
    const f = () => {
      afterRun.delete(f);
      clearToast('sync-login');
    };
    afterRun.add(f);
  }
  requestSync('full', 0);
}

const UNSAVED_WHY = '正在看的这个世界最新的改动没能存进浏览器（存储满了），也就没同步上。先把它存成文件，或者选「留着」';

/** 退出登录。keep = 这台设备上的世界留着(下次登录再同步);否则先全部同步好,再从这台设备上删掉 */
export async function signOut(keep: boolean): Promise<{ ok: true } | { ok: false; message: string }> {
  // 替点"退出"时登着的这次登录做:等同步的工夫别的标签页换了账号,就不删、不退出(不然删的、退出的是新账号的)
  const token = getSession()?.token;
  const old = keep ? 0 : legacyIds().length;
  if (old) {
    return { ok: false, message: `有 ${old} 个以前存的世界还存不进账号（浏览器存储满了，没能换成新的存法），现在删掉就没了。先把它们存成文件，或者选「留着」` };
  }
  if (!keep && currentUnsaved()) {
    // 最新的改动只在这个页面里(浏览器存储满了,没写进去,也就没同步上):删了就没了
    return { ok: false, message: UNSAVED_WHY };
  }
  if (!keep && getSession()) {
    const v = await syncNow();
    refreshSession();
    if (getSession()?.token !== token) return { ok: false, message: '别的页面里已经退出或换了账号，这里没有删' };
    if (currentUnsaved()) return { ok: false, message: UNSAVED_WHY };
    // 账号里有、这台设备上放不下没取回来的不算:删的是这台设备上的,它们在账号里好好的
    const failed = [...v.failed].filter(([id]) => localWorld(id));
    if (v.phase !== 'idle' || failed.length) {
      return { ok: false, message: failed.length ? `还有 ${failed.length} 个世界没同步上，现在删掉会丢：${v.message ?? failed[0][1]}` : (v.message ?? '没能同步，稍后再试') };
    }
    // 同步完以后又改了的(比如 AI 刚写完一段):没同步上,不删
    const st = readState();
    const left = storedIds().filter((id) => {
      const l = localWorld(id);
      return l && st?.worlds[id]?.sum !== l.sum;
    }).length;
    if (left) return { ok: false, message: `还有 ${left} 个世界刚改过、还没同步上，稍后再试` };
  }
  if (!keep) {
    // 先删再退出:等服务器回话的工夫退出窗已经关了,这期间新建、改的世界不能被后删掉
    applying = true;
    let gone: boolean;
    try {
      gone = removeAllWorlds();
      // 没删成:页面里的 AI 写的东西留着(有的只在页面里,浏览器存不下),不然之后同步会把账号里的清空
      if (gone) forgetNotes();
    } finally {
      applying = false;
    }
    // 浏览器不让删(存储突然不让用了之类):不退出,不然以为删干净了,刷新以后世界又都在。没删掉的同步记录还在,下次同步不会当成删了
    if (!gone) {
      // 删前每个世界都和账号里的一样(上面查过);现在不一样的 = 删了一部分又没能放回去(比如存档还在、AI 写的东西没了):
      // 不能当成在账号那份上改过、存上去盖掉完整的那份。记成"比账号里的旧"(STALE_REV),下次同步把完整的取回来
      const st = readState();
      if (st) {
        let hurt = false;
        for (const [id, k] of Object.entries(st.worlds)) {
          const l = localWorld(id);
          if (!l || k.sum === l.sum) continue;
          st.worlds[id] = { ...k, rev: STALE_REV, sum: l.sum, core: l.core };
          hurt = true;
        }
        if (hurt) {
          writeState(st);
          // 马上取回来,别等用户在缺了东西的那份上接着改
          requestSync('full');
        }
      }
      return { ok: false, message: '浏览器没让删掉这台设备上的世界，没有退出。可以选「留着」再退出' };
    }
    writeState(null);
    rejected.clear();
  }
  await logout();
  setView({ phase: 'off', busy: new Set(), failed: new Map(), message: undefined });
  return { ok: true };
}

/** 账号注销了:同步记录作废(这台设备上的世界不动) */
export function accountDeleted(): void {
  writeState(null);
  rejected.clear();
  setView({ phase: 'off', busy: new Set(), failed: new Map(), message: undefined, lastOk: null });
}

let started = false;

/** 开始同步(App 挂载时调一次;返回取消函数) */
export function startSync(): () => void {
  if (started) return () => {};
  started = true;
  setDeleteHook(onLocalDelete);
  const offSaves = subscribeSaves(() => {
    if (!applying) requestSync('push', 2000);
  });
  const offNotes = subscribeNotes(() => {
    if (!applying) requestSync('push', 2000);
  });
  const offLogin = onLogin(onLoggedIn);
  let lastToken = getSession()?.token ?? null;
  const offSession = onSessionChange(() => {
    const tok = getSession()?.token ?? null;
    if (tok === lastToken) return;
    const was = lastToken;
    lastToken = tok;
    if (!tok) {
      if (view.phase !== 'off') setView({ phase: 'off', busy: new Set(), failed: new Map(), message: undefined });
      return;
    }
    // 登录了、换了账号(别的标签页里也算):原来那个账号的同步状态不算了,这个账号从头全看一遍
    if (was) setView({ phase: 'idle', busy: new Set(), failed: new Map(), message: undefined, lastOk: null });
    requestSync('full', 0);
  });
  // 正在看的世界被别的设备改了、删了,先放着没做的:回到"我的世界"时再全看一遍
  const offStage = subscribeStage(() => {
    if (!pinnedSkipped || getStage().stage !== 'home' || !getSession()) return;
    pinnedSkipped = false;
    requestSync('full', 0);
  });
  let lastFocus = 0;
  const onFocus = () => {
    if (Date.now() - lastFocus < 10_000) return;
    lastFocus = Date.now();
    requestSync('full', 0);
  };
  const onVisible = () => document.visibilityState === 'visible' && onFocus();
  // 网连上了:不管刚才是不是因为切回来同步过(那次可能正因为断网没成),马上再来一遍
  const onOnline = () => requestSync('full', 0);
  const every = setInterval(() => {
    if (typeof document === 'undefined' || document.visibilityState !== 'hidden') requestSync('full', 0);
  }, 60_000);
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisible);
  }
  if (getSession()) {
    setView({ phase: 'idle' });
    requestSync('full', 1500);
  }
  return () => {
    started = false;
    setDeleteHook(null);
    offSaves();
    offNotes();
    offLogin();
    offSession();
    offStage();
    clearInterval(every);
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (typeof window !== 'undefined') {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisible);
    }
  };
}

/** 单测用:清掉内存里的状态 */
export function _resetSyncForTest(): void {
  memState = null;
  dirty = false;
  forkedFor.clear();
  active = null;
  cycleToken = null;
  rejected.clear();
  rejectedFor = null;
  behind = new Set();
  behindNow = new Set();
  roomMark = 0;
  lastAlive = new Set();
  offered.clear();
  uploading.clear();
  deletedWhileUp.clear();
  pinnedSkipped = false;
  running = null;
  again = null;
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  timerMode = null;
  afterRun.clear();
  view = { phase: 'off', busy: new Set(), failed: new Map(), lastOk: null };
}
