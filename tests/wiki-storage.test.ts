import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { makeSave } from '../src/gen/savefile';
import { DEFAULT_PARAMS } from '../src/gen/world';
import { EMPTY_EDITS } from '../src/gen/edits';
import { dataStorage, prepareWikiStorage, acknowledgeMigration, storageEventKey } from '../src/account/wikiStorage';
import * as saves from '../src/ui/saveStore';
import { setServerForTest, call } from '../src/account/server';
import { _resetSessionForTest, refreshWikiSession, sessionExpired, getSession } from '../src/account/session';
import { _resetSyncForTest, startSync, syncNow, worldSync } from '../src/account/sync';
import { forgetNotes, putNote } from '../src/ai/library';
class StorageMock implements Storage {
  map = new Map<string, string>();
  get length() { return this.map.size; }
  key(i: number) { return [...this.map.keys()][i] ?? null; }
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
  removeItem(k: string) { this.map.delete(k); }
  clear() { this.map.clear(); }
}
let disk: StorageMock;
let stop: (() => void) | undefined;
let cloud: Map<string, any>;
const file = () => makeSave(DEFAULT_PARAMS, EMPTY_EDITS, 'test', '迁移测试');
const id = 'wtest123';
beforeEach(() => {
  vi.stubEnv('VITE_WIKI_STORAGE', 'true');
  disk = new StorageMock();
  vi.stubGlobal('localStorage', disk);
  cloud = new Map();
  setServerForTest(undefined);
  saves._resetForTest(); _resetSessionForTest(); _resetSyncForTest(); forgetNotes();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const p = url.replace('/api/v1/civ-atlas', '');
    const response = (v: any, status = 200) => new Response(JSON.stringify(v), { status });
    if (p === '/v1/me') return response({ user: { id: 'alpha', account: 'Alpha' } });
    if (p === '/v1/worlds') return response({ worlds: [...cloud].map(([id,w]) => ({id,rev:w.rev})) });
    const key = p.split('/').at(-1)!;
    if (init?.method === 'PUT') {
      const body = JSON.parse(init.body as string);
      const w = cloud.get(key);
      if ((w?.rev ?? 0) !== body.baseRev) return response({error:{code:'conflict',rev:w.rev}},409);
      cloud.set(key, { ...body, rev: (w?.rev ?? 0) + 1, id: key });
      return response({ rev: cloud.get(key).rev });
    }
    return cloud.has(key) ? response(cloud.get(key)) : response({error:{code:'not-found'}},404);
  }));
});
afterEach(() => { stop?.(); stop = undefined; vi.unstubAllGlobals(); vi.unstubAllEnvs(); setServerForTest(undefined); });
it('imports old saves, notes, assistant and credentials into only the first Wiki account', () => {
  disk.setItem('wenming-ditu:world:'+id, JSON.stringify(file()));
  disk.setItem('wenming-ditu:assistant:'+id, '{"gen":5,"turns":[]}');
  disk.setItem('civ-atlas:ai-secrets', '{"deepseek":"test-only"}');
  expect(prepareWikiStorage('alpha')).toBe(1);
  expect(dataStorage()!.getItem('wenming-ditu:assistant:'+id)).toContain('turns');
  expect(disk.getItem('wenming-ditu:world:'+id)).not.toBeNull();
  prepareWikiStorage('beta');
  expect(dataStorage()!.getItem('wenming-ditu:world:'+id)).toBeNull();
  expect(dataStorage()!.getItem('civ-atlas:ai-secrets')).toBeNull();
  prepareWikiStorage('alpha');
  expect(dataStorage()!.getItem('wenming-ditu:world:'+id)).not.toBeNull();
});
it('never reimports deleted cached worlds from a retained original', () => {
  disk.setItem('wenming-ditu:world:'+id, JSON.stringify(file()));
  prepareWikiStorage('alpha');
  dataStorage()!.removeItem('wenming-ditu:world:'+id);
  expect(prepareWikiStorage('alpha')).toBe(0);
  expect(dataStorage()!.getItem('wenming-ditu:world:'+id)).toBeNull();
});
it('only removes the migration source after the acknowledged save and chat match', () => {
  const text = JSON.stringify(file());
  disk.setItem('wenming-ditu:world:'+id,text);
  const chat = {gen:5,turns:[]};
  disk.setItem('wenming-ditu:assistant:'+id,JSON.stringify(chat));
  prepareWikiStorage('alpha');
  acknowledgeMigration(id,text+' ',chat,[]);
  expect(disk.getItem('wenming-ditu:world:'+id)).toBe(text);
  acknowledgeMigration(id,text,null,[]);
  expect(disk.getItem('wenming-ditu:world:'+id)).toBe(text);
  acknowledgeMigration(id,text,chat,[]);
  expect(disk.getItem('wenming-ditu:world:'+id)).toBeNull();
  expect(dataStorage()!.getItem('wenming-ditu:world:'+id)).toBe(text);
});
it('filters other-account storage events', () => {
  prepareWikiStorage('alpha');
  expect(storageEventKey('civ-atlas:wiki:beta:wenming-ditu:world:'+id)).toBeUndefined();
  expect(storageEventKey('civ-atlas:wiki:alpha:wenming-ditu:world:'+id)).toBe('wenming-ditu:world:'+id);
});
it('uses HttpOnly cookies and binds every storage request to the account ID', async () => {
  await call('/v1/worlds',{token:'wiki:alpha'});
  const init = vi.mocked(fetch).mock.calls[0][1]!;
  expect(init.credentials).toBe('same-origin');
  expect(init.headers).toMatchObject({'X-Civ-Atlas-User':'alpha'});
  expect(init.headers).not.toHaveProperty('Authorization');
});
it('migrates complete world data and restores it on a fresh device', async () => {
  const text = JSON.stringify(file());
  const chat = {gen:5, turns:[{id:1,text:'创作对话'}]};
  disk.setItem('wenming-ditu:world:'+id,text);
  disk.setItem('wenming-ditu:assistant:'+id,JSON.stringify(chat));
  prepareWikiStorage('alpha');
  await refreshWikiSession(); stop = startSync();
  putNote(id,{key:'history',kind:'history',title:'历史',text:'创作笔记',createdAt:new Date().toISOString(),provider:'mock',model:'mock'});
  await syncNow();
  expect(cloud.get(id).save.title).toBe('迁移测试');
  expect(cloud.get(id).assistant).toEqual(chat);
  expect(cloud.get(id).notes[0].text).toBe('创作笔记');
  expect(worldSync(id)?.state).toBe('synced');
  expect(disk.getItem('wenming-ditu:world:'+id)).toBeNull();
  stop(); stop = undefined;
  vi.stubGlobal('localStorage', new StorageMock());
  saves._resetForTest(); _resetSessionForTest(); _resetSyncForTest(); forgetNotes();
  prepareWikiStorage('alpha'); await refreshWikiSession(); stop=startSync();
  await syncNow();
  expect(saves.loadWorld(id)?.save.title).toBe('迁移测试');
  expect(saves.rawWorld(id)?.assistant).toEqual(chat);
});
it('retains originals when upload fails and retries when connectivity returns', async () => {
  disk.setItem('wenming-ditu:world:'+id,JSON.stringify(file()));
  prepareWikiStorage('alpha'); await refreshWikiSession(); stop=startSync();
  const fetcher=fetch;
  vi.stubGlobal('fetch',vi.fn(async()=>{throw new Error('offline');}));
  await syncNow();
  expect(disk.getItem('wenming-ditu:world:'+id)).not.toBeNull();
  vi.stubGlobal('fetch',fetcher);
  await syncNow();
  expect(cloud.has(id)).toBe(true);
});

it('reloads before accepting another account even after the old session expires', async () => {
  prepareWikiStorage('alpha'); await refreshWikiSession();
  sessionExpired('wiki:alpha');
  const reload=vi.fn(); vi.stubGlobal('location',{reload});
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({user:{id:'beta',account:'Beta'}}))));
  expect(await refreshWikiSession()).toBeNull();
  expect(reload).toHaveBeenCalledOnce();
  expect(getSession()).toBeNull();
});
