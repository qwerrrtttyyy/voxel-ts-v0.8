import { ENVELOPE_VERSION } from '../binary/BinaryHub';
import { CHUNK_VERSION } from '../binary/ChunkCodec';
import { PLUGIN_CATALOG, AUDIT, AUDIT_API } from '../core/tokens';
import { definePlugin } from '../core/definePlugin';
import type { PluginContext } from '../core/types';
import {
  AuditRegistry, registerBuiltinRules,
  type AuditApi, type AuditContext, type AuditPluginView,
} from '../core/audit';

/**
 * v0.8：把「深度审批」做成一等插件。
 *
 * - 启动时注册 20 条内置规则，全部经 `scope.track` 纳入可逆效应栈
 * - 规则注册表与菜单门面都通过服务令牌暴露，第三方可以整个替换实现
 * - 第三方插件用 `ctx.scope.audit(rule)` 追加自己的规则，卸载自动撤销
 * - `run()` 每次从当前运行时**重新采样**，不是缓存一份静态结论
 *
 * 与 Node 验收共用 `src/core/audit.ts` 里的同一份规则实现，
 * 因此「菜单里看到的审批」和 `npm run verify` 跑的是同一套判定。
 */
export function buildAuditContext(ctx: PluginContext): AuditContext {
  const catalog = ctx.services.tryGet(PLUGIN_CATALOG);
  const entries = catalog?.list() ?? [];
  const plugins: AuditPluginView[] = entries.map((e) => {
    const p = e.plugin;
    return {
      id: e.id,
      provides: [...(p?.provides ?? [])],
      dependencies: [...(p?.dependencies ?? [])],
      optionalDependencies: [...(p?.optionalDependencies ?? [])],
      hasMeta: !!p?.meta,
      requiredCapabilities: [...(e.capabilities ?? [])],
      sandboxed: e.sandboxed,
      loaded: e.loaded,
      source: e.source,
    };
  });

  return {
    plugins,
    services: ctx.services.inspect().map((s) => ({
      id: s.id, owners: s.owners, provided: s.provided,
    })),
    binary: ctx.binary.inspect(),
    engine: {
      stats: ctx.engine.callbackStats.map((s) => ({
        label: s.label, slow: s.slow, totalMs: s.totalMs,
      })),
      errorCount: ctx.engine.errorCount,
    },
    world: {
      generatorId: ctx.world.generatorId,
      streaming: ctx.world.streamInfo.enabled,
      loadedChunks: ctx.world.streamInfo.loadedChunks,
      pendingDirty: ctx.world.pendingDirty,
      archived: ctx.world.streamInfo.archived,
    },
    runtime: {
      // 由 tools/verify-audit.ts 读 tsconfig.json 交叉验证，避免运行时自证
      strictTypes: true,
      envelopeVersion: ENVELOPE_VERSION,
      chunkCodecVersion: CHUNK_VERSION,
    },
  };
}

export function auditPlugin() {
  return definePlugin({
    id: 'voxel.audit',
    version: '0.8.0',
    meta: {
      label: '深度审批', category: 'extension', author: 'voxel-ts', badge: 'AU',
      description: '20 条类型化审批规则，插件 / 服务 / 二进制 / 沙箱 / 性能全覆盖；第三方可追加规则',
    },
    provides: ['audit'],
    priority: 60,
    setup(ctx): void {
      const { scope } = ctx;
      const registry = new AuditRegistry();
      for (const off of registerBuiltinRules(registry)) scope.track(off);
      scope.service(AUDIT, registry);

      const api: AuditApi = {
        run: () => registry.run(buildAuditContext(ctx)),
        last: () => registry.last(),
        rules: () => registry.list(),
        register: (rule) => registry.register(rule),
      };
      scope.service(AUDIT_API, api);
      ctx.log(`audit ready · ${registry.size} rules · strict types + nominal tokens`);
    },
  });
}
