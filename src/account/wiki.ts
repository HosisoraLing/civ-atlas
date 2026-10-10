import { dataStorage, prepareWikiStorage } from './wikiStorage';
import { refreshWikiSession } from './session';
import { call, ServerError } from './server';
import { clearToast, showToast } from '../ui/toastStore';
const SETTINGS = 'civ-atlas:ai-settings';
const ACK = 'wiki:preferences-ack';
interface Preferences { rev: number; settings: unknown }
/** Bootstrap finishes before any world loads or autosaves. */
export async function initializeWiki(): Promise<void> {
  const session = await refreshWikiSession();
  if (!session) throw new Error('请先登录 Wiki，再打开地图');
  const count = prepareWikiStorage(session.user.id);
  if (count) showToast({ id: 'wiki-import', kind: 'info', text: `正在将 ${count} 个浏览器存档迁移到服务器`, more: ['上传成功前保留本地副本'], ttl: 7000 });
  const token = session.token;
  const store = dataStorage()!;
  let remote: Preferences;
  try { remote = await call<Preferences>('/v1/preferences', { token }); }
  catch {
    showToast({ id: 'wiki-settings', kind: 'warn', text: '暂时无法读取服务器配置', more: ['地图和设置会在联网后重试'], ttl: 0 });
    startPreferences(token, null);
    return;
  }
  let ack: { rev: number; text: string | null } | null = null;
  try { ack = JSON.parse(store.getItem(ACK) ?? 'null'); } catch { /* Reimport old configuration. */ }
  const local = store.getItem(SETTINGS);
  // Pending edits remain on this device; save them with the known revision after startup.
  if (!(local && local !== ack?.text)) {
    if (remote.settings !== null) store.setItem(SETTINGS, JSON.stringify(remote.settings));
    else store.removeItem(SETTINGS);
    ack = { rev: remote.rev, text: store.getItem(SETTINGS) };
    store.setItem(ACK, JSON.stringify(ack));
  }
  startPreferences(token, remote);
}
function startPreferences(token: string, initial: Preferences | null) {
  const store = dataStorage()!;
  let running = false;
  let paused = false;
  let remote = initial;
  const sync = async () => {
    if (running || paused) return;
    running = true;
    try {
      remote ??= await call<Preferences>('/v1/preferences', { token });
      const text = store.getItem(SETTINGS);
      if (!text) return;
      const ack = JSON.parse(store.getItem(ACK) ?? 'null') as { rev: number; text: string } | null;
      if (text === ack?.text) return;
      const baseRev = ack?.rev ?? 0;
      const result = await call<{ rev: number }>('/v1/preferences', { method: 'PUT', token, body: { baseRev, settings: JSON.parse(text) } });
      store.setItem(ACK, JSON.stringify({ rev: result.rev, text }));
      remote = { rev: result.rev, settings: JSON.parse(text) };
      clearToast('wiki-settings');
    } catch (e) {
      if (e instanceof ServerError && e.status === 401) { paused = true; return; }
      if (e instanceof ServerError && e.code === 'conflict') {
        paused = true;
        showToast({ id: 'wiki-settings', kind: 'warn', text: 'AI 配置在另一台设备上改过', more: ['当前配置已保留，请选择要使用的版本'], ttl: 0,
          actions: [
            { label: '使用服务器配置', onClick: () => void call<Preferences>('/v1/preferences', { token }).then((r) => {
              if (r.settings !== null) store.setItem(SETTINGS, JSON.stringify(r.settings));
              else store.removeItem(SETTINGS);
              store.setItem(ACK, JSON.stringify({ rev: r.rev, text: store.getItem(SETTINGS) }));
              location.reload();
            }).catch(() => { paused = false; }) },
            { label: '保留当前配置', onClick: () => void call<Preferences>('/v1/preferences', { token }).then((r) => {
              store.setItem(ACK, JSON.stringify({ rev: r.rev, text: null }));
              paused = false;
              void sync();
            }).catch(() => { paused = false; }) },
          ] });
      } else showToast({ id: 'wiki-settings', kind: 'warn', text: '配置尚未保存到服务器', more: ['本地副本已保留，联网后自动重试'], ttl: 0 });
    } finally { running = false; }
  };
  setInterval(() => void sync(), 2000);
  window.addEventListener('online', () => void sync());
  void sync();
}
