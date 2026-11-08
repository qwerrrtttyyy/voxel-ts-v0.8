import { AIR_ID, type FaceName } from '../BlockRegistry';
import type { Chunk } from '../Chunk';
import type { World } from '../World';

import { EMPTY_MESH, type IMesher, type MeshContext, type MeshData } from './IMesher';

interface FaceDef {
  face: FaceName;
  dir: readonly [number, number, number];
  /** 4 个角，绕序保证 (B-A)×(D-A) 朝外 */
  corners: readonly (readonly [number, number, number])[];
  /** 与 corners 一一对应；侧面让 v 跟随世界 y，草边才不会横过来 */
  uv: readonly (readonly [number, number])[];
  shade: number;
}

/** 标准 voxel AO 的四级亮度：被三面夹住的角最暗 */
const AO_LEVELS = [0.52, 0.69, 0.85, 1.0] as const;

type Vec3 = readonly [number, number, number];

const FACES: readonly FaceDef[] = [
  {
    face: 'top', dir: [0, 1, 0], shade: 1.0,
    corners: [[0,1,1],[1,1,1],[1,1,0],[0,1,0]],
    uv: [[0,0],[1,0],[1,1],[0,1]],
  },
  {
    face: 'bottom', dir: [0, -1, 0], shade: 0.52,
    corners: [[0,0,0],[1,0,0],[1,0,1],[0,0,1]],
    uv: [[0,0],[1,0],[1,1],[0,1]],
  },
  {
    face: 'east', dir: [1, 0, 0], shade: 0.78,
    corners: [[1,0,0],[1,1,0],[1,1,1],[1,0,1]],
    uv: [[0,0],[0,1],[1,1],[1,0]],
  },
  {
    face: 'west', dir: [-1, 0, 0], shade: 0.78,
    corners: [[0,0,1],[0,1,1],[0,1,0],[0,0,0]],
    uv: [[0,0],[0,1],[1,1],[1,0]],
  },
  {
    face: 'south', dir: [0, 0, 1], shade: 0.88,
    corners: [[0,0,1],[1,0,1],[1,1,1],[0,1,1]],
    uv: [[0,0],[1,0],[1,1],[0,1]],
  },
  {
    face: 'north', dir: [0, 0, -1], shade: 0.88,
    corners: [[1,0,0],[0,0,0],[0,1,0],[1,1,0]],
    uv: [[0,0],[1,0],[1,1],[0,1]],
  },
];

/**
 * 面剔除 mesher：只生成暴露在空气 / 透明方块前的面，
 * 每个 chunk 合并成一个 BufferGeometry（一次 draw call）。
 * 顶点色承担廉价的面朝向明暗，材质用 Basic，出 Minecraft 那种干净感。
 */
export class CulledMesher implements IMesher {
  readonly id = 'culled-v1';

  build(chunk: Chunk, world: World, ctx: MeshContext): MeshData {
    const p: number[] = [];
    const n: number[] = [];
    const u: number[] = [];
    const c: number[] = [];
    const idx: number[] = [];
    const originX = chunk.cx * chunk.size;
    const originZ = chunk.cz * chunk.size;

    // 只遍历到本 chunk 实际最高的非空层：地下实心区上方不再逐格空转（48 层 → 约 16 层）。
    let maxY = -1;
    for (let i = chunk.data.length - 1; i >= 0; i--) {
      if (chunk.data[i] !== AIR_ID) {
        maxY = Math.floor(i / (chunk.size * chunk.size));
        break;
      }
    }
    if (maxY < 0) return EMPTY_MESH;

    for (let y = 0; y <= maxY; y++) {
      for (let z = 0; z < chunk.size; z++) {
        for (let x = 0; x < chunk.size; x++) {
          const id = chunk.get(x, y, z);
          if (id === AIR_ID) continue;
          const def = ctx.blocks.get(id);
          const selfOpaque = def.opaque;
          const emissive = !!def.emissive;
          const useAO = ctx.ao?.() ?? true;

          for (const f of FACES) {
            const nb = world.getBlock(originX + x + f.dir[0], y + f.dir[1], originZ + z + f.dir[2]);
            if (nb !== AIR_ID) {
              if (ctx.blocks.get(nb).opaque) continue;
              // 同类透明方块之间剔除内部面：相邻玻璃不再生成 2 个重叠面。
              if (!selfOpaque && nb === id) continue;
            }

            const tileKey = ctx.blocks.tileOf(id, f.face);
            if (!tileKey) continue;
            const rect = ctx.atlas.uvRect(tileKey);
            if (!rect) continue;

            // --- 顶点 AO：沿面法线外推一格，采样两个边邻居 + 一个角邻居 ---
            const nrm = f.dir;
            let axisU: Vec3, axisV: Vec3;
            if (nrm[1] !== 0) { axisU = [1, 0, 0]; axisV = [0, 0, 1]; }
            else if (nrm[0] !== 0) { axisU = [0, 1, 0]; axisV = [0, 0, 1]; }
            else { axisU = [1, 0, 0]; axisV = [0, 1, 0]; }
            const bx = originX + x, by = y, bz = originZ + z;
            const occludes = (dx: number, dy: number, dz: number): number => {
              const nid = world.getBlock(bx + nrm[0] + dx, by + nrm[1] + dy, bz + nrm[2] + dz);
              if (nid === AIR_ID) return 0;
              const nd = ctx.blocks.get(nid);
              return nd.opaque && !nd.liquid ? 1 : 0;
            };

            const base = p.length / 3;
            for (let i = 0; i < 4; i++) {
              const co = f.corners[i];
              const uv = f.uv[i];
              p.push(x + co[0], y + co[1], z + co[2]);
              n.push(f.dir[0], f.dir[1], f.dir[2]);
              u.push(uv[0] === 0 ? rect.u0 : rect.u1, uv[1] === 0 ? rect.v0 : rect.v1);

              let shade = f.shade * (emissive ? 1.45 : 1);
              if (useAO) {
                const su = Math.sign((co[0] - 0.5) * axisU[0] + (co[1] - 0.5) * axisU[1] + (co[2] - 0.5) * axisU[2]);
                const sv = Math.sign((co[0] - 0.5) * axisV[0] + (co[1] - 0.5) * axisV[1] + (co[2] - 0.5) * axisV[2]);
                const s1 = occludes(axisU[0] * su, axisU[1] * su, axisU[2] * su);
                const s2 = occludes(axisV[0] * sv, axisV[1] * sv, axisV[2] * sv);
                const sc = occludes(
                  axisU[0] * su + axisV[0] * sv,
                  axisU[1] * su + axisV[1] * sv,
                  axisU[2] * su + axisV[2] * sv,
                );
                shade *= AO_LEVELS[s1 && s2 ? 0 : 3 - (s1 + s2 + sc)];
              }
              c.push(shade, shade, shade);
            }
            idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
          }
        }
      }
    }

    if (p.length === 0) return EMPTY_MESH;
    return {
      positions: new Float32Array(p),
      normals: new Float32Array(n),
      uvs: new Float32Array(u),
      colors: new Float32Array(c),
      indices: new Uint32Array(idx),
    };
  }
}
