/**
 * 启动时把 AI 接入层接上(App 里调一次):登记三家服务商、恢复上次选的那家、调用记录改存本地、查一下我们 AI 的积分余额。
 */
import { registerProvider, setActiveProvider } from './client';
import { initCallLog } from './callLog';
import { getAiSettings } from './settings';
import { getSession } from '../account/session';
import { deepseekProvider } from './providers/deepseek';
import { bailianProvider } from './providers/bailian';
import { customProvider } from './providers/custom';
import { officialProvider, officialServer, refreshOfficialAccount } from './providers/official';

let done = false;

/** 测试用假 AI 能不能在设置里选:开发时、或网址带 ai=mock 时 */
export function mockSelectable(): boolean {
  if (import.meta.env?.DEV) return true;
  return typeof location !== 'undefined' && new URLSearchParams(location.search).get('ai') === 'mock';
}

export function setupAi(): void {
  if (done) return;
  done = true;
  registerProvider(officialProvider);
  registerProvider(deepseekProvider);
  registerProvider(bailianProvider);
  registerProvider(customProvider);
  const saved = getAiSettings().provider;
  setActiveProvider(saved === 'mock' && !mockSelectable() ? null : saved);
  void initCallLog();
  // 登录着网站账号:查一下积分(令牌过期的话顺便清掉)
  if (officialServer() && getSession()) void refreshOfficialAccount();
}
