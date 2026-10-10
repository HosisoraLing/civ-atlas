/**
 * 板块构造:决定大陆在哪、山脉往哪个方向长、海底哪里深哪里浅。
 * 目标是"一颗星球",不是"一张地区图":几块大小悬殊的大陆 + 中等陆块 + 成串成片的小岛,
 * 大陆内部大多平缓、山脉是窄长的几条,海底有洋中脊、海沟、深海平原和宽窄不一的大陆架。
 *
 * 1. 撒 K 个板块种子,按"带噪声的距离"长成不规则板块;每块的生长速度不同(对数正态),
 *    所以板块有大有小(像地球:几块巨大的 + 许多小板块)。再把板块图整个扭曲一遍(多尺度 domain warp),
 *    边界成了各个尺度都弯弯曲曲的线;扭出来的碎片并回邻居
 * 2. 每个板块随机给一个漂移速度、一个"密度"(大洋板块相撞时密度大的俯冲下去)。
 *    板块绕一根"欧拉轴"转动(质心处是这个速度,再带一点绕质心的自转),各处的速度方向跟着转;
 *    挑大陆:2~5 个大陆核心各按不同的目标大小沿板块邻接往外长(大小悬殊),另挑 1~3 块孤立的小板块当"微大陆"
 *    (露出水面的是马达加斯加、新西兰那样的大岛),0~2 块大洋板块当"群岛区";
 *    约一半的世界在一极放一块极地大陆(像南极洲:最后一块大陆的核心是极点所在的板块,围着极点长),
 *    其余的大陆、微大陆、群岛区少往两极长 —— 没有极地大陆的世界两极大多是海
 * 3. 相邻板块(在边界那个地块处的速度之差)迎面撞 = 汇聚边界,背向分开 = 离散边界。汇聚边界分三种:
 *    大洋俯冲到大陆下(海沟 + 陆上火山山脉,像安第斯)、大洋俯冲到大洋下(海沟 + 弧形岛链,像日本、阿留申)、
 *    大陆撞大陆(宽一些的山脉 + 一侧的高原,像喜马拉雅—青藏)
 * 4. 陆地场 = 地壳底色(到"大陆 / 大洋"分界的带符号距离;被动大陆边缘 —— 分界处两板块背向分开 —— 海岸往大陆里缩,
 *    中间是一片大陆架和洋中脊之间的大洋)+ 多尺度海岸噪声(几百像素的半岛海湾 → 几像素的破碎)
 *    + 碰撞带 / 岛弧 / 热点岛链 / 群岛 - 大陆张裂带 - 内海(世界没有边,两极就是普通的地方,极地板块也能长大陆);
 *    再按目标陆地比例取阈值
 * 5. 海底深度:按离洋中脊多远定"洋壳年龄"(越老越深:脊顶约 -2600 米 → 深海平原 -5000 多米),
 *    俯冲带外侧窄窄一道海沟(-7000 ~ -9000 米),岛弧、热点处海底隆起;离岸一段是大陆架(被动边缘宽,俯冲带一侧窄)
 * 6. 抬升场 = 很低的基础抬升(大部分陆地是平原)+ 零星的丘陵区 + 汇聚带上窄窄的山脉 + 古老山系(细长的山脊噪声),
 *    交给侵蚀去"雕刻";高原底座(米)单独给出:侵蚀之后直接加上(平坦的高原,不被切成山地)
 *
 * 所有随机数来自 subSeed(seed, '…'),超越函数的结果舍入到 24 位(round24),任何电脑上逐位一致。
 */
import { blurField, type Mesh } from './mesh';
import { MinHeap, smoothstep, subSeed, mulberry32, clamp, hypot2, keyed } from './util';
import { geometryOf } from './geometry';
import { round24 } from './civ/rand';
import { SKETCH_HILLS, SKETCH_ISLES, SKETCH_LAND, SKETCH_MOUNTAIN, SKETCH_NONE, SKETCH_PLATEAU, SKETCH_SHELF, sketchAt, sketchUsed, type Sketch } from './sketch';

export interface TectonicParams {
  seed: number;
  plates: number;
  largePlates?: number;
  smallPlates?: number;
  landFraction: number;
  mountains: number;
}

export const PLATE_COUNT_KEYS = ['largePlates', 'smallPlates'] as const;

/** Missing fields retain the old generator; these defaults are used only when editing counts. */
export function plateCounts(p: Pick<TectonicParams, 'plates' | 'largePlates' | 'smallPlates'>) {
  const total = Number.isFinite(p.plates) ? clamp(Math.round(p.plates), 2, 64) : 30;
  const largePlates = Number.isFinite(p.largePlates) ? clamp(Math.round(p.largePlates!), 2, 32) : Math.max(2, Math.ceil(total / 3), total - 32);
  const smallPlates = Number.isFinite(p.smallPlates) ? clamp(Math.round(p.smallPlates!), 0, 32) : clamp(total - largePlates, 0, 32);
  return { largePlates, smallPlates, plates: largePlates + smallPlates };
}

export interface Tectonics {
  plateCount: number;
  /** Explicit size class, 0 = large, 1 = small; absent for older worlds. */
  plateSmall?: Uint8Array;
  plate: Int16Array;
  /** 每个板块在自己质心处的漂移速度(东、南分量) */
  plateVx: Float32Array;
  plateVy: Float32Array;
  /**
   * 每个板块绕欧拉轴转动的角速度向量 ω(交错存 x, y, z),地块 p 处的速度 = ω × p
   * (见 geometry.ts 的 PlateMotion)
   */
  plateOmega: Float32Array;
  plateContinental: Uint8Array;
  /** 每个 cell 的板块边界汇聚强度(正 = 碰撞,负 = 张裂,0 = 不在边界) */
  convergence: Float32Array;
  distConv: Float32Array;
  strengthConv: Float32Array;
  distDiv: Float32Array;
  strengthDiv: Float32Array;
  /** 1 = 陆地 */
  land: Uint8Array;
  /** 海底深度(米,负数);陆地 cell 为 0 */
  oceanDepth: Float32Array;
  /** 陆地抬升速率(无量纲) */
  uplift: Float32Array;
  /**
   * 高原底座(米,≥ 0):侵蚀之后直接加到陆地海拔上的平缓抬高(碰撞带后面的高原、大陆内部的台地);
   * 海里为 0。换算成米时按回放进度一起长高(world.ts 的 toMeters)
   */
  plateau: Float32Array;
}

/** distanceField 的运行计数(单测用):出堆次数、真正往外扩展的次数、跳过的过期条目数。 */
export interface DistanceFieldStats {
  pops: number;
  expanded: number;
  stale: number;
}

/** exp 舍入到 24 位:不同 CPU / 引擎上最后一位的差别不会漏进世界里(见 civ/rand.ts 的 round24) */
const fexp = (v: number) => round24(Math.exp(v));
const ftanh = (v: number) => round24(Math.tanh(v));
/** 高斯带 exp(−(d/w)²) */
function band(d: number, w: number): number {
  const t = d / w;
  return t > 4 || t < -4 ? 0 : fexp(-t * t);
}

/**
 * 多源 Dijkstra:从 sources 出发,返回每个 cell 到最近源的距离、该源携带的强度,以及最近的是哪个源(src,地块编号)。
 *
 * 距离在内部一律用 Float64,和堆里的优先级同一精度。旧版 dist 是 Float32Array:
 * 存进去时被舍入到 32 位,一旦向下舍入,出堆时 `d > dist[i]` 就把这个点误判成"过期"跳过,
 * 它不再往外扩展 —— 约一半的点就这样被跳过,距离系统性偏长,还有一两成地块根本到不了(= 无穷远)。
 * 返回给调用方的 dist 再转成 Float32(Tectonics 里存的是 32 位)。
 */
export function distanceField(
  mesh: Mesh,
  sources: number[],
  strengthOf: (i: number) => number,
  stats?: DistanceFieldStats,
) {
  const { n, adjStart, adj } = mesh;
  const elen = geometryOf(mesh).edgeLengths();
  const dist = new Float64Array(n).fill(Infinity);
  const str = new Float32Array(n);
  const src = new Int32Array(n).fill(-1);
  const heap = new MinHeap(n);
  for (const s of sources) {
    dist[s] = 0;
    str[s] = strengthOf(s);
    src[s] = s;
    heap.push(s, 0);
  }
  let pops = 0;
  let stale = 0;
  while (heap.size) {
    const i = heap.pop();
    const d = heap.lastPri;
    pops++;
    // 同精度比较:只有"之后又找到更短的路"留下的旧条目才会大于 dist[i]
    if (d > dist[i]) {
      stale++;
      continue;
    }
    for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
      const j = adj[k];
      const nd = d + elen[k];
      if (nd < dist[j]) {
        dist[j] = nd;
        str[j] = str[i];
        src[j] = src[i];
        heap.push(j, nd);
      }
    }
  }
  if (stats) {
    stats.pops = pops;
    stats.stale = stale;
    stats.expanded = pops - stale;
  }
  return { dist: Float32Array.from(dist), str, src };
}

/** Fisher–Yates 洗牌:只用传入的 rng,任何浏览器结果都一样(sort + 随机比较函数做不到)。 */
function shuffle<T>(arr: T[], rng: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}

/** 近似标准正态(三个均匀数之和) */
const gauss = (rng: () => number) => (rng() + rng() + rng() - 1.5) * 2;

/** 各块大陆的目标大小(相对值,第一块最大):大小悬殊,像地球的七大洲(最大的约是最小的五六倍) */
const CONTINENT_WEIGHTS = [1, 0.62, 0.44, 0.33, 0.25];

/**
 * 同一个板块被扭成几片时,除了最大的那片,其余的并进和它接壤最长的邻居板块(做两遍,连环的碎片也并干净)。
 * 保证每个板块是连成一片的。
 */
function mergeFragments(mesh: Mesh, plate: Int16Array, P: number) {
  const { n, adjStart, adj } = mesh;
  const comp = new Int32Array(n);
  for (let pass = 0; pass < 2; pass++) {
    comp.fill(-1);
    const compSize: number[] = [];
    const compPlate: number[] = [];
    const q: number[] = [];
    for (let i = 0; i < n; i++) {
      if (comp[i] >= 0) continue;
      const id = compSize.length;
      const pk = plate[i];
      q.length = 0;
      q.push(i);
      comp[i] = id;
      for (let h = 0; h < q.length; h++) {
        const c = q[h];
        for (let k = adjStart[c]; k < adjStart[c + 1]; k++) {
          const j = adj[k];
          if (comp[j] < 0 && plate[j] === pk) {
            comp[j] = id;
            q.push(j);
          }
        }
      }
      compSize.push(q.length);
      compPlate.push(pk);
    }
    const main = new Int32Array(P).fill(-1);
    for (let c = 0; c < compSize.length; c++) {
      const pk = compPlate[c];
      if (main[pk] < 0 || compSize[c] > compSize[main[pk]]) main[pk] = c;
    }
    // 每片碎片:数一数它和各邻居板块接壤多少边
    const target = new Int32Array(compSize.length).fill(-1);
    const votes = new Map<number, number>();
    let any = false;
    for (let c = 0; c < compSize.length; c++) if (main[compPlate[c]] !== c) any = true;
    if (!any) return;
    const cellsOf: number[][] = compSize.map(() => []);
    for (let i = 0; i < n; i++) if (main[compPlate[comp[i]]] !== comp[i]) cellsOf[comp[i]].push(i);
    for (let c = 0; c < compSize.length; c++) {
      if (main[compPlate[c]] === c) continue;
      votes.clear();
      for (const i of cellsOf[c]) {
        for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
          const pj = plate[adj[k]];
          if (pj !== compPlate[c]) votes.set(pj, (votes.get(pj) ?? 0) + 1);
        }
      }
      let best = -1;
      let bv = -1;
      for (const [pj, v] of votes) if (v > bv || (v === bv && pj < best)) (bv = v), (best = pj);
      target[c] = best;
    }
    for (let i = 0; i < n; i++) {
      const t = target[comp[i]];
      if (t >= 0) plate[i] = t;
    }
  }
}

/**
 * 极地大陆:这么多的世界(按种子)在一极放一块极地大陆(见 pickContinents)。
 * 没有它的世界,别的陆块偶尔也会伸到极地(大陆边缘、岛弧),所以统计下来"有一块极地大陆"的世界约一半
 * (npx tsx scripts/gen-stats.ts polar=40 可以看)
 */
const POLAR_CONTINENT_P = 0.4;
/** 板块质心的纬度超过这么多度算"极地板块" */
const POLAR_LAT = 58;
/** 极地大陆要盖住的极冠:纬度超过这么多度的地方(占得多的板块都并进极地大陆) */
const POLAR_CAP = 72;

/**
 * 挑大陆板块:先随机定 2~5 个"大陆核心"(彼此尽量远),每块大陆有自己的目标大小(大小悬殊),
 * 沿板块邻接关系往外长,尽量不和别的大陆贴上。
 * 再挑 1~3 块孤立的小板块当"微大陆",0~2 块大洋板块当"群岛区"(海底浅,冒出成片小岛)。
 * pole = 1 / −1:在北极 / 南极放一块极地大陆(最后一块大陆的核心是极点所在的板块,围着极点往外长);0 = 不放。
 * 除了这块极地大陆,极地板块(质心纬度超过 POLAR_LAT)不当大陆核心、微大陆、群岛区,别的大陆也少往那里长
 */
function pickContinents(
  mesh: Mesh,
  plate: Int16Array,
  P: number,
  area: Float32Array,
  cen: { x: Float32Array; y: Float32Array },
  landFraction: number,
  rng: () => number,
  pole: number,
) {
  const { n, adjStart, adj, width: W } = mesh;
  const geo = geometryOf(mesh);
  // 板块之间的接壤长度(按边数)与板块质心
  const shared = new Float32Array(P * P);
  for (let i = 0; i < n; i++) {
    const a = plate[i];
    for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
      const b = plate[adj[k]];
      if (b !== a) shared[a * P + b]++;
    }
  }
  const { x: cx, y: cy } = cen;
  const avg = n / P;
  // 大陆板块要比目标陆地多出一截:被动大陆边缘的海岸会往里缩(那一圈是大陆架)
  const target = n * clamp(landFraction * 1.3, 0.08, 0.92);
  const r = rng();
  let C = r < 0.12 ? 2 : r < 0.45 ? 3 : r < 0.82 ? 4 : 5;
  C = Math.max(1, Math.min(C, Math.floor(P / 3), Math.floor(target / (avg * 0.7))));
  const weight = CONTINENT_WEIGHTS.slice(0, C).map((w) => w * (0.8 + 0.4 * rng()));
  // 每块大陆一个"长轴"方向:沿长轴方向的板块更容易并进来,大陆长成狭长的一条(像美洲)而不是一团
  const axX: number[] = [];
  const axY: number[] = [];
  for (let c = 0; c < C; c++) {
    const a = rng() * Math.PI;
    axX.push(round24(Math.cos(a)));
    axY.push(round24(Math.sin(a)));
  }
  const core: number[] = [];

  const owner = new Int16Array(P).fill(-1); // 属于哪块大陆
  const contArea: number[] = [];
  // 极地板块;极地大陆是第几块(最后一块:目标大小偏小,像南极洲;只有一块大陆的世界不放)
  const { height: H } = mesh;
  const latOf = (k: number) => 90 - (180 * cy[k]) / H;
  const polar = (k: number) => Math.abs(latOf(k)) > POLAR_LAT;
  const polarC = pole !== 0 && C >= 2 ? C - 1 : -1;
  const touchesOther = (k: number, c: number) => {
    for (let b = 0; b < P; b++) if (shared[k * P + b] > 0 && owner[b] >= 0 && owner[b] !== c) return true;
    return false;
  };
  let total = 0;
  // 1) 定核心:第一块随便挑,之后的离已有大陆越远越好;大陆核心挑够大的板块
  const order = shuffle(Array.from({ length: P }, (_, k) => k), rng);
  for (let c = 0; c < C; c++) {
    let best = -1;
    let bestScore = -Infinity;
    if (c === polarC) {
      // 极地大陆的核心:极点所在的板块(再小也行,之后围着极点往外长);它已经是别的大陆了就挑质心离极点最近的够大的板块
      const atPole = plate[geo.nearest(W / 2, pole > 0 ? 0 : H, 0)];
      if (owner[atPole] < 0) best = atPole;
      else
        for (const k of order) {
          if (owner[k] >= 0 || area[k] < avg * 0.6) continue;
          const score = pole * latOf(k);
          if (score > bestScore) {
            bestScore = score;
            best = k;
          }
        }
      if (best >= 0) {
        owner[best] = c;
        core.push(best);
        contArea.push(area[best]);
        total += area[best];
        // 极点周围(纬度 72° 以上)占得多的几块板块直接并进来:极点落在大陆中间,不在边上的浅海里
        const capCnt = new Float32Array(P);
        let capAll = 0;
        for (let i = 0; i < n; i++) {
          if (pole * geo.latitude(i) <= POLAR_CAP) continue;
          capCnt[plate[i]]++;
          capAll++;
        }
        for (let k = 0; k < P; k++) {
          if (owner[k] >= 0 || capCnt[k] < 0.15 * capAll) continue;
          owner[k] = c;
          contArea[c] += area[k];
          total += area[k];
        }
      }
      continue;
    }
    for (const k of order) {
      if (owner[k] >= 0 || polar(k) || area[k] < avg * 0.6) continue;
      if (c > 0 && touchesOther(k, -2)) continue; // 不和已有大陆接壤
      let dmin = W;
      for (let b = 0; b < P; b++) if (owner[b] >= 0) dmin = Math.min(dmin, geo.pointDist(cx[b], cy[b], cx[k], cy[k]));
      const score = c === 0 ? area[k] * (0.5 + rng()) : dmin * (0.7 + 0.6 * rng());
      if (score > bestScore) {
        bestScore = score;
        best = k;
      }
    }
    if (best < 0) break;
    owner[best] = c;
    core.push(best);
    contArea.push(area[best]);
    total += area[best];
  }
  if (!contArea.length) {
    owner[order[0]] = 0;
    core.push(order[0]);
    contArea.push(area[order[0]]);
    total += area[order[0]];
  }
  // 2) 各大陆轮流往外长:谁离自己的目标大小最远谁先长(带点随机)。
  //    先只要"不碰别的大陆"的板块;所有大陆都长不动了还没够面积,才允许大陆相连。
  const wsum = weight.slice(0, contArea.length).reduce((s, v) => s + v, 0);
  const goal = contArea.map((_, c) => (target * weight[c]) / wsum);
  const closed = contArea.map(() => false);
  let allowMerge = contArea.length === 1;
  while (total < target) {
    let c = -1;
    let cs = Infinity;
    for (let q = 0; q < contArea.length; q++) {
      if (closed[q]) continue;
      const s = (contArea[q] / goal[q]) * (0.85 + 0.3 * rng());
      if (s < cs) {
        cs = s;
        c = q;
      }
    }
    if (c < 0) {
      if (allowMerge) break;
      allowMerge = true;
      closed.fill(false);
      continue;
    }
    let best = -1;
    let bestScore = -Infinity;
    for (const k of order) {
      if (owner[k] >= 0) continue;
      let sh = 0;
      for (let b = 0; b < P; b++) if (owner[b] === c) sh += shared[k * P + b];
      if (sh <= 0) continue;
      if (!allowMerge && touchesOther(k, c)) continue;
      // 接壤越长越紧凑;极地板块少要(极地大陆反过来:围着极点长,不看长轴);太大的板块(会一下子超出目标很多)少要
      let score = Math.sqrt(sh) * (0.5 + rng());
      const al = geo.pointDot(cx[core[c]], cy[core[c]], cx[k], cy[k], axX[c], axY[c]);
      if (c === polarC) score *= 0.3 + 1.7 * smoothstep(35, 80, pole * latOf(k));
      else {
        score *= 0.3 + 1.4 * al * al;
        if (polar(k)) score *= 0.3;
      }
      if (contArea[c] + area[k] > goal[c] * 1.5) score *= 0.4;
      if (score > bestScore) {
        bestScore = score;
        best = k;
      }
    }
    if (best < 0) {
      closed[c] = true;
      continue;
    }
    owner[best] = c;
    contArea[c] += area[best];
    total += area[best];
  }
  const continental = new Uint8Array(P);
  for (let k = 0; k < P; k++) continental[k] = owner[k] >= 0 ? 1 : 0;
  const nearCont = (k: number) => {
    for (let b = 0; b < P; b++) if (shared[k * P + b] > 0 && continental[b]) return true;
    return false;
  };
  // 3) 微大陆:不挨着大陆的小板块(2~4 块);挑不到孤立的就挑贴着大陆的小板块(大陆边上裂出去的一块)
  const micro = new Uint8Array(P);
  const nMicro = 2 + Math.floor(rng() * 3);
  let got = 0;
  for (const pass of [0, 1]) {
    for (const k of order) {
      if (got >= nMicro) break;
      if (continental[k] || micro[k] || polar(k) || area[k] > avg * 1.1 || area[k] < avg * 0.12) continue;
      if (pass === 0 && nearCont(k)) continue;
      micro[k] = 1;
      got++;
    }
  }
  // 4) 群岛区:不贴大陆、不在极地的大洋板块里挑 0~2 块
  const archipelago = new Uint8Array(P);
  const nArch = Math.floor(rng() * 2.6);
  got = 0;
  for (const k of order) {
    if (got >= nArch) break;
    if (continental[k] || micro[k] || polar(k) || nearCont(k)) continue;
    archipelago[k] = 1;
    got++;
  }
  return { continental, micro, archipelago };
}

/** 汇聚边界上一个地块的角色 */
const SIDE_ARC = 1; // 俯冲带上盘:大洋一侧 = 岛弧,大陆一侧 = 火山山脉
const SIDE_SLAB = 2; // 俯冲下去的那块:海沟
const SIDE_UPPER = 3; // 大陆撞大陆,上盘:山脉 + 背后的高原
const SIDE_LOWER = 4; // 大陆撞大陆,下盘:山脉

/**
 * 草图的海岸:先把草图扭一扭(域扭曲,半岛、海湾;小岛还是小岛,只是变了形),扭动的幅度和尺度(世界单位)。
 * 幅度按海岸线参数(0 贴着画 – 1 自然)在 SK_WARP_MIN 和 SK_WARP 之间取
 */
const SK_WARP = 42;
const SK_WARP_MIN = 5;
const SK_WARP_SCALE = 130;
/** 再加细碎的海岸噪声:能把海岸推出去多远(世界单位,× 各处的破碎程度);同样按海岸线参数在 SK_FINE_MIN 和 SK_FINE 之间取 */
const SK_FINE = 34;
const SK_FINE_MIN = 6;
/** 草图上涂的山地:抬升(× 山的高低参数);低 / 中 / 高三档各乘 SK_MTN_H */
const SK_MTN_U = 1.25;
const SK_MTN_H = [0.6, 1, 1.55];
/** 草图上涂的丘陵:抬升 */
const SK_HILLS_U = 0.2;
/** 草图上涂的高原:底座(米) */
const SK_PLATEAU_M = 2400;
/** 群岛笔:岛屿噪声的尺度(世界单位)和冒出水面的门槛(越高岛越少) */
const SK_ISLES_SCALE = 20;
const SK_ISLES_T = 0.25;

/**
 * sketch:作者的草图(sketch.ts)。没有 / 全是 0 = 和不给一样(结果逐字节不变)
 */
export function buildTectonics(mesh: Mesh, p: TectonicParams, sketch?: Sketch | null): Tectonics {
  const { n, adjStart, adj, width: W, spacing } = mesh;
  const geo = geometryOf(mesh);
  const rng = mulberry32(subSeed(p.seed, 'plates'));
  const split = p.largePlates !== undefined || p.smallPlates !== undefined ? plateCounts(p) : null;
  const K = split ? split.plates : Math.max(3, Math.round(p.plates));
  // 细窄的带(海沟、岛弧)至少一个地块宽,粗网格上不至于消失
  const thin = (w: number) => Math.max(w, 0.9 * spacing);

  // ---- 1. 板块生长 ----
  const minSeedDist = 0.45 * Math.sqrt(geo.area / K);
  const seeds: number[] = [];
  for (let tries = 0; seeds.length < K && tries < K * 400; tries++) {
    const i = Math.floor(rng() * n);
    const ok = seeds.every((s) => geo.dist(s, i) > minSeedDist * (tries > K * 200 ? 0.5 : 1));
    if (ok) seeds.push(i);
  }
  const plateCount = seeds.length;
  // 生长速度对数正态:面积大致和速度平方成正比 → 板块有大有小
  const rate = new Float32Array(plateCount);
  for (let k = 0; k < plateCount; k++) {
    const variation = clamp(fexp(0.42 * gauss(rng)), 0.5, 1.9);
    rate[k] = split ? (k < split.largePlates ? 1.25 * variation : 0.25 * variation) : variation;
  }

  const rough = geo.fbm(subSeed(p.seed, 'plate-rough'), 5);
  const fr = 3 / W;
  const plate0 = new Int16Array(n).fill(-1);
  // 代价用 Float64,和堆里的优先级同一精度(32 位会让"谁先到"的比较差一个舍入误差)
  const cost = new Float64Array(n).fill(Infinity);
  const heap = new MinHeap(n);
  seeds.forEach((s, k) => {
    plate0[s] = k;
    cost[s] = 0;
    heap.push(s, 0);
  });
  const closed = new Uint8Array(n);
  const elen = geo.edgeLengths();
  // 噪声让生长代价忽高忽低:板块沿"低谷"蔓延,边界弯弯曲曲而不是圆弧(每个地块的代价系数只和位置有关,先算好)
  const growW = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    const nv = 0.5 + 0.5 * rough.at(j, fr);
    growW[j] = 0.12 + 2.4 * nv * nv;
  }
  while (heap.size) {
    const i = heap.pop();
    if (closed[i]) continue;
    closed[i] = 1;
    const pk = plate0[i];
    for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
      const j = adj[k];
      if (closed[j]) continue;
      const c = cost[i] + (elen[k] * growW[j]) / rate[pk];
      if (c < cost[j]) {
        cost[j] = c;
        plate0[j] = pk;
        heap.push(j, c);
      }
    }
  }

  // 整张板块图扭曲一遍:每个地块取"扭曲后的位置"所在地块的板块。三层扭曲(几个大弯 → 半岛海湾 → 细碎),
  // 大陆轮廓、山脉、海沟都跟着板块走,彼此对得上
  const warpA = geo.fbm(subSeed(p.seed, 'warp-a'), 4);
  const warpB = geo.fbm(subSeed(p.seed, 'warp-b'), 4);
  const warpC = geo.fbm(subSeed(p.seed, 'warp-c'), 3);
  const warpD = geo.fbm(subSeed(p.seed, 'warp-d'), 3);
  const warpE = geo.fbm(subSeed(p.seed, 'warp-e'), 2);
  const fw = 2.2 / W;
  const fw2 = 6.5 / W;
  const fw3 = 18 / W;
  const warpAmp = 0.085 * W;
  const warpAmp2 = 0.035 * W;
  const warpAmp3 = 0.012 * W;
  const plate = new Int16Array(n);
  const q = [0, 0];
  for (let i = 0; i < n; i++) {
    // 往东 / 往南各挪三层,落点所在地块的板块
    geo.moveCell(
      q,
      i,
      warpAmp * warpA.at(i, fw),
      warpAmp * warpB.at(i, fw, 1, 5.2, 1.3),
      warpAmp2 * warpC.at(i, fw2),
      warpAmp2 * warpD.at(i, fw2),
      warpAmp3 * warpE.at(i, fw3),
      warpAmp3 * warpE.at(i, fw3, 1, 7.1, -2.6),
    );
    geo.clampPoint(q);
    plate[i] = plate0[geo.nearest(q[0], q[1], i)];
  }
  // Warping can erase very small plates. Seed anchors keep every requested plate present;
  // the existing fragment merge then retains its connected main component.
  if (split) seeds.forEach((cell, k) => { plate[cell] = k; });
  mergeFragments(mesh, plate, plateCount);

  // ---- 2. 板块速度 + 大陆 / 大洋 ----
  const plateVx = new Float32Array(plateCount);
  const plateVy = new Float32Array(plateCount);
  const density = new Float32Array(plateCount);
  const area = new Float32Array(plateCount);
  for (let i = 0; i < n; i++) area[plate[i]]++;
  for (let k = 0; k < plateCount; k++) {
    const a = rng() * Math.PI * 2;
    const s = 0.3 + 0.7 * rng();
    plateVx[k] = round24(Math.cos(a)) * s;
    plateVy[k] = round24(Math.sin(a)) * s;
    density[k] = rng();
  }
  const cen = geo.groupCentroids(plate, plateCount, area);
  // 板块运动:绕欧拉轴转动(质心处是上面的速度,再带一点绕质心的自转,按板块编号取)
  const spinBase = subSeed(p.seed, 'plate-spin');
  const spin = Float32Array.from({ length: plateCount }, (_, k) => 2 * keyed(spinBase, k) - 1);
  const motion = geo.plateMotion(plateVx, plateVy, cen.x, cen.y, spin);
  const va = [0, 0];
  const vb = [0, 0];
  // 极地大陆放不放、放哪一极:按种子另取(不动上面这串随机数)
  const polarSeed = subSeed(p.seed, 'polar-continent');
  const pole = keyed(polarSeed, 0) < POLAR_CONTINENT_P ? (keyed(polarSeed, 1) < 0.5 ? 1 : -1) : 0;
  const pick = pickContinents(mesh, plate, plateCount, area, cen, p.landFraction, rng, pole);
  const plateContinental = new Uint8Array(plateCount);
  for (let k = 0; k < plateCount; k++) plateContinental[k] = pick.continental[k] || pick.micro[k] ? 1 : 0;

  // ---- 3. 板块边界:汇聚 / 离散;汇聚边界上谁俯冲谁 ----
  const convergence = new Float32Array(n);
  const side = new Uint8Array(n);
  const convSources: number[] = [];
  const divSources: number[] = [];
  for (let i = 0; i < n; i++) {
    const pi = plate[i];
    let sum = 0;
    let cnt = 0;
    let other = -1;
    for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
      const j = adj[k];
      const pj = plate[j];
      if (pj === pi) continue;
      if (other < 0) other = pj;
      // 相对速度沿"从 i 指向 j"的分量:正 = 迎面撞上(两块板块在这个地块处的速度之差)
      motion.at(pi, i, va);
      motion.at(pj, i, vb);
      sum += geo.edgeDot(i, j, va[0] - vb[0], va[1] - vb[1]);
      cnt++;
    }
    if (!cnt) continue;
    const c = sum / cnt;
    convergence[i] = c;
    if (c > 0.25) {
      convSources.push(i);
      const ca = plateContinental[pi];
      const cb = plateContinental[other];
      if (ca && cb) side[i] = density[pi] < density[other] ? SIDE_UPPER : SIDE_LOWER;
      else if (ca !== cb) side[i] = ca ? SIDE_ARC : SIDE_SLAB;
      else side[i] = density[pi] < density[other] ? SIDE_ARC : SIDE_SLAB;
    } else if (c < -0.25) divSources.push(i);
  }
  const conv = distanceField(mesh, convSources, (i) => clamp(convergence[i] / 0.9, 0, 1));
  const div = distanceField(mesh, divSources, (i) => clamp(-convergence[i] / 0.9, 0, 1));
  /** 每个地块离得最近的汇聚边界是哪种角色(不在自己板块上的边界当作没有) */
  const sideOf = (i: number) => {
    const s = conv.src[i];
    return s >= 0 && plate[s] === plate[i] ? side[s] : 0;
  };

  // ---- 4. 陆地场 ----
  // 地壳底色:到"大陆 / 大洋"分界线的带符号距离(大陆内为正),换成 ±1 之间的缓坡。
  // 分界处两板块背向分开(被动大陆边缘,像大西洋两岸)时,海岸往大陆里缩一段 —— 缩进去的是大陆架,
  // 洋中脊在外海;俯冲带(主动边缘)海岸就在海沟后面不远
  const crust = (k: number) => (pick.continental[k] ? 2 : pick.micro[k] ? 1 : 0);
  const shore: number[] = [];
  for (let i = 0; i < n; i++) {
    // 微大陆和大陆之间也算分界:中间隔一道浅海峡(像马达加斯加、斯里兰卡、塔斯马尼亚),不并成大陆的一个半岛
    const ci = crust(plate[i]);
    for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
      if (crust(plate[adj[k]]) !== ci) {
        shore.push(i);
        break;
      }
    }
  }
  const sh = distanceField(mesh, shore, (i) => convergence[i]);
  const archBase = new Float32Array(n);
  for (let i = 0; i < n; i++) archBase[i] = pick.archipelago[plate[i]] ? 1 : 0;
  const archBlur = pick.archipelago.some((v) => v > 0) ? blurField(mesh, archBase, Math.max(4, Math.round((30 / spacing) ** 2))) : archBase;

  const coastN = geo.fbm(subSeed(p.seed, 'land'), 3, 0.6);
  const coastF = geo.fbm(subSeed(p.seed, 'coast-fine'), 4, 0.6);
  const rugN = geo.fbm(subSeed(p.seed, 'rugged'), 3);
  const shelfIsle = geo.fbm(subSeed(p.seed, 'shelf-isles'), 3);
  const insetN = geo.fbm(subSeed(p.seed, 'inset'), 3);
  const islandN = geo.fbm(subSeed(p.seed, 'islands'), 4);
  const beadN = geo.noise(subSeed(p.seed, 'arc-beads'));
  const basinN = geo.fbm(subSeed(p.seed, 'basins'), 5);
  const fs = 2.6 / W;
  const fc = 3.4 / W; // 海岸噪声:coastN 三层(波长约 600 / 300 / 150 像素,大半岛、大海湾)+ coastF 四层(约 86 → 11 像素,细碎)
  const ramp = 0.05 * W; // 地壳底色缓坡的宽度
  const B = new Float32Array(n);
  const L = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const pk = plate[i];
    const cr = crust(pk);
    // 被动边缘缩进:离得最近的分界处是张裂(那里 convergence < 0)缩得多,转换边界缩一点,俯冲带几乎不缩
    const cS = sh.str[i];
    const inset = (4 + 10 * smoothstep(0.1, -0.2, cS) + 34 * smoothstep(-0.1, -0.6, cS)) * (0.55 + 0.9 * (0.5 + 0.5 * insetN.at(i, fc, 1.3)));
    const sd = cr > 0 ? sh.dist[i] - inset : -sh.dist[i] - inset;
    let b = ftanh(sd / ramp);
    if (cr === 1) b = 0.8 * b - 0.12; // 微大陆:地壳薄,边上一圈沉在水下,中间露出成大岛
    B[i] = b;
    // 海岸噪声分两段:大尺度(几百像素的半岛、海湾)处处一样;细碎的一段强弱随地方变 ——
    // 有的海岸平直(像西非),有的支离破碎、岛屿密布(像挪威、爱琴海)
    const rug = 0.25 + 1.35 * smoothstep(-0.35, 0.45, rugN.at(i, fc, 0.8, 2.1, -6.3));
    const coast = 0.75 * coastN.at(i, fc) + 0.4 * rug * coastF.at(i, fc, 7);
    const s = sideOf(i);
    const cs = conv.str[i];
    const cd = conv.dist[i];
    // 碰撞带隆起:让山脉所在处保持是陆地
    const mtn = s === SIDE_UPPER || s === SIDE_LOWER || (s === SIDE_ARC && b > 0) ? cs * band(cd, 22) : 0;
    // 岛弧:俯冲带上盘、离海沟一段距离的一条窄带,断成一串岛
    let arc = 0;
    if (s === SIDE_ARC && b < 0.2) {
      const beads = smoothstep(-0.35, 0.45, beadN.atScale(i, 38) + 0.35 * islandN.at(i, fc, 6));
      arc = cs * band(cd - 11, thin(5)) * beads;
    }
    // 群岛板块:高频岛屿噪声冒头
    const isl = archBlur[i] > 0 ? archBlur[i] * smoothstep(0.05, 0.55, islandN.at(i, fc, 2.4, 7.7, -3.3)) : 0;
    // 大陆内部的张裂带下陷成海峡 / 内海(两块大陆板块互相分开 = 新大洋在张开)
    const rift = Math.max(0, b) * div.str[i] * band(div.dist[i], 14 + 23 * div.str[i]);
    // 内海 / 大海湾:只在大陆深处,积水成内海
    const basin = b > 0.45 ? (b - 0.45) * 2 * smoothstep(0.2, 0.5, basinN.at(i, fs, 1.2, 0.4 * coast, 0)) : 0;
    // 大陆架上的大岛(像不列颠、斯里兰卡、塔斯马尼亚):大陆外缘浅海里,中等尺度的噪声冒出水面
    const shelfZ = smoothstep(-0.8, -0.4, b) * (1 - smoothstep(-0.15, 0.15, b));
    const sIsle = shelfZ > 0 ? shelfZ * smoothstep(0.2, 0.55, shelfIsle.at(i, fc, 2.6, -1.7, 4.4)) : 0;
    L[i] = 0.62 * b + 0.4 * coast + 0.16 * mtn + 1.1 * arc + 0.6 * isl + 0.55 * sIsle - 1.5 * rift - 0.9 * basin;
  }

  // 热点岛链(像夏威夷):大洋里几个固定的热点,板块从上面漂过,留下一串由新到老、由大到小的岛;
  // 老的沉成海山(只在海底深度里看得到)
  const hotspots: { x: number; y: number; r: number; a: number }[] = [];
  // 热点多在大洋深处、远离大陆(像夏威夷):每个热点随机试几处,取离大陆最远的
  const nHot = 2 + Math.floor(rng() * 4);
  const hotAt: number[] = [];
  for (let h = 0; h < nHot; h++) {
    let best = -1;
    for (let tries = 0; tries < 60; tries++) {
      const i = Math.floor(rng() * n);
      if (B[i] > -0.45) continue;
      if (hotAt.some((j) => geo.dist(j, i) < 180)) continue;
      if (best < 0 || sh.dist[i] > sh.dist[best]) best = i;
    }
    if (best >= 0) hotAt.push(best);
  }
  for (const h of hotAt) {
    const pk = plate[h];
    // 板块在热点处往哪边漂(欧拉轴转动在当地的方向)
    motion.at(pk, h, va);
    const vl = hypot2(va[0], va[1]) || 1;
    const dx = va[0] / vl;
    const dy = va[1] / vl;
    const m = 5 + Math.floor(rng() * 5);
    const step = 12 + rng() * 7;
    const r0 = 8 + rng() * 4;
    for (let k = 0; k < m; k++) {
      const lat = (rng() - 0.5) * 7;
      // 顺着板块漂移方向排开(沿漂移方向 step·k,横向偏 lat)
      geo.moveCell(q, h, dx * step * k, dy * step * k, -(dy * lat), dx * lat);
      hotspots.push({
        x: q[0],
        y: q[1],
        r: thin(r0 * (1 - (0.55 * k) / m)),
        // 前几座露出水面,后面的越来越矮
        a: 1.45 * (1 - k / (m * 0.75)),
      });
    }
  }
  const hot = new Float32Array(n); // 热点隆起 0..1(海底深度用)
  for (const s of hotspots) {
    const R = 3 * s.r;
    for (const i of geo.cellsNearPoint(s.x, s.y, R)) {
      const d = geo.nearTo(i, s.x, s.y, R);
      const g = band(d, s.r);
      if (s.a > 0) L[i] += s.a * g;
      hot[i] = Math.max(hot[i], g * (0.5 + 0.5 * clamp(s.a, 0, 1)));
    }
  }

  const sorted = Float32Array.from(L).sort();
  const threshold = sorted[Math.floor((1 - clamp(p.landFraction, 0.02, 0.95)) * (n - 1))];
  const land = new Uint8Array(n);
  for (let i = 0; i < n; i++) land[i] = L[i] > threshold ? 1 : 0;

  // ---- 4b. 作者的草图 ----
  // 涂过的地块照草图定海陆:离草图边界远的定死,边界附近由同一套海岸噪声决定往哪边弯(海岸不是笔刷的圆边);
  // 地壳底色跟着草图(涂成陆地的深处像大陆内部,涂成海的像大洋)。没涂的地块照旧
  let skMtn: Float32Array | null = null;
  let skHills: Float32Array | null = null;
  let skPlat: Float32Array | null = null;
  let sk: Uint8Array | null = null;
  if (sketchUsed(sketch)) {
    // 每个地块在扭过的位置上取草图的值
    sk = new Uint8Array(n);
    const cp = clamp(sketch.coast, 0, 1);
    const warp = SK_WARP_MIN + (SK_WARP - SK_WARP_MIN) * cp;
    const fine = SK_FINE_MIN + (SK_FINE - SK_FINE_MIN) * cp;
    const wx = geo.fbm(subSeed(p.seed, 'sketch-warp'), 3);
    const wy = geo.fbm(subSeed(p.seed, 'sketch-warp') ^ 0x2f17, 3);
    for (let i = 0; i < n; i++) {
      geo.moveCell(q, i, warp * wx.atScale(i, SK_WARP_SCALE), warp * wy.atScale(i, SK_WARP_SCALE));
      sk[i] = sketchAt(sketch.grid, q[0], q[1], W, mesh.height);
    }
    // 群岛:涂过的那片按岛屿噪声冒出一个个小岛
    const isleN = sk.includes(SKETCH_ISLES) ? geo.fbm(subSeed(p.seed, 'sketch-isles'), 3) : null;
    const want = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const v = sk[i];
      want[i] = v === SKETCH_NONE ? land[i] : v === SKETCH_ISLES ? (isleN!.atScale(i, SK_ISLES_SCALE) > SK_ISLES_T ? 1 : 0) : v >= SKETCH_LAND ? 1 : 0;
    }
    const edge: number[] = [];
    for (let i = 0; i < n; i++) {
      for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
        const j = adj[k];
        if (want[j] !== want[i] && (sk[i] !== SKETCH_NONE || sk[j] !== SKETCH_NONE)) {
          edge.push(i);
          break;
        }
      }
    }
    const ed = edge.length ? distanceField(mesh, edge, () => 0).dist : new Float32Array(n).fill(Infinity);
    const mtn = new Float32Array(n);
    const hil = new Float32Array(n);
    const pla = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const v = sk[i];
      if (v === SKETCH_NONE) continue;
      const sd = want[i] ? ed[i] : -ed[i];
      const rug = 0.25 + 1.35 * smoothstep(-0.35, 0.45, rugN.at(i, fc, 0.8, 2.1, -6.3));
      // 群岛那片的海岸就是岛屿噪声本身,不再加细碎噪声(否则一个个小岛会被推得连成一片)
      if (v === SKETCH_ISLES) land[i] = want[i];
      else land[i] = v >= SKETCH_MOUNTAIN || sd + fine * rug * coastF.at(i, fc, 7) > 0 ? 1 : 0;
      if (Number.isFinite(sd)) B[i] = ftanh(sd / ramp);
      else B[i] = want[i] ? 1 : -1;
      if (v >= SKETCH_MOUNTAIN) mtn[i] = SK_MTN_H[v - SKETCH_MOUNTAIN];
      else if (v === SKETCH_HILLS) hil[i] = 1;
      else if (v === SKETCH_PLATEAU) pla[i] = 1;
    }
    if (mtn.some((v) => v > 0)) skMtn = blurField(mesh, mtn, 2);
    if (hil.some((v) => v > 0)) skHills = blurField(mesh, hil, 2);
    if (pla.some((v) => v > 0)) skPlat = blurField(mesh, pla, 3);
  }

  // ---- 5. 海底深度 ----
  const coastSrc: number[] = [];
  const seaSrc: number[] = [];
  for (let i = 0; i < n; i++) (land[i] ? coastSrc : seaSrc).push(i);
  const dCoast = distanceField(mesh, coastSrc, () => 0).dist;
  // 洋中脊:只算大洋里的张裂边界(大陆里的张裂是裂谷)
  const ridgeSrc = divSources.filter((i) => !land[i] && B[i] < 0.1);
  const ridge = distanceField(mesh, ridgeSrc, (i) => clamp(-convergence[i] / 0.9, 0, 1));
  const seaNoise = geo.fbm(subSeed(p.seed, 'sea'), 5);
  const shelfN = geo.fbm(subSeed(p.seed, 'shelf'), 3);
  const oceanDepth = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (land[i]) continue;
    // 洋壳年龄 ~ 离洋中脊的距离:越老越深(深度 ∝ √年龄),脊顶约 -2600 米,老洋底 -5000 ~ -5800 米
    const rs = ridge.str[i];
    const age = clamp(ridge.dist[i] / 160, 0, 1);
    let d = -2700 - 2700 * Math.sqrt(age) + 500 * rs * band(ridge.dist[i], 14);
    d += 300 * seaNoise.at(i, fs, 2) + 90 * seaNoise.at(i, fs, 9, 3.3, -1.7); // 深海丘陵
    // 大陆架:离岸一段很浅(-30 ~ -180 米),被动边缘宽、俯冲带一侧窄;外面是大陆坡,往下接到大洋
    const active = conv.str[i] * band(conv.dist[i], 30);
    const sw = (3 + 26 * (1 - active) * (0.35 + 0.65 * smoothstep(-0.4, 0.5, shelfN.at(i, fs, 1.6)))) * (B[i] > -0.2 ? 1.3 : 0.7);
    const dc = dCoast[i];
    const shelf = dc < sw ? -(30 + 150 * (dc / sw)) : -(180 + 6500 * smoothstep(0, 24, dc - sw));
    d = Math.max(d, shelf);
    // 岛弧、热点:海底隆起
    const s = sideOf(i);
    if (s === SIDE_ARC) d = Math.max(d, -1600 - 2200 * (1 - conv.str[i] * band(conv.dist[i] - 11, 9)));
    d += 2600 * hot[i];
    // 草图上涂的浅海:像大陆架那样浅
    if (sk && sk[i] === SKETCH_SHELF) d = Math.max(d, -(40 + 110 * (0.5 + 0.5 * shelfN.at(i, fs, 3.1, 2.2, -0.9))));
    oceanDepth[i] = Math.min(-20, d);
  }
  // 平滑海底,去掉距离场的折线痕迹;海沟在平滑之后再挖(窄而深)
  const smoothDepth = blurField(mesh, oceanDepth, 5);
  const trench = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (land[i] || sideOf(i) !== SIDE_SLAB) continue;
    // 俯冲下去的那块板块上、紧贴边界:海沟(离岸太近的浅海里不挖)
    trench[i] = (3200 + 3300 * conv.str[i]) * conv.str[i] * band(conv.dist[i], thin(9)) * smoothstep(2, 14, dCoast[i]);
  }
  const trenchS = blurField(mesh, trench, 1);
  for (let i = 0; i < n; i++) oceanDepth[i] = land[i] ? 0 : clamp(smoothDepth[i] - trenchS[i], -10500, -20);

  // ---- 6. 抬升场 + 高原底座 ----
  const dSea = distanceField(mesh, seaSrc, () => 0).dist;
  const baseU = geo.fbm(subSeed(p.seed, 'uplift'), 5);
  const hills = geo.fbm(subSeed(p.seed, 'hills'), 4);
  const old = geo.ridged(subSeed(p.seed, 'old-ranges'), 5);
  const plat = geo.fbm(subSeed(p.seed, 'plateau'), 4);
  const shield = geo.fbm(subSeed(p.seed, 'shield'), 4);
  const skRidge = skMtn ? geo.ridged(subSeed(p.seed, 'sketch-ranges'), 4) : null;
  const uplift = new Float32Array(n);
  const plateau = new Float32Array(n);
  const mf = p.mountains;
  for (let i = 0; i < n; i++) {
    if (!land[i]) continue;
    // 基础抬升很低 → 大部分陆地是平原
    let U = 0.016 + 0.018 * (baseU.at(i, fs, 1.5) + 1);
    // 零星的丘陵区
    U += 0.1 * smoothstep(0.3, 0.75, hills.at(i, fs, 2.2, 11, -3));
    const s = sideOf(i);
    const cs = conv.str[i];
    const cd = conv.dist[i];
    const contF = B[i] > 0 ? 1 : 0.7;
    // 汇聚带山脉:窄长的一条。大陆撞大陆的宽一些、高一些;俯冲带上盘在海沟后面一段(安第斯);
    // 下盘(俯冲下去的那块上的陆地)只有低矮的增生楔
    if (s === SIDE_UPPER || s === SIDE_LOWER) U += mf * 1.65 * cs * band(cd, 7 + 9 * cs) * contF;
    else if (s === SIDE_ARC) U += mf * 1.45 * cs * band(cd - 9, 5 + 5 * cs) * contF;
    else if (s === SIDE_SLAB) U += mf * 0.35 * cs * band(cd, 6) * contF;
    // 古老山系:细长的山脊噪声,只在少数地方冒头
    const r = old.at(i, fs, 1.9, 3.1, -7.4);
    U += mf * 0.4 * smoothstep(0.78, 0.96, r) * smoothstep(0.1, 0.55, hills.at(i, fs, 0.7, -5, 2) + 0.3);
    // 大陆裂谷:抬升减弱成低地(不减成负的:负抬升会压到海平面以下,积成一串死水湖);
    // 裂谷湖在 world.ts 里另挖(只在强的张裂带上)
    U *= 1 - 0.75 * div.str[i] * band(div.dist[i], 20) * contF;
    // 草图上涂的山地:一片山,里面是山脊噪声(高低起伏、有走向),交给侵蚀刻出山谷
    if (skMtn && skRidge && skMtn[i] > 0) U += mf * SK_MTN_U * skMtn[i] * (0.35 + 0.9 * skRidge.at(i, fs, 3.2, 5.1, -2.7));
    // 草图上涂的丘陵:一片低矮的起伏
    if (skHills && skHills[i] > 0) U += SK_HILLS_U * skHills[i] * (0.6 + 0.4 * hills.at(i, fs, 4.1, -2, 6));
    uplift[i] = U;
    // 高原底座(米):碰撞带、强俯冲带上盘背后一大片平坦的高地(青藏、安第斯高原),沿走向时有时无;
    // 大陆内部零星的台地(非洲、巴西那样几百到一千多米的高原)。离海近处收掉,海岸不会是悬崖
    let pb = 0;
    if ((s === SIDE_UPPER || s === SIDE_ARC) && cs > 0.25) {
      const reach = (s === SIDE_UPPER ? 28 : 16) + 34 * (0.5 + 0.5 * plat.at(i, fs, 1.1, 4, 0));
      const inBand = smoothstep(4, 12, cd) * (1 - smoothstep(reach, reach + 16, cd));
      const along = smoothstep(-0.25, 0.3, plat.at(i, fs, 2.3, -8, 1));
      pb = (s === SIDE_UPPER ? 3400 : 2600) * mf * smoothstep(0.25, 0.8, cs) * inBand * along;
    }
    pb += 1400 * smoothstep(-0.2, 0.3, shield.at(i, fs, 1.2)) * smoothstep(0.1, 0.5, B[i]);
    // 草图上涂的高原:一整片平坦的高地
    if (skPlat && skPlat[i] > 0) pb = Math.max(pb, SK_PLATEAU_M * skPlat[i] * (0.85 + 0.15 * plat.at(i, fs, 2.6, 3, -5)));
    plateau[i] = pb * smoothstep(3, 30, dSea[i]);
  }

  return {
    plateCount,
    ...(split ? { plateSmall: Uint8Array.from({ length: plateCount }, (_, k) => k < split.largePlates ? 0 : 1) } : {}),
    plate,
    plateVx,
    plateVy,
    plateOmega: motion.omega,
    plateContinental,
    convergence,
    distConv: conv.dist,
    strengthConv: conv.str,
    distDiv: div.dist,
    strengthDiv: div.str,
    land,
    oceanDepth,
    uplift,
    plateau,
  };
}
