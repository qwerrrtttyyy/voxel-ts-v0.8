import type { BlockRegistry } from '../BlockRegistry';
import type { TextureAtlas } from '../../render/TextureAtlas';
import type { World } from '../World';
import type { Chunk } from '../Chunk';

export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
}

export interface MeshContext {
  blocks: BlockRegistry;
  atlas: TextureAtlas;
  /** v0.3：顶点 AO 开关（运行时由设置面板切换，缺省开启） */
  ao?: () => boolean;
}

/** 网格化策略接口：换 greedy meshing / WASM mesher 只换实现 */
export interface IMesher {
  readonly id: string;
  build(chunk: Chunk, world: World, ctx: MeshContext): MeshData;
}

export const EMPTY_MESH: MeshData = {
  positions: new Float32Array(0),
  normals: new Float32Array(0),
  uvs: new Float32Array(0),
  colors: new Float32Array(0),
  indices: new Uint32Array(0),
};
