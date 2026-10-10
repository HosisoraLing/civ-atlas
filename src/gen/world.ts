/**
 * 世界生成总流程。纯函数:同样的参数 → 同样的世界。
 *
 *   网格 → 板块 → 地壳抬升 → 河流侵蚀(中途按新地形重算一次降雨)
 *   → 换算成米(加上高原底座,底座顺水系让路)→ 湖泊 → 最终气候 → 水系 / 河流 → 生物群落
 *
 * 作者改过地形(阶段 4,terrain = WorldEdits.terrain)时,修改在对应的那一步套上(gen/terrainEdits.ts):
 * 火山、山脉、抬起 / 沉下在侵蚀之前改抬升场和海陆,湖在"随机洼地"那一步挖;之后照常侵蚀、排水、算气候。
 * 作者画过草图(新建世界时「画大陆和海」,sketch = gen/sketch.ts 的 sketchGrid 涂成的格子图)时,在板块定海陆那一步照草图改
 * (tectonics.ts 的 4b 步),山地格加抬升;地形修改再套在草图长出来的星球上。
 * 没有地形修改、没有草图时结果逐字节不变。
 */
import { buildMesh, type Mesh } from './mesh';
import { buildTectonics, plateCounts, type Tectonics } from './tectonics';
import { erode, drainage, accumulate } from './erosion';
import { computeClimate, type ClimateParams } from './climate';
import { classifyBiome } from './biomes';
import { computeSeaIce } from './seaice';
import { mulberry32, subSeed, clamp, keyed, smoothstep } from './util';
import { geometryOf, sphereSpacing } from './geometry';
import type { TerrainOp } from './edits';
import { computeCurrents, type Currents } from './currents';
import { TERRAIN_MAX_OPS, UPHEAVALS_MAX, UPHEAVAL_OPS_MAX, applyTerrainTectonics, carveLakes, carveRivers, cleanTerrainOps, volcanoPeaks } from './terrainEdits';
import { sketchUsed, type Sketch } from './sketch';

/**
 * 生成参数(滑条上的那些数)。世界是一整颗星球:东西无缝、有南北极,主图是等距圆柱投影
 */
export interface WorldParams {
  seed: number;
  /** 大约多少个地块(越多越细,越慢):整颗球的地块数 */
  cells: number;
  landFraction: number;
  /** 板块一共几块(有大有小:几块巨大的 + 许多小的;越多陆地越碎、岛越多) */
  plates: number;
  /** Optional explicit counts; older worlds keep the original random size distribution. */
  largePlates?: number;
  smallPlates?: number;
  mountains: number;
  temperature: number;
  rainfall: number;
}

export const DEFAULT_PARAMS: WorldParams = {
  seed: 1,
  cells: 36000,
  landFraction: 0.33,
  plates: 30,
  mountains: 1,
  temperature: 0,
  rainfall: 1,
};

/** 海拔 60 米以上的陆地块成为小洼地(小湖)中心的机会(大陆内部平缓以后天然的洼地少了,机会和大小都比以前大一些) */
const DENT_P = 1 / 600;

export const MAP_W = 2048;
export const MAP_H = 1024;

export interface River {
  /** 顶点坐标与该点流量(交错存:x,y,flux,...) */
  pts: Float32Array;
  /**
   * 河道经过的地块链,和 pts 的点一一对应(从源头到入海 / 入湖处)。
   * 链的头 / 尾是湖 / 海地块时,那个点是它和链上相邻地块的中点(入湖口 / 入海口),其余点是地块中心。
   * 画在任何投影上都按这条链取点(主图上的 x、y 跨 180° 经线时会跳到另一边)
   */
  cells: Int32Array;
}

export interface World {
  params: WorldParams;
  width: number;
  height: number;
  climate: ClimateParams;
  mesh: Mesh;
  tect: Tectonics;
  /** 海拔(米)。陆地正,海洋负 */
  elevation: Float32Array;
  /** 0 陆地 / 1 海洋 / 2 湖泊 */
  water: Uint8Array;
  /** 湖面高度(米),仅湖泊 cell 有意义 */
  waterLevel: Float32Array;
  temperature: Float32Array;
  precipitation: Float32Array;
  /** 海冰程度(每个地块 0–1):0 开阔水面,1 整片冰盖;陆地、湖泊为 0 */
  seaIce: Float32Array;
  /** 洋流:水温偏差和表层流向(见 currents.ts) */
  currents: Currents;
  biome: Uint8Array;
  /** 径流量(累计,单位 ≈ 地块 × 米/年) */
  flux: Float32Array;
  riverThreshold: number;
  rivers: River[];
  /** 侵蚀过程快照(米),用于"看世界长出来"回放 */
  history: Float32Array[];
  maxElevation: number;
  /** 作者放的火山(阶段 4 改地形):每座的峰顶地块,手绘风画火山符号;没有 = 空 */
  volcanoes: number[];
  /**
   * 生成时套上的地形修改(清理过,按先后);没改地形 = 不给。
   * 推文明时看它:改过地形的世界,扩张节拍按没改地形时的同一颗星球定(gen/civ/index.ts 的 planetTempo)
   */
  terrain?: TerrainOp[];
  /** 生成时照着的草图格子图(gen/sketch.ts 的 sketchGrid);没画 = 不给。草图算星球的一部分:planetTempo 也照它生成 */
  sketch?: Sketch;
}

export type Progress = (stage: string, pct: number) => void;

/** terrain:作者的地形修改(WorldEdits.terrain,按先后;不给 / 空 = 不改);sketch:草图涂成的格子图(不给 / null = 没画) */
export function generateWorld(params: WorldParams, progress: Progress = () => {}, terrain?: readonly TerrainOp[], sketch?: Sketch | null): World {
  const p = { ...DEFAULT_PARAMS, ...params };
  if (p.largePlates !== undefined || p.smallPlates !== undefined) Object.assign(p, plateCounts(p));
  // 地形修改 + 地形大事(upheaval.ts 生成大事以后的世界时接在后面)
  const ops = cleanTerrainOps(terrain ?? [], TERRAIN_MAX_OPS + UPHEAVALS_MAX * UPHEAVAL_OPS_MAX);
  const W = MAP_W;
  const H = MAP_H;
  const climateP: ClimateParams = {
    seed: p.seed,
    temperature: p.temperature,
    rainfall: p.rainfall,
  };

  progress('撒下地块', 0.02);
  const spacing = sphereSpacing(W, p.cells);
  const mesh = buildMesh(W, H, spacing, mulberry32(subSeed(p.seed, 'mesh')));
  const { n } = mesh;
  const geo = geometryOf(mesh);

  progress('板块漂移', 0.12);
  const sk = sketchUsed(sketch) ? sketch : null;
  const tect = buildTectonics(mesh, p, sk);
  // 改地形:火山、山脉、抬起 / 沉下 —— 侵蚀之前改抬升场和海陆(touched = 改过的地块)
  const land0 = ops.length ? tect.land.slice() : null;
  const touched = ops.length ? applyTerrainTectonics(mesh, tect, ops, p.seed) : null;
  const { land, uplift, oceanDepth, plateau } = tect;
  /** 改过的地块里原来是陆地的有几块(换算成米时当作排在最低处,见 toMeters) */
  let touchedLand = 0;
  if (touched && land0) for (let i = 0; i < n; i++) if (touched[i] && land0[i]) touchedLand++;

  // ---- 侵蚀 ----
  const h = new Float32Array(n);
  const hn = geo.fbm(subSeed(p.seed, 'h0'), 4);
  for (let i = 0; i < n; i++) if (land[i]) h[i] = 0.05 + 0.05 * (hn.atScale(i, 300) + 1);

  const waterOf = (i: number) => (land[i] ? 0 : 1);
  const water0 = new Uint8Array(n);
  for (let i = 0; i < n; i++) water0[i] = waterOf(i);

  const rainWeight = (elevM: Float32Array) => {
    const c = computeClimate(mesh, elevM, water0, climateP);
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = land[i] ? clamp(c.precipitation[i] / 1200, 0.1, 2.5) : 0;
    return w;
  };
  /** 侵蚀高度里"最高峰"取哪个值(换算成米时它对应 peak) */
  const refVals = new Float32Array(n);
  const refOf = (hh: Float32Array) => {
    let m = 0;
    // "最高峰"取样跳过改过的地块:一座大火山不会把全世界的山都压矮(改过的地块太多时照旧全取)。
    // 改过的地块里原来是陆地的,当作排在最低处照样算进名次(skip 块):取第几名和不改地形时一样,
    // 远处的山的海拔和不改时逐位相同(不然少了几块,"第 99.7% 那一名"挪一位,全世界的海拔都跟着差千分之一,别处的州、民族就会变)
    let skip = touchedLand;
    for (let i = 0; i < n; i++) if (land[i] && !touched?.[i]) refVals[m++] = hh[i];
    if (touched && m < 200) {
      m = 0;
      skip = 0;
      for (let i = 0; i < n; i++) if (land[i]) refVals[m++] = hh[i];
    }
    // 取第几小的值:hh 本来就是 32 位数,存进 Float32Array 原样不变,用类型化数组自带的数值排序(比带比较函数的快得多)
    const vals = refVals.subarray(0, m).sort();
    return vals[Math.max(0, Math.min(m - 1, Math.floor((m + skip) * 0.997) - skip))] || 1;
  };
  /**
   * 侵蚀高度 → 米。pk = 这一刻的"最高峰"(回放时从矮到高长);高原底座(base,米)按同样的进度一起长高
   */
  const toMeters = (hh: Float32Array, pk: number, base: Float32Array = plateau) => {
    const s = pk / refOf(hh);
    const knee = pk * 0.85;
    const grow = pk / peak;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      if (!land[i]) {
        out[i] = oceanDepth[i];
        continue;
      }
      // 超过"膝点"的极高峰压缩一半:避免出现离谱的万米高峰
      const e = hh[i] * s + base[i] * grow;
      out[i] = e > knee ? knee + (e - knee) * 0.45 : e;
    }
    return out;
  };
  const peak = 3600 + 1700 * clamp(p.mountains, 0, 2);

  const proxy = new Float32Array(n);
  for (let i = 0; i < n; i++) proxy[i] = land[i] ? uplift[i] * 2500 + plateau[i] : oceanDepth[i];
  let rain = rainWeight(proxy);

  const STEPS = 36;
  const history: Float32Array[] = [];
  const histGrow: number[] = [];
  const erosionP = { steps: STEPS / 2, dt: 0.9, K: 1, m: 0.5 };
  progress('造山与侵蚀', 0.2);
  erode(mesh, land, h, uplift, rain, erosionP, (s) => {
    progress('造山与侵蚀', 0.2 + (0.35 * s) / STEPS);
    if (s % 3 === 0) {
      const g = ((s + 1) / STEPS) ** 0.5;
      history.push(toMeters(h, peak * g));
      histGrow.push(g);
    }
  });
  rain = rainWeight(toMeters(h, peak));
  erode(mesh, land, h, uplift, rain, erosionP, (s) => {
    progress('造山与侵蚀', 0.2 + (0.35 * (s + STEPS / 2)) / STEPS);
    if (s % 3 === 0) {
      const g = ((s + 1 + STEPS / 2) / STEPS) ** 0.5;
      history.push(toMeters(h, peak * g));
      histGrow.push(g);
    }
  });

  // 高原底座是侵蚀之后直接加上的(平坦的高原,不被切成山地)。让它顺着侵蚀出来的水系"让路":
  // 沿水流往下游,底座不高于上游(加上地形本身的落差)—— 底座不会把河堵成一串湖;
  // 从低地流进高原的河在高原上切出一道峡谷。只看上游,改地形时远处不受影响
  const flow = drainage(mesh, land, h, 1e-5);
  const sFinal = peak / refOf(h);
  const base = plateau.slice();
  for (let a = flow.orderLen - 1; a >= 0; a--) {
    const i = flow.order[a];
    const r = flow.receiver[i];
    if (r < 0 || !land[r]) continue;
    const lim = base[i] + (flow.filled[i] - flow.filled[r]) * sFinal;
    if (base[r] > lim) base[r] = lim;
  }
  // 回放帧补上同样的峡谷(每帧的底座长到了那一刻的比例 histGrow)
  const cut: number[] = [];
  for (let i = 0; i < n; i++) if (base[i] !== plateau[i]) cut.push(i);
  for (let f = 0; f < history.length; f++) {
    const fr = history[f];
    const g = histGrow[f];
    for (const i of cut) fr[i] += (base[i] - plateau[i]) * g;
  }
  const elevation = toMeters(h, peak, base);
  history.push(elevation.slice());

  // ---- 湖泊:裂谷下陷 + 少量冰川 / 构造洼地 ----
  progress('湖泊与水系', 0.62);
  for (let i = 0; i < n; i++) {
    if (!land[i]) continue;
    const contF = tect.plateContinental[tect.plate[i]] ? 1 : 0.5;
    // 只在强的张裂带上挖;下挖不超过当地海拔的一半(低平原上的张裂带不会挖到海平面以下,积成一串贴着海的死水湖)
    const rift = 220 * contF * smoothstep(0.2, 0.65, tect.strengthDiv[i]) * Math.exp(-Math.pow(tect.distDiv[i] / 20, 2));
    elevation[i] -= Math.min(rift, 0.7 * Math.max(0, elevation[i]));
  }
  // 小洼地(之后积水成小湖):海拔 60 米以上的陆地块每块有 1/600 的机会是洼地中心,大小、深浅也按这块地取 ——
  // 按地块编号取随机数(和先后无关):改地形(海里冒出一座岛)时别处的洼地位置不变,远处的湖、河、气候、群落照旧
  const dentBase = subSeed(p.seed, 'lakes-at');
  let highLand = 0;
  const dents: number[] = [];
  for (let c = 0; c < n; c++) {
    if (!land[c] || !(elevation[c] > 60)) continue;
    highLand++;
    if (keyed(dentBase, c, 0) < DENT_P) dents.push(c);
  }
  for (const c of dents) {
    const r = spacing * (1.6 + keyed(dentBase, c, 1) * 2.8);
    const depth = 40 + keyed(dentBase, c, 2) * 160;
    // 只在附近 cell 上挖
    const r3 = r * 3;
    for (const i of geo.cellsNear(c, r3)) {
      if (!land[i]) continue;
      elevation[i] -= depth * Math.exp(-geo.near2(i, c, r3) / (r * r));
    }
  }
  // 改地形:作者挖的湖(碗形洼地,下面排水时灌满)
  const userLake = ops.length ? carveLakes(mesh, land, elevation, ops, p.seed) : null;
  // 改地形:作者画的河(沿线挖河谷,这一路一定画成河)
  const water0r = new Uint8Array(n);
  for (let i = 0; i < n; i++) water0r[i] = land[i] ? 0 : 1;
  const userRiver = ops.length ? carveRivers(mesh, water0r, elevation, ops) : null;
  const pool = drainage(mesh, land, elevation, 0);
  const water = new Uint8Array(n);
  const waterLevel = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (!land[i]) water[i] = 1;
    else if (pool.filled[i] - elevation[i] > 3) {
      water[i] = 2;
      waterLevel[i] = pool.filled[i];
    }
  }
  // 太大的湖(平原上的浅洼地被整片灌满)不自然:填成平地
  const maxLake = Math.max(40, Math.round(highLand * 0.004));
  const seen = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (water[i] !== 2 || seen[i]) continue;
    const comp = [i];
    seen[i] = 1;
    for (let q = 0; q < comp.length; q++) {
      const c = comp[q];
      for (let k = mesh.adjStart[c]; k < mesh.adjStart[c + 1]; k++) {
        const j = mesh.adj[k];
        if (water[j] === 2 && !seen[j]) {
          seen[j] = 1;
          comp.push(j);
        }
      }
    }
    if (comp.length > maxLake && !(userLake && comp.some((c) => userLake[c]))) {
      for (const c of comp) {
        water[c] = 0;
        elevation[c] = pool.filled[c] - 1;
      }
    }
  }

  // ---- 最终气候 ----
  progress('风与降水', 0.72);
  const currents = computeCurrents(mesh, water);
  const clim = computeClimate(mesh, elevation, water, climateP, currents);
  const seaIce = computeSeaIce(mesh, elevation, water, clim.temperature, clim.windX, clim.windY, p.seed);

  // ---- 水系 ----
  progress('河流', 0.82);
  const route = drainage(mesh, land, elevation, 1e-3);
  const runoff = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (!land[i]) continue;
    const pet = 250 + 22 * Math.max(0, clim.temperature[i]); // 粗略蒸散
    runoff[i] = Math.max(0.03, (clim.precipitation[i] - 0.45 * pet) / 1000);
  }
  const flux = accumulate(route, land, runoff, new Float32Array(n));
  const riverThreshold = 14 * (n / 36000);
  const rivers = traceRivers(mesh, land, water, route.receiver, flux, riverThreshold, userRiver);

  // ---- 生物群落 ----
  progress('生物群落', 0.9);
  const biome = new Uint8Array(n);
  let maxElevation = 0;
  for (let i = 0; i < n; i++) {
    biome[i] = classifyBiome(clim.temperature[i], clim.precipitation[i], water[i], seaIce[i]);
    if (land[i] && elevation[i] > maxElevation) maxElevation = elevation[i];
  }

  return {
    params: p,
    width: W,
    height: H,
    climate: climateP,
    mesh,
    tect,
    elevation,
    water,
    waterLevel,
    temperature: clim.temperature,
    precipitation: clim.precipitation,
    seaIce,
    currents,
    biome,
    flux,
    riverThreshold,
    rivers,
    history,
    maxElevation,
    volcanoes: ops.length ? volcanoPeaks(mesh, water, elevation, ops) : [],
    ...(ops.length ? { terrain: ops.slice() } : {}),
    ...(sk ? { sketch: sk } : {}),
  };
}

/** 把超过阈值的径流 cell 串成河道折线:从每条支流源头往下游走,遇到干流 / 湖 / 海就停。 */
function traceRivers(
  mesh: Mesh,
  land: Uint8Array,
  water: Uint8Array,
  receiver: Int32Array,
  flux: Float32Array,
  thr: number,
  forced: Uint8Array | null = null,
): River[] {
  const { n, x, y } = mesh;
  const geo = geometryOf(mesh);
  const m: number[] = [0, 0];
  const isRiver = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (water[i] === 0 && (flux[i] >= thr || forced?.[i])) isRiver[i] = 1;
  const hasRiverDonor = new Uint8Array(n);
  const lakeInlet = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const r = receiver[i];
    if (r < 0) continue;
    if (isRiver[i]) hasRiverDonor[r] = 1;
    else if (water[i] === 2 && isRiver[r]) lakeInlet[r] = i;
  }
  const sources: number[] = [];
  for (let i = 0; i < n; i++) if (isRiver[i] && !hasRiverDonor[i]) sources.push(i);
  sources.sort((a, b) => flux[b] - flux[a]);

  const visited = new Uint8Array(n);
  const rivers: River[] = [];
  // 另存地块链(和 pts 的点一一对应)
  const chain: number[] = [];
  for (const s of sources) {
    const pts: number[] = [];
    chain.length = 0;
    const li = lakeInlet[s];
    if (li >= 0) {
      geo.mid(li, s, m);
      pts.push(m[0], m[1], flux[s]);
      chain.push(li);
    }
    let i = s;
    visited[i] = 1;
    pts.push(x[i], y[i], flux[i]);
    chain.push(i);
    for (;;) {
      const r = receiver[i];
      if (r < 0) break;
      if (water[r] !== 0) {
        // 入海 / 入湖:停在两地块之间,大致就是岸线
        geo.mid(i, r, m);
        pts.push(m[0], m[1], flux[i]);
        chain.push(r);
        break;
      }
      pts.push(x[r], y[r], flux[r]);
      chain.push(r);
      if (visited[r]) break;
      visited[r] = 1;
      i = r;
    }
    if (pts.length >= 6) rivers.push({ pts: Float32Array.from(pts), cells: Int32Array.from(chain) });
  }
  return rivers;
}
