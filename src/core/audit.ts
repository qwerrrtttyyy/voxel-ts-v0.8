import type { Unregister } from './ServiceRegistry';
import type { NamespacedId, AuditRuleId } from './brands';
import { asAuditRuleId } from './brands';
import { PRIVILEGED_CAPABILITIES } from './Sandbox';

/**
 * v0.8：把「深度审批」本身做成插件化的、可观测的运行时系统。
 *
 * 设计要点：
 *  - 规则是纯数据 + 纯函数 `check(ctx)`，不认识 DOM / three / PluginHost，
 *    因此浏览器里的菜单自检与 Node 验收跑的是**同一份规则实现**。
 *  - 规则通过 `AuditRegistry.register()` 注册，第三方插件用 `scope.audit(rule)`
 *    追加自己的规则，卸载时由 EffectStack 自动撤销 —— 审批能力也是插件。
 *  - 发现项是按 severity 判别的联合类型；报告计数用映射类型生成，
 *    新增一个 severity / category 时 `counts` / `byCategory` 自动跟上。
 */

export const AUDIT_SEVERITIES = ['error', 'warn', 'info'] as const;
export type AuditSeverity = (typeof AUDIT_SEVERITIES)[number];

export const AUDIT_CATEGORIES = [
  'plugin', 'service', 'binary', 'sandbox', 'world', 'save', 'perf', 'types',
] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

interface FindingBase {
  readonly ruleId: AuditRuleId;
  readonly category: AuditCategory;
  readonly message: string;
  readonly detail?: string;
}

/** discriminated union：error 必须给出修复建议，info 可以什么都不带 */
export type AuditFinding =
  | (FindingBase & { readonly severity: 'error'; readonly remedy: string })
  | (FindingBase & { readonly severity: 'warn'; readonly remedy?: string })
  | (FindingBase & { readonly severity: 'info'; readonly remedy?: string });

/** 编译期约束：按 severity 取对应分支 */
export type FindingFor<S extends AuditSeverity> = Extract<AuditFinding, { severity: S }>;

export interface AuditPluginView {
  id: string;
  provides: string[];
  dependencies: string[];
  optionalDependencies: string[];
  hasMeta: boolean;
  requiredCapabilities: string[];
  sandboxed: boolean;
  loaded: boolean;
  source: string;
}

export interface AuditServiceView {
  id: string;
  owners: string[];
  provided: boolean;
}

/**
 * 纯数据上下文：浏览器与 Node 都能构造，规则实现零环境依赖。
 * 这里刻意保持可变 —— 验收要往里注入缺陷来证明每条规则真的会触发；
 * 不可变的是 `AuditReport`（输出），不是采样输入。
 */
export interface AuditContext {
  plugins: AuditPluginView[];
  services: AuditServiceView[];
  binary: {
    owners: string[];
    issues: string[];
    reservedTags: number[];
    claimedTags: number[];
    migrationLabels: string[];
  };
  engine: {
    stats: { label: string; slow: number; totalMs: number }[];
    errorCount: number;
  };
  world: {
    generatorId: string;
    streaming: boolean;
    loadedChunks: number;
    pendingDirty: number;
    archived: number;
  };
  runtime: {
    strictTypes: boolean;
    envelopeVersion: number;
    chunkCodecVersion: number;
  };
}

export interface AuditRule<C extends AuditCategory = AuditCategory> {
  readonly id: AuditRuleId;
  readonly category: C;
  readonly title: string;
  readonly description: string;
  check(ctx: AuditContext): readonly AuditFinding[];
}

/** 规则声明助手：`const` 泛型保留字面量 category / id */
export function defineRule<
  const C extends AuditCategory,
  const Id extends NamespacedId,
>(spec: {
  readonly id: Id;
  readonly category: C;
  readonly title: string;
  readonly description: string;
  check(ctx: AuditContext): readonly AuditFinding[];
}): AuditRule<C> {
  return { ...spec, id: asAuditRuleId(spec.id) };
}

/** 规则对象字面量里的 `this` 尚未带上品牌 id，这里接受最小结构再提升 */
export interface FindingSource {
  readonly id: string;
  readonly category: AuditCategory;
}

/** 函数重载：error 强制带 remedy，warn/info 可选 */
export function finding(
  rule: FindingSource, severity: 'error', message: string, remedy: string, detail?: string,
): FindingFor<'error'>;
export function finding(
  rule: FindingSource, severity: 'warn' | 'info', message: string, remedy?: string, detail?: string,
): FindingFor<'warn' | 'info'>;
export function finding(
  rule: FindingSource, severity: AuditSeverity, message: string,
  remedy?: string, detail?: string,
): AuditFinding {
  const base = {
    ruleId: rule.id as AuditRuleId, category: rule.category, message, detail,
  };
  if (severity === 'error') {
    return { ...base, severity, remedy: remedy ?? '检查该规则对应的运行上下文' } as FindingFor<'error'>;
  }
  return { ...base, severity, remedy } as FindingFor<'warn' | 'info'>;
}

export interface AuditReport {
  readonly at: number;
  readonly rules: number;
  readonly findings: readonly AuditFinding[];
  /** 映射类型：severity 集合变化时这里自动同步 */
  readonly counts: { [S in AuditSeverity]: number };
  readonly byCategory: { [C in AuditCategory]: number };
  readonly ok: boolean;
}

export interface AuditApi {
  run(): AuditReport;
  last(): AuditReport | null;
  rules(): readonly AuditRule[];
  /** 第三方插件注册自定义规则；返回注销函数 */
  register(rule: AuditRule): Unregister;
}

/** 规则注册表：逐规则隔离，单条抛错不会让整份审批报告消失 */
export class AuditRegistry {
  private readonly rules = new Map<string, AuditRule>();
  private report: AuditReport | null = null;

  register<C extends AuditCategory>(rule: AuditRule<C>): Unregister {
    if (this.rules.has(rule.id)) {
      throw new Error(`[audit] 规则 id 重复：${rule.id}`);
    }
    this.rules.set(rule.id, rule);
    return () => { this.rules.delete(rule.id); };
  }

  list(): readonly AuditRule[] { return [...this.rules.values()]; }
  get size(): number { return this.rules.size; }
  last(): AuditReport | null { return this.report; }

  run(ctx: AuditContext): AuditReport {
    const findings: AuditFinding[] = [];
    for (const rule of this.rules.values()) {
      try {
        findings.push(...rule.check(ctx));
      } catch (err) {
        findings.push(finding(
          rule, 'error', `规则 ${rule.id} 执行失败`,
          '修复规则实现或补齐 AuditContext 字段', String(err),
        ));
      }
    }
    const counts = Object.fromEntries(
      AUDIT_SEVERITIES.map((s) => [s, 0]),
    ) as { [S in AuditSeverity]: number };
    const byCategory = Object.fromEntries(
      AUDIT_CATEGORIES.map((c) => [c, 0]),
    ) as { [C in AuditCategory]: number };
    for (const f of findings) { counts[f.severity]++; byCategory[f.category]++; }
    const report: AuditReport = {
      at: Date.now(), rules: this.rules.size, findings,
      counts, byCategory, ok: counts.error === 0,
    };
    this.report = report;
    return report;
  }
}

// ============================================================ 内置审批规则集

const RULE_PLUGIN_ID = defineRule({
  id: 'audit.plugin.id.namespaced', category: 'plugin',
  title: '插件 id 命名空间',
  description: '每个插件 id 必须是 owner.name 形式，避免社区插件撞名',
  check(ctx) {
    const bad = ctx.plugins.filter((p) => !/^[^.\s]+\.[^.\s]+/.test(p.id)).map((p) => p.id);
    return bad.length ? [finding(this, 'error', `未命名空间化的插件 id：${bad.join(', ')}`,
      '改成 owner.name 形式，如 demo.pulse')] : [];
  },
});

const RULE_PLUGIN_UNIQUE = defineRule({
  id: 'audit.plugin.id.unique', category: 'plugin',
  title: '插件 id 唯一',
  description: '清单里不能有重复 id，否则 catalog 会静默覆盖',
  check(ctx) {
    const seen = new Set<string>(), dup = new Set<string>();
    for (const p of ctx.plugins) {
      if (seen.has(p.id)) dup.add(p.id);
      seen.add(p.id);
    }
    return dup.size ? [finding(this, 'error', `重复插件 id：${[...dup].join(', ')}`,
      '合并实现或给其中一个换 id')] : [];
  },
});

const RULE_CAP_RESOLVABLE = defineRule({
  id: 'audit.plugin.deps.cap', category: 'plugin',
  title: 'cap: 硬依赖可解析',
  description: '声明了 cap:xxx 就必须有插件 provides 该能力',
  check(ctx) {
    const caps = new Set(ctx.plugins.flatMap((p) => p.provides));
    const missing = ctx.plugins.flatMap((p) =>
      p.dependencies.filter((d) => d.startsWith('cap:') && !caps.has(d.slice(4)))
        .map((d) => `${p.id} → ${d}`));
    return missing.length ? [finding(this, 'error', `无法解析的能力依赖：${missing.join(', ')}`,
      '补上提供者，或改为 optionalDependencies')] : [];
  },
});

const RULE_ID_DEP = defineRule({
  id: 'audit.plugin.deps.plugin', category: 'plugin',
  title: '插件 id 硬依赖存在',
  description: '硬依赖的插件必须在清单里',
  check(ctx) {
    const ids = new Set(ctx.plugins.map((p) => p.id));
    const missing = ctx.plugins.flatMap((p) =>
      p.dependencies.filter((d) => !d.startsWith('cap:') && !ids.has(d))
        .map((d) => `${p.id} → ${d}`));
    return missing.length ? [finding(this, 'error', `缺失依赖插件：${missing.join(', ')}`,
      '安装缺失插件，或改为 cap: 能力依赖')] : [];
  },
});

const RULE_CYCLE = defineRule({
  id: 'audit.plugin.deps.cycle', category: 'plugin',
  title: '依赖图无环',
  description: '拓扑排序必须能覆盖全部插件',
  check(ctx) {
    const caps = new Map<string, string[]>();
    for (const p of ctx.plugins) for (const c of p.provides) {
      caps.set(c, [...(caps.get(c) ?? []), p.id]);
    }
    const deps = (p: AuditPluginView): string[] => p.dependencies.flatMap((d) =>
      d.startsWith('cap:') ? (caps.get(d.slice(4)) ?? []) : [d]);
    const state = new Map<string, 0 | 1 | 2>();
    const cycles = new Set<string>();
    const visit = (id: string, stack: string[]): void => {
      if (state.get(id) === 1) { stack.forEach((s) => cycles.add(s)); return; }
      if (state.get(id) === 2) return;
      state.set(id, 1);
      const p = ctx.plugins.find((x) => x.id === id);
      for (const d of p ? deps(p) : []) if (state.get(d) !== 2) visit(d, [...stack, id]);
      state.set(id, 2);
    };
    for (const p of ctx.plugins) visit(p.id, []);
    return cycles.size ? [finding(this, 'error', `依赖成环：${[...cycles].join(', ')}`,
      '用 optionalDependencies 或 services.onChange 打破环')] : [];
  },
});

const RULE_META = defineRule({
  id: 'audit.plugin.meta', category: 'plugin',
  title: '非内核插件带清单元数据',
  description: '插件仓库要展示 label / description / category',
  check(ctx) {
    const bad = ctx.plugins.filter((p) => !p.hasMeta && p.source !== 'builtin').map((p) => p.id);
    return bad.length ? [finding(this, 'warn', `缺少 meta 的插件：${bad.join(', ')}`,
      '补上 meta: { label, description, category }')] : [];
  },
});

const REQUIRED_SERVICES = [
  'core.mesher', 'core.generator', 'core.collision', 'core.chunkView', 'core.firstPerson',
] as const;

const RULE_SERVICE_REQUIRED = defineRule({
  id: 'audit.service.required', category: 'service',
  title: '关键策略服务已提供',
  description: 'mesher / generator / collision / chunkView / firstPerson 缺一不可',
  check(ctx) {
    const have = new Set(ctx.services.filter((s) => s.provided).map((s) => s.id));
    const missing = REQUIRED_SERVICES.filter((s) => !have.has(s));
    return missing.length ? [finding(this, 'error', `关键服务缺失：${missing.join(', ')}`,
      '检查对应插件是否被停用或加载失败')] : [];
  },
});

const RULE_SERVICE_NAMESPACE = defineRule({
  id: 'audit.service.namespace', category: 'service',
  title: '服务令牌命名空间',
  description: 'token id 必须带点，防止与插件私有令牌撞车',
  check(ctx) {
    const bad = ctx.services.filter((s) => !s.id.includes('.')).map((s) => s.id);
    return bad.length ? [finding(this, 'warn', `未命名空间的服务令牌：${bad.join(', ')}`,
      '改成 mypack.name 形式')] : [];
  },
});

const RULE_SERVICE_OWNER = defineRule({
  id: 'audit.service.owner', category: 'service',
  title: '服务实现声明 owner',
  description: '没有 owner 的策略在热插拔时无法定位来源',
  check(ctx) {
    const bad = ctx.services.filter((s) => s.owners.some((o) => o === '<unowned>' || o === 'anonymous'));
    return bad.length ? [finding(this, 'warn', `无主服务：${bad.map((s) => s.id).join(', ')}`,
      'provide 时传 { owner: 插件 id }')] : [];
  },
});

const RULE_TAG_RESERVED = defineRule({
  id: 'audit.binary.tag.reserved', category: 'binary',
  title: '插件段不占用系统 tag',
  description: 'chunk / region 段保留高位，插件 tag 不得落入',
  check(ctx) {
    const reserved = new Set(ctx.binary.reservedTags);
    const hit = ctx.binary.claimedTags.filter((t) => reserved.has(t));
    return hit.length ? [finding(this, 'error', `插件占用系统 tag：${hit.map((t) => `0x${t.toString(16)}`).join(', ')}`,
      '用 claimTag() 的返回值，不要手写 tag')] : [];
  },
});

const RULE_BINARY_VALIDATE = defineRule({
  id: 'audit.binary.validate', category: 'binary',
  title: '二进制段自检通过',
  description: 'handler 必须有 owner 且 encode/decode 齐全',
  check(ctx) {
    return ctx.binary.issues.length
      ? [finding(this, 'error', `二进制段问题：${ctx.binary.issues.join('; ')}`,
          '补齐 owner / encode / decode')]
      : [];
  },
});

const RULE_MIGRATION = defineRule({
  id: 'audit.save.migration', category: 'save',
  title: '存档迁移链完整',
  description: 'v1 存档必须有 1→当前版本的迁移器',
  check(ctx) {
    const ok = ctx.binary.migrationLabels.some((l) => /^1→/.test(l));
    return ok ? [] : [finding(this, 'warn', '缺少 v1 存档迁移器',
      '注册 EnvelopeMigration { from:1, to:当前版本 }')];
  },
});

const RULE_CAP_KNOWN = defineRule({
  id: 'audit.sandbox.capability', category: 'sandbox',
  title: '远程插件能力声明合法',
  description: 'requiredCapabilities 只能是沙箱认识的特权能力',
  check(ctx) {
    const known = new Set<string>(PRIVILEGED_CAPABILITIES);
    const bad = ctx.plugins.flatMap((p) =>
      p.requiredCapabilities.filter((c) => !known.has(c)).map((c) => `${p.id}:${c}`));
    return bad.length ? [finding(this, 'error', `未知能力：${bad.join(', ')}`,
      '只使用 PrivilegedCapability 联合里的值')] : [];
  },
});

const RULE_SANDBOXED = defineRule({
  id: 'audit.sandbox.enforced', category: 'sandbox',
  title: '运行时插件已沙箱化',
  description: 'url / source 来源的插件必须经过 createSandboxedPlugin',
  check(ctx) {
    const bad = ctx.plugins
      .filter((p) => (p.source === 'url' || p.source === 'source') && !p.sandboxed)
      .map((p) => p.id);
    return bad.length ? [finding(this, 'error', `未沙箱化的运行时插件：${bad.join(', ')}`,
      '通过 catalog.installFromUrl / installFromSource 安装')] : [];
  },
});

const RULE_PERF = defineRule({
  id: 'audit.perf.slow', category: 'perf',
  title: '慢回调监控',
  description: '逐插件回调画像中出现超过预算的调用时提示',
  check(ctx) {
    const bad = ctx.engine.stats.filter((s) => s.slow > 0);
    return bad.length
      ? [finding(this, 'warn', `慢回调 ${bad.length} 个：${bad.map((s) => `${s.label}(${s.slow})`).join(', ')}`,
          '给该回调加 every / 降低预算内工作量')]
      : [];
  },
});

const RULE_ENGINE_ERRORS = defineRule({
  id: 'audit.perf.errors', category: 'perf',
  title: '主循环异常隔离计数',
  description: '被隔离的插件回调异常数不为 0 时提示',
  check(ctx) {
    return ctx.engine.errorCount > 0
      ? [finding(this, 'warn', `主循环已隔离 ${ctx.engine.errorCount} 次回调异常`,
          '查看控制台或 profiler 定位抛错插件')]
      : [];
  },
});

const RULE_GENERATOR = defineRule({
  id: 'audit.world.generator', category: 'world',
  title: '地形生成器已装配',
  description: 'world.generatorId 不应为 none',
  check(ctx) {
    return ctx.world.generatorId === 'none'
      ? [finding(this, 'error', '世界没有装配生成器',
          '启用 terrain-3d / cordis-world 等提供 GENERATOR 的插件')]
      : [];
  },
});

const RULE_DIRTY = defineRule({
  id: 'audit.world.dirty', category: 'world',
  title: '重建队列未积压',
  description: '长期积压说明 flushBudgeted 预算或窗口生成跟不上',
  check(ctx) {
    return ctx.world.pendingDirty > 256
      ? [finding(this, 'warn', `待重建 chunk 积压 ${ctx.world.pendingDirty}`,
          '调低窗口半径或提高每帧重建预算')]
      : [];
  },
});

const RULE_STRICT = defineRule({
  id: 'audit.types.strict', category: 'types',
  title: 'TypeScript 严格模式',
  description: '记录本工程是否启用 strict 与编译期契约检查',
  check(ctx) {
    return ctx.runtime.strictTypes
      ? [finding(this, 'info', 'strict: true · 品牌类型 / const 泛型 / satisfies 已启用')]
      : [finding(this, 'warn', '未启用 strict', '在 tsconfig 打开 strict')];
  },
});

const RULE_VERSIONS = defineRule({
  id: 'audit.save.versions', category: 'save',
  title: '协议版本一致',
  description: '信封版本与 chunk 段版本都必须是本构建认识的版本',
  check(ctx) {
    const { envelopeVersion, chunkCodecVersion } = ctx.runtime;
    if (envelopeVersion < 2 || chunkCodecVersion < 1) {
      return [finding(this, 'warn', `协议版本偏旧：envelope=${envelopeVersion} chunk=${chunkCodecVersion}`,
        '确认迁移链覆盖旧版本')];
    }
    return [];
  },
});

/** 内置规则集：AuditPlugin 启动时一次性注册，第三方可继续追加 */
export const BUILTIN_AUDIT_RULES: readonly AuditRule[] = [
  RULE_PLUGIN_ID, RULE_PLUGIN_UNIQUE, RULE_CAP_RESOLVABLE, RULE_ID_DEP,
  RULE_CYCLE, RULE_META, RULE_SERVICE_REQUIRED, RULE_SERVICE_NAMESPACE,
  RULE_SERVICE_OWNER, RULE_TAG_RESERVED, RULE_BINARY_VALIDATE, RULE_MIGRATION,
  RULE_CAP_KNOWN, RULE_SANDBOXED, RULE_PERF, RULE_ENGINE_ERRORS,
  RULE_GENERATOR, RULE_DIRTY, RULE_STRICT, RULE_VERSIONS,
];

export function registerBuiltinRules(registry: AuditRegistry): Unregister[] {
  return BUILTIN_AUDIT_RULES.map((r) => registry.register(r));
}
