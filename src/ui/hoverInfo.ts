/**
 * 悬停小卡片的内容(界面骨架):只提示,不承担功能。
 *
 *   鼠标在城镇符号 / 城名、国名、地名上:这个东西的名字 + 一句("国都，约 3.2 万人""山脉")
 *   否则按时间轴当前这一年:有国家 → 国名 + 州数(民族图层:族名 + 所属国家;信仰图层:教名 + 所属国家);
 *   没有国家 → 有人住写族名 + "部落地带",没人住写州名 / 群落
 *   数据图层多一行数值(海拔、气温、降水、板块、群落)
 *   在地图上选干预目标时(国家面板):对象的名字 + "点击选择 / 不可选 / 本国";下了令正在推演时不显示
 */
import type { World } from '../gen/world';
import type { Raster } from '../gen/raster';
import type { Civ, Place } from '../gen/civ/types';
import { BIOMES } from '../gen/biomes';
import { ownersAt, type Owners } from '../gen/civ/timeline';
import { cultureLabel, regionLabel, regionNamed } from '../gen/civ/display';
import { faithAt } from '../gen/civ/religion';
import { SETTLEMENT_RANKS, capitalAt, polityAlive, polityName, populationAt, populationLabel, settlementRank } from '../gen/civ/growth';
import { latitudeAt } from '../gen/climate';
import type { LabelPick } from './mapPick';
import { layerDef, type MapLayer } from './mapLayers';
import { describeCiv } from './civDescribe';
import { formatLon, lonOfX } from './mapWrap';
import { VERDICT_TEXT, getPolityPick, pickVerdict, type PolityPick } from './Interventions';
import { getPanel } from './panelStore';

export interface HoverInfo {
  /** 颜色块(国家 / 民族的颜色) */
  color?: string;
  /** 宋体的名字 */
  name: string;
  /** 名字后面的小字 */
  sub?: string;
  /** 第二行(数据图层的数值) */
  extra?: string;
  /** 选目标时鼠标下的可选对象(国家 / 城的编号;不可选 = −1) */
  pick?: number;
}

const PLACE_KIND: Record<Place['kind'], string> = {
  sea: '海',
  mountains: '山脉',
  river: '河流',
  lake: '湖泊',
  island: '岛屿',
  desert: '荒漠',
};

const rgb = (c: readonly number[]) => `rgb(${c.join(',')})`;

let owners: Owners | undefined;
/** 各国这一年有几个州(同一个 civ、同一年只数一次) */
let counted: { civ: Civ; year: number; n: Int32Array } | null = null;

function regionCounts(civ: Civ, year: number, own: Owners): Int32Array {
  if (counted && counted.civ === civ && counted.year === year) return counted.n;
  const n = new Int32Array(civ.polities.length);
  for (let r = 0; r < civ.regions.count; r++) {
    const p = own.polity[r];
    if (p >= 0) n[p]++;
  }
  counted = { civ, year, n };
  return n;
}

/** 各州这一年信的教(同一个 civ、同一年只算一次) */
let faiths: { civ: Civ; year: number; f: Int16Array } | null = null;

function faithsAt(civ: Civ, year: number): Int16Array {
  if (faiths && faiths.civ === civ && faiths.year === year) return faiths.f;
  faiths = { civ, year, f: faithAt(civ, year, faiths?.f) };
  return faiths.f;
}

export function hoverInfo(p: {
  world: World;
  raster: Raster;
  civ: Civ | null;
  px: number;
  py: number;
  layer: MapLayer;
  /** 鼠标下的城镇符号 / 国名 / 地名 */
  label?: LabelPick | null;
  /** 时间轴当前的年份(null = 结束年份) */
  year: number | null;
}): HoverInfo | null {
  const { world, raster, civ, px, py, layer, label } = p;
  const k = py * raster.w + px;
  if (!(k >= 0 && k < raster.cell.length)) return null;
  const cell = raster.cell[k];
  const def = layerDef(layer);
  const year = civ ? Math.floor(Math.min(civ.endYear, Math.max(0, p.year ?? civ.endYear))) : 0;
  let info: HoverInfo | null = null;

  // 选干预目标:只说鼠标下的对象能不能选;下了令正在推演:不显示
  if (civ && getPanel().run) return null;
  const pk = civ ? getPolityPick() : null;
  if (civ && pk && cell >= 0) {
    const t = pickTarget(civ, pk, label ?? null, cell, year);
    if (t) return t;
  }

  if (civ && label) {
    if (label.kind === 'settlement' && civ.settlements[label.id]) {
      const s = civ.settlements[label.id];
      const pop = populationAt(s, year);
      const capital = pop > 0 && civ.polities.some((q) => polityAlive(q, year) && capitalAt(q, year) === s.id);
      info = { name: s.name, sub: pop > 0 ? `${capital ? '国都' : SETTLEMENT_RANKS[settlementRank(pop)].name}，${populationLabel(pop)}` : '故城遗址' };
    } else if (label.kind === 'polity' && civ.polities[label.id] && civ.cultures.length) {
      const po = civ.polities[label.id];
      owners = ownersAt(civ, year, owners);
      info = { color: rgb(po.color), name: polityName(po, year), sub: `${regionCounts(civ, year, owners)[po.id]} 州` };
    } else if (label.kind === 'place' && civ.places[label.id]) {
      const pl = civ.places[label.id];
      const n = pl.defaultName ?? pl.name;
      info = { name: pl.name, sub: pl.kind === 'sea' ? (n.endsWith('洋') ? '大洋' : n.endsWith('湾') ? '海湾' : '海') : PLACE_KIND[pl.kind] };
    }
  }

  if (!info && civ && cell >= 0 && cell < civ.regions.of.length) {
    const r = civ.regions.of[cell];
    if (r >= 0 && civ.cultures.length) {
      owners = ownersAt(civ, year, owners);
      const po = owners.polity[r] >= 0 ? civ.polities[owners.polity[r]] : undefined;
      const cu = owners.culture[r] >= 0 ? civ.cultures[owners.culture[r]] : undefined;
      const fa = def.faiths && civ.religion ? civ.religion.faiths[faithsAt(civ, year)[r]] : undefined;
      if (fa) info = { color: rgb(fa.color), name: fa.name, sub: po ? polityName(po, year) : '部落地带' };
      else if (def.cultures && !def.polities && cu) info = { color: rgb(cu.color), name: cultureLabel(cu), sub: po ? polityName(po, year) : '部落地带' };
      else if (po) info = { color: rgb(po.color), name: polityName(po, year), sub: `${regionCounts(civ, year, owners)[po.id]} 州` };
      else if (cu) info = { color: rgb(cu.color), name: cultureLabel(cu), sub: '部落地带' };
    }
    if (!info && r >= 0 && (regionNamed(civ, r) || civ.regionNames?.[r])) info = { name: regionLabel(civ, r) };
  }

  const biome = BIOMES[raster.biome[k]]?.name ?? '';
  if (!info) info = { name: biome };

  if (def.style === 'data') {
    const e = Math.round(raster.elev[k]);
    const water = raster.water[k] === 1;
    switch (def.data) {
      case 'elevation':
        info.extra = water ? `水深 ${(-e).toLocaleString()} 米` : `海拔 ${e.toLocaleString()} 米`;
        break;
      case 'temperature':
        info.extra = `年均温 ${raster.temp[k].toFixed(1)}°C`;
        break;
      case 'precipitation':
        info.extra = `年降水 ${Math.round(raster.precip[k])} mm`;
        break;
      case 'currents': {
        const d = world.currents.sst[cell];
        if (water && Math.abs(d) >= 0.5) info.extra = `${d > 0 ? '暖流' : '寒流'}，水温比同纬度${d > 0 ? '高' : '低'} ${Math.abs(d).toFixed(1)}°C`;
        break;
      }
      case 'plates': {
        const plate = world.tect.plate[cell];
        info.extra = plate === undefined ? '' : `${world.tect.plateSmall ? world.tect.plateSmall[plate] ? '小型' : '大型' : ''}${world.tect.plateContinental[plate] ? '大陆' : '大洋'}板块 #${plate + 1}`;
        break;
      }
      default:
        if (info.name !== biome) info.extra = biome;
    }
    if (!info.extra) delete info.extra;
  }
  return info.name ? info : null;
}

/** 选目标时鼠标下的对象(国家 / 城)和"点击选择 / 不可选 / 本国";鼠标下没有这类对象 = null */
function pickTarget(civ: Civ, pk: PolityPick, label: LabelPick | null, cell: number, year: number): HoverInfo | null {
  const r = cell < civ.regions.of.length ? civ.regions.of[cell] : -1;
  if (pk.target === 'settlement') {
    let sid = label?.kind === 'settlement' ? label.id : -1;
    if (sid < 0 && r >= 0) sid = civ.settlements.find((s) => s.region === r && s.founded <= year && (s.ended === undefined || s.ended > year))?.id ?? -1;
    const s = civ.settlements[sid];
    if (!s) return null;
    const v = pickVerdict(pk, sid);
    return { name: s.name, sub: VERDICT_TEXT[v], pick: v === 'ok' ? sid : -1 };
  }
  let id = label?.kind === 'polity' ? label.id : -1;
  if (id < 0 && r >= 0) {
    owners = ownersAt(civ, year, owners);
    id = owners.polity[r];
  }
  const po = civ.polities[id];
  if (!po) return null;
  const v = pickVerdict(pk, id);
  return { color: rgb(po.color), name: polityName(po, year), sub: VERDICT_TEXT[v], pick: v === 'ok' ? id : -1 };
}

/**
 * 某一点的完整读数(群落、海拔 / 水深、气温降水、经纬度、板块 + 国家、最近城市、民族、州、宜居度)。
 * 界面上的悬停卡片只露一两行;这份给冒烟检查、截图脚本用(window.__wfProbe)
 */
export function probeLines(world: World, r: Raster, civ: Civ | null, px: number, py: number): string[] {
  const k = py * r.w + px;
  const c = r.cell[k];
  const lat = latitudeAt(py / r.scale, world.height);
  const latS = `${Math.abs(lat).toFixed(0)}°${lat >= 0 ? 'N' : 'S'}`;
  const e = Math.round(r.elev[k]);
  const plate = world.tect.plate[c];
  const lines = [BIOMES[r.biome[k]].name];
  lines.push(r.water[k] === 1 ? `水深 ${(-e).toLocaleString()} 米` : `海拔 ${e.toLocaleString()} 米`);
  lines.push(`年均温 ${r.temp[k].toFixed(1)}°C · 年降水 ${Math.round(r.precip[k])} mm`);
  lines.push(`纬度 ${latS} · 经度 ${formatLon(lonOfX((px + 0.5) / r.scale, world.width))} · ${world.tect.plateContinental[plate] ? '大陆' : '大洋'}板块 #${plate + 1}`);
  return [...lines, ...describeCiv(civ, c)];
}
