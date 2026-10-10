import { createRoot } from 'react-dom/client';
import { wikiMode } from './account/wikiStorage';
import './ui/app.css';
// 宽屏、手机的布局放在最后,盖过各处的默认样式
import './ui/desktop.css';
import './ui/phone.css';

const root = createRoot(document.getElementById('root')!);
async function start() {
  root.render(<div style={{ padding: 32 }}>{wikiMode() ? '正在读取服务器地图…' : '正在打开地图…'}</div>);
  try {
    if (wikiMode()) await (await import('./account/wiki')).initializeWiki();
    const { App } = await import('./ui/App');
    root.render(<App />);
  } catch (e) {
    root.render(<div style={{ padding: 32 }} role="alert"><p>{e instanceof Error ? e.message : '无法读取服务器数据'}</p>
      <button onClick={() => void start()}>重试</button> {wikiMode() && <a href="/" target="_top">返回 Wiki 登录</a>}</div>);
  }
}
void start();
