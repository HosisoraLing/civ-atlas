/**
 * 界面里指向外面的几个固定网址(世界概览底部的一行小字、AI 设置里的说明)。
 *
 *   SOURCE_URL   源代码仓库(本项目按 AGPL-3.0 开源)
 *   PRIVACY_URL  隐私政策(public/privacy.html)
 *   TERMS_URL    用户协议(public/terms.html)
 *
 * 两个说明页是 public/ 里的静态网页,和地图放在同一个目录下,所以用相对地址(网站放在子目录里也能打开)。
 * 仓库地址改了的话,public/privacy.html、public/terms.html 里写死的仓库地址要一起改(冒烟检查会比对)。
 */
export const SOURCE_URL = 'https://github.com/HosisoraLing/civ-atlas';
export const PRIVACY_URL = './privacy.html';
export const TERMS_URL = './terms.html';
