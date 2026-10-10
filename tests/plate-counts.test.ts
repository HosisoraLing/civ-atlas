import { describe, expect, it } from 'vitest';
import { buildMesh } from '../src/gen/mesh';
import { buildTectonics, plateCounts } from '../src/gen/tectonics';
import { DEFAULT_PARAMS, MAP_W, MAP_H, generateWorld } from '../src/gen/world';
import { sphereSpacing } from '../src/gen/geometry';
import { mulberry32, subSeed } from '../src/gen/util';
import { makeSave, parseSave, saveText, worldKey } from '../src/gen/savefile';
import { paramsSide } from '../src/ui/WorldOverviewGenesis';

const meshFor = (seed: number) => buildMesh(MAP_W, MAP_H, sphereSpacing(MAP_W, 12000), mulberry32(subSeed(seed, 'mesh')));

describe('独立大型／小型板块数量', () => {
  it('生成数量准确，所有板块存在，小型板块的平均面积明显更小', () => {
    for (const seed of [7, 48]) {
      const mesh = meshFor(seed);
      for (const [largePlates, smallPlates] of [[2, 0], [7, 12], [20, 2], [32, 32]]) {
        const t = buildTectonics(mesh, { ...DEFAULT_PARAMS, seed, largePlates, smallPlates });
        expect(t.plateCount).toBe(largePlates + smallPlates);
        expect(new Set(t.plate).size).toBe(t.plateCount);
        expect([...t.plateSmall!].filter(Boolean)).toHaveLength(smallPlates);
        const area = new Array(t.plateCount).fill(0);
        for (const id of t.plate) area[id]++;
        expect(area.every(a => a > 0)).toBe(true);
        if (smallPlates) {
          const large = area.slice(0, largePlates).reduce((a, b) => a + b, 0) / largePlates;
          const small = area.slice(largePlates).reduce((a, b) => a + b, 0) / smallPlates;
          expect(large, `${seed}: ${largePlates}/${smallPlates}`).toBeGreaterThan(small * 2);
        }
      }
    }
  });
  it('确定性；同总数改大小配比会改变板块分布，旧参数保持原模式', () => {
    const mesh = meshFor(7), p = { ...DEFAULT_PARAMS, seed: 7, largePlates: 7, smallPlates: 12 };
    const a = buildTectonics(mesh, p), b = buildTectonics(mesh, p);
    expect(b.plate).toEqual(a.plate);
    expect(buildTectonics(mesh, { ...p, largePlates: 12, smallPlates: 7 }).plate).not.toEqual(a.plate);
    const old = buildTectonics(mesh, DEFAULT_PARAMS);
    expect(old.plateSmall).toBeUndefined();
    expect(buildTectonics(mesh, { ...DEFAULT_PARAMS, largePlates: undefined, smallPlates: undefined }).plate).toEqual(old.plate);
  });
  it('存档往返保留数量，总数派生；不同配比有独立世界标识', () => {
    const p = { ...DEFAULT_PARAMS, seed: 7, largePlates: 7, smallPlates: 12 };
    const save = makeSave(p, { names: {}, interventions: [], terrain: [] }, 'abc123def456');
    expect(save.params).toMatchObject({ largePlates: 7, smallPlates: 12, plates: 19 });
    const loaded = parseSave(saveText(save));
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.save.params).toEqual(save.params);
    expect(worldKey(p)).toBe(worldKey(save.params));
    expect(worldKey({ ...p, largePlates: 12, smallPlates: 7 })).not.toBe(worldKey(p));
    expect(paramsSide(save.params)).toContain('大型 7 / 小型 12');
    const old = makeSave(DEFAULT_PARAMS, { names: {}, interventions: [], terrain: [] }, 'abc123def456');
    expect(old.params.largePlates).toBeUndefined();
    expect(worldKey(old.params)).not.toContain('largePlates');
  });
  it('导入和直接生成规整非法计数，不超出 GPU 和生成器的 64 板块上限', () => {
    expect(plateCounts({ plates: 30, largePlates: NaN, smallPlates: Infinity })).toEqual({ largePlates: 10, smallPlates: 20, plates: 30 });
    expect(plateCounts({ plates: 30, largePlates: 1e9, smallPlates: -2 })).toEqual({ largePlates: 32, smallPlates: 0, plates: 32 });
    const save = makeSave(DEFAULT_PARAMS, { names: {}, interventions: [], terrain: [] }, 'abc123def456');
    const r = parseSave(JSON.stringify({ ...save, params: { ...save.params, largePlates: 999, smallPlates: 2.4 } }));
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.save.params).toMatchObject({ largePlates: 32, smallPlates: 2, plates: 34 }); expect(r.warnings.join(' ')).toContain('板块数量'); }
    const world = generateWorld({ ...DEFAULT_PARAMS, cells: 2000, largePlates: 2, smallPlates: 0 });
    expect(world.params.plates).toBe(2);
    expect(world.tect.plateCount).toBe(2);
    expect([...world.elevation].every(Number.isFinite)).toBe(true);
  });
});
