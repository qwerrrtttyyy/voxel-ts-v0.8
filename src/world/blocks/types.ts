import type { BlockVisual, BlockStyle, RGB } from './paint';
export type { BlockVisual, BlockStyle, RGB } from './paint';

/** 一个方块 = 一条数据。绘制逻辑全部委托给 paint.ts 的算子 */
export interface BlockSpec {
  readonly local: string;
  readonly label: string;
  readonly visual: BlockVisual;
  readonly opaque?: boolean;
  readonly solid?: boolean;
  readonly emissive?: boolean;
  readonly liquid?: boolean;
  readonly hardness?: number;
}

/** 方块包：一个独立可开关、可热插拔的模块 */
export interface BlockPack {
  readonly id: string;
  readonly label: string;
  readonly category: string;
  readonly blocks: readonly BlockSpec[];
}

/** 方块库：地形阶段只读这张表，不绑死任何插件 id */
export interface BlockLibrary {
  readonly byPack: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly byLocal: Readonly<Record<string, number>>;
  readonly total: number;
  /** 按 local 名取 id；方块包被关闭时返回 0（空气），地形自动降级而不崩溃 */
  id(local: string): number;
}

/** 视觉声明简写 */
export function v(
  style: BlockStyle,
  base: RGB,
  accent?: RGB,
  seed = 1,
  extra: Partial<BlockVisual> = {},
): BlockVisual {
  return { style, base, accent, seed, ...extra };
}

/** 方块声明简写 */
export function spec(
  local: string,
  label: string,
  visual: BlockVisual,
  props: Omit<BlockSpec, 'local' | 'label' | 'visual'> = {},
): BlockSpec {
  return { local, label, visual, ...props };
}
