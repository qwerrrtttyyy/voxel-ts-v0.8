import type { TilePainter } from '../../render/TextureAtlas';
import type { BlockRegistry, FaceName } from '../BlockRegistry';
import { painterFor, type BlockVisual } from './paint';
import type { BlockPack } from './types';

/**
 * 方块包与宿主的唯一接缝。
 *
 * 每个方块的「注册 + 逆注册」作为一个可逆效应交给 Cordis 内核：
 *   do   = atlas.define(...) + blocks.define(...)
 *   undo = blocks.release(id)（先清洗世界里残留的该 id 体素）→ atlas.releaseKey(...)
 * 因此关掉一个方块包时，贴图、方块定义、世界里的旧方块会一起精确回滚。
 */
export interface PackHost {
  readonly atlas: {
    define(owner: string, local: string, paint: TilePainter): string;
    releaseKey(key: string): void;
  };
  readonly blocks: BlockRegistry;
  effect(label: string, fn: () => () => void): void;
}

interface FaceSpec {
  all?: string;
  faces?: Partial<Record<FaceName, string>>;
}

function buildFaces(host: PackHost, owner: string, local: string, visual: BlockVisual): {
  spec: FaceSpec;
  keys: string[];
} {
  const keys: string[] = [];
  const define = (suffix: string, vis: BlockVisual): string => {
    const key = host.atlas.define(owner, `${local}_${suffix}`, painterFor(vis));
    keys.push(key);
    return key;
  };
  if (visual.faces) {
    const fallback: BlockVisual = { style: 'solid', base: [128, 128, 128] };
    const top = define('top', visual.faces.top ?? fallback);
    const side = define('side', visual.faces.side ?? fallback);
    const bottom = visual.faces.bottom ? define('bottom', visual.faces.bottom) : top;
    return {
      spec: { faces: { top, bottom, north: side, south: side, east: side, west: side } },
      keys,
    };
  }
  const all = host.atlas.define(owner, local, painterFor(visual));
  keys.push(all);
  return { spec: { all }, keys };
}

/** 注册一个方块包，返回 local → block id 表（组件重新激活时会原地刷新） */
export function registerPack(host: PackHost, pack: BlockPack): Record<string, number> {
  const ids: Record<string, number> = {};
  for (const block of pack.blocks) {
    host.effect(`block:${pack.id}:${block.local}`, () => {
      const { spec: faceSpec, keys } = buildFaces(host, pack.id, block.local, block.visual);
      const id = host.blocks.define(pack.id, block.local, {
        ...faceSpec,
        opaque: block.opaque ?? true,
        solid: block.solid ?? true,
        emissive: block.emissive,
        liquid: block.liquid,
        hardness: block.hardness,
      });
      ids[block.local] = id;
      return () => {
        host.blocks.release(id);
        for (const key of keys) host.atlas.releaseKey(key);
        delete ids[block.local];
      };
    });
  }
  return ids;
}
