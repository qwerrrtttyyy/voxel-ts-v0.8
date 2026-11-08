import { Kernel } from '../../kernel';
import type { BlockRegistry } from '../BlockRegistry';
import type { TextureAtlas } from '../../render/TextureAtlas';
import { allPacks, registerPack, type BlockLibrary } from '../blocks';
import { TerrainPipeline } from './Pipeline';
import { TerrainSampler } from './Sampler';
import { TERRAIN_STAGES } from './stages';

/**
 * Cordis 世界的完整装配，纯函数式、不依赖 DOM / WebGL / PluginContext。
 * 桥接插件与 Node 验收脚本共用这一份，保证「测的就是跑的」。
 *
 * v0.5：可注入外部 `kernel` —— 与插件组件共用同一实例，实现「一套编排」。
 * 不传时自建（Node 验收、独立使用场景保持隔离）。
 */
export interface CordisWorld {
  readonly kernel: Kernel;
  readonly pipeline: TerrainPipeline;
  readonly library: BlockLibrary;
  /** 组件开关后刷新方块库并让列缓存失效 */
  refresh(): void;
  /** 本层登记的世界组件 id，用于局部注销（共享内核时不能 dispose 掉插件组件） */
  readonly componentIds: readonly string[];
  /** 只注销世界组件并按依赖顺序精确回滚，不触碰内核里其他 group 的组件 */
  dispose(): void;
  readonly packIds: readonly string[];
  readonly stageIds: readonly string[];
}

export function assembleCordisWorld(opts: {
  readonly atlas: TextureAtlas;
  readonly blocks: BlockRegistry;
  readonly seed: number;
  readonly mats?: Readonly<Record<string, number>>;
  readonly extra?: Readonly<Record<string, number>>;
  readonly kernel?: Kernel;
}): CordisWorld {
  const { atlas, blocks, seed } = opts;
  const mats = opts.mats ?? {};
  const extra = opts.extra ?? {};
  const kernel = opts.kernel ?? new Kernel();
  const ownedKernel = !opts.kernel;
  const pipeline = new TerrainPipeline();
  const sampler = new TerrainSampler(seed);
  const componentIds: string[] = [];

  // 基础设施作为反应式服务注入：所有方块包都 inject 它
  componentIds.push('infra.host');
  kernel.register({
    id: 'infra.host',
    group: 'world',
    provide: ['infra.atlas', 'infra.blocks'],
    apply(kctx) {
      kctx.set('infra.atlas', atlas);
      kctx.set('infra.blocks', blocks);
    },
  });

  const packIds: Record<string, Record<string, number>> = {};
  for (const pack of allPacks) {
    componentIds.push(pack.id);
    kernel.register({
      id: pack.id,
      group: 'world',
      inject: ['infra.atlas', 'infra.blocks'],
      provide: [`pack:${pack.id}`],
      apply(kctx) {
        const a = kctx.require<TextureAtlas>('infra.atlas');
        const b = kctx.require<BlockRegistry>('infra.blocks');
        const ids = registerPack(
          { atlas: a, blocks: b, effect: (label, fn) => kctx.effect(label, fn) },
          pack,
        );
        packIds[pack.id] = ids;
        kctx.set(`ids:${pack.id}`, ids);
      },
    });
  }

  // 地形阶段：inject 链即依赖图，order 决定流水线顺序
  for (const stage of TERRAIN_STAGES) {
    componentIds.push(stage.id);
    kernel.register({
      id: stage.id,
      group: 'world',
      inject: stage.inject,
      provide: [stage.id],
      apply(kctx) {
        kctx.set(stage.id, stage);
        kctx.effect(`attach:${stage.id}`, () => {
          pipeline.attach(stage);
          return () => pipeline.detach(stage.id);
        });
      },
    });
  }

  kernel.settle();

  const byLocal: Record<string, number> = {};
  const library: BlockLibrary = {
    byPack: packIds,
    byLocal,
    get total(): number { return Object.keys(byLocal).length; },
    id: (local: string): number => byLocal[local] ?? 0,
  };

  const refresh = (): void => {
    for (const key of Object.keys(byLocal)) delete byLocal[key];
    Object.assign(byLocal, mats, extra);
    for (const ids of Object.values(packIds)) Object.assign(byLocal, ids);
    pipeline.configure(library, sampler);
  };
  refresh();

  /**
   * 局部注销：只 unregister 世界组件（按深度降序停用、精确回滚贴图/方块/阶段），
   * 共享内核里的插件组件完全不受影响。独占内核时走全量 dispose 更彻底。
   */
  const dispose = (): void => {
    if (ownedKernel) { kernel.dispose(); return; }
    for (const id of componentIds) kernel.unregister(id);
    kernel.settle();
  };

  return {
    kernel, pipeline, library, refresh, componentIds, dispose,
    packIds: allPacks.map((p) => p.id),
    stageIds: TERRAIN_STAGES.map((s) => s.id),
  };
}
