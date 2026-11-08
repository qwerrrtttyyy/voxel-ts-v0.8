import { CHUNK_HEIGHT } from '../../config';
import type { IGenerator } from '../IGenerator';
import type { BlockLibrary } from '../blocks/types';
import { AIR_ID } from '../BlockRegistry';
import { ColumnContext } from './Column';
import type { TerrainSampler } from './Sampler';
import type { TerrainStage } from './stages';

interface ColumnResult {
  readonly blocks: Uint8Array;
  readonly surface: number;
}

const MAX_CACHED_COLUMNS = 40000;

/**
 * 把一组 Cordis 阶段编排成 IGenerator。
 *
 * 世界生成会对 9216 列各调 1 次 surfaceY + 48 次 blockAt，
 * 因此这里按列缓存：整列只跑一次阶段链，之后全是 O(1) 查表。
 * 阶段被 attach / detach（插件开关）时缓存整体失效。
 */
export class TerrainPipeline implements IGenerator {
  readonly id = 'cordis-terrain-v1';
  private readonly stages = new Map<string, TerrainStage>();
  private ordered: TerrainStage[] = [];
  private readonly columns = new Map<string, ColumnResult>();
  private lib: BlockLibrary | null = null;
  private sampler: TerrainSampler | null = null;
  private revision = 0;

  configure(lib: BlockLibrary, sampler: TerrainSampler): void {
    this.lib = lib;
    this.sampler = sampler;
    this.columns.clear();
  }

  attach(stage: TerrainStage): void {
    this.stages.set(stage.id, stage);
    this.reorder();
  }

  detach(id: string): void {
    if (this.stages.delete(id)) this.reorder();
  }

  private reorder(): void {
    this.ordered = [...this.stages.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    this.columns.clear();
    this.revision++;
  }

  get stageIds(): string[] { return this.ordered.map((s) => s.id); }
  get stageCount(): number { return this.ordered.length; }
  get columnCacheSize(): number { return this.columns.size; }
  get currentRevision(): number { return this.revision; }

  surfaceY(wx: number, wz: number): number {
    return this.column(wx, wz).surface;
  }

  blockAt(wx: number, y: number, wz: number, _surface: number): number {
    const result = this.column(wx, wz);
    return y >= 0 && y < result.blocks.length ? result.blocks[y] : AIR_ID;
  }

  /** 供验收脚本直接检查某一列的生成结果 */
  inspect(wx: number, wz: number): { blocks: number[]; surface: number } {
    const result = this.column(wx, wz);
    return { blocks: [...result.blocks], surface: result.surface };
  }

  private column(wx: number, wz: number): ColumnResult {
    // v0.6：字符串 key 支持负坐标与无限世界，不再依赖 wx*100003+wz 的隐式约定
    const key = `${wx},${wz}`;
    const hit = this.columns.get(key);
    if (hit) return hit;
    if (!this.lib || !this.sampler) {
      return { blocks: new Uint8Array(CHUNK_HEIGHT), surface: 0 };
    }
    const col = new ColumnContext(wx, wz, this.lib, this.sampler);
    for (const stage of this.ordered) stage.apply(col);
    const result: ColumnResult = { blocks: col.blocks, surface: col.meta.height };
    if (this.columns.size >= MAX_CACHED_COLUMNS) {
      // 淘汰最早插入的四分之一，而不是整表清空（M3 大世界下避免缓存雪崩）
      let drop = Math.max(1, Math.floor(this.columns.size / 4));
      for (const k of this.columns.keys()) {
        this.columns.delete(k);
        if (--drop <= 0) break;
      }
    }
    this.columns.set(key, result);
    return result;
  }
}
