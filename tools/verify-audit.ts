/**
 * v0.8 深度审批 + TypeScript 契约专项验收。
 *
 * 一半是编译期断言（`@ts-expect-error` 由 `npm run check` 验证），
 * 一半是运行时规则引擎测试。两者共用 `src/core/audit.ts` 的规则实现，
 * 与浏览器菜单里的「深度审批」页面完全一致。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { AuditRegistry, registerBuiltinRules, defineRule, finding, BUILTIN_AUDIT_RULES } from '../src/core/audit';
import type { AuditContext, AuditFinding, FindingFor } from '../src/core/audit';
import { asAuditRuleId } from '../src/core/brands';
import { definePlugin, definePluginList, type PluginIdOf, type ProvidedCaps } from '../src/core/definePlugin';
import { ServiceToken, ServiceRegistry, type TokenIdOf } from '../src/core/ServiceRegistry';
import { EventBus } from '../src/core/EventBus';
import { BinaryHub } from '../src/binary/BinaryHub';

let pass = 0, fail = 0;
function test(name: string, fn: () => void): void {
  try { fn(); pass++; console.log(`PASS  ${name}`); }
  catch (err) { fail++; console.log(`FAIL  ${name}  · ${err instanceof Error ? err.message : String(err)}`); }
}
function ok(cond: boolean, msg = 'assertion failed'): void { if (!cond) throw new Error(msg); }
function has(report: { findings: readonly AuditFinding[] }, id: string, severity?: string): void {
  const hit = report.findings.find((f) => f.ruleId === id);
  ok(!!hit, `缺少发现项 ${id}（实际 ${report.findings.map((f) => f.ruleId).join(', ')}）`);
  if (severity) ok(hit!.severity === severity, `${id} 级别应为 ${severity}，实为 ${hit!.severity}`);
}

// ==================================================== 编译期契约（tsc 验证）

interface Animal { readonly name: string }
interface Dog extends Animal { bark(): void }

// @ts-expect-error 不变性：ServiceToken<Dog> 不能冒充 ServiceToken<Animal>
const _invariant: ServiceToken<Animal> = new ServiceToken<Dog>('probe.dog');
// @ts-expect-error 名义类型：对象字面量不能伪造 ServiceToken 绕过注册表
const _fake: ServiceToken<number> = { id: 'probe.fake', description: '' };

// @ts-expect-error 插件 id 必须是 owner.name
definePlugin({ id: 'badid', version: '1', setup() {} });
// @ts-expect-error requiredCapabilities 只接受 PrivilegedCapability 联合
definePlugin({ id: 'demo.bad', version: '1', setup() {}, requiredCapabilities: ['godmode'] });
// @ts-expect-error 依赖必须是 cap:xxx 或命名空间化插件 id
definePlugin({ id: 'demo.bad', version: '1', setup() {}, dependencies: ['clouds'] });

const typedA = definePlugin({ id: 'demo.a', version: '1', provides: ['audit'], setup() {} });
const typedB = definePlugin({ id: 'demo.b', version: '1', setup() {} });
// @ts-expect-error 清单里重复的字面量 id 必须在编译期拦下
definePluginList([typedA, typedA] as const);
definePluginList([typedA, typedB] as const); // 正确清单不报错

const bus = new EventBus();
// @ts-expect-error 动态事件名必须是 namespace:name
bus.onDynamic('oops', () => {});
bus.onDynamic('demo:ping', () => {});

// @ts-expect-error error 级发现项必须给出 remedy
const _badFinding: FindingFor<'error'> = {
  ruleId: asAuditRuleId('demo.bad'), category: 'plugin', severity: 'error', message: 'x',
};

type _IdOk = PluginIdOf<typeof typedA> extends 'demo.a' ? true : false;
const _idOk: _IdOk = true;
type _CapOk = 'audit' extends ProvidedCaps<typeof typedA> ? true : false;
const _capOk: _CapOk = true;
// 现有 `new ServiceToken<T>('id')` 构造只给一个类型参数，Id 走默认 string；
// 显式补上第二个类型参数即可把字面量 id 带进类型系统，供 TokenIdOf 反查。
const PROBE = new ServiceToken<number, 'probe.literal'>('probe.literal');
type _TokOk = TokenIdOf<typeof PROBE> extends 'probe.literal' ? true : false;
const _tokOk: _TokOk = true;
void [_invariant, _fake, _badFinding, _idOk, _capOk, _tokOk, typedB];

// ==================================================== 运行时规则引擎

const REQUIRED = [
  'core.mesher', 'core.generator', 'core.collision', 'core.chunkView', 'core.firstPerson',
];

function healthy(): AuditContext {
  return {
    plugins: [{
      id: 'voxel.core', provides: ['core'], dependencies: [], optionalDependencies: [],
      hasMeta: true, requiredCapabilities: [], sandboxed: false, loaded: true, source: 'builtin',
    }],
    services: REQUIRED.map((id) => ({ id, owners: ['core'], provided: true })),
    binary: {
      owners: ['core'], issues: [], reservedTags: [0xf001, 0xf002, 0x0001],
      claimedTags: [], migrationLabels: ['1→2 chunk 段独立化'],
    },
    engine: { stats: [], errorCount: 0 },
    world: {
      generatorId: 'density3d-v1', streaming: true, loadedChunks: 49,
      pendingDirty: 0, archived: 0,
    },
    runtime: { strictTypes: true, envelopeVersion: 2, chunkCodecVersion: 1 },
  };
}

test('编译期契约由 tsc 验证：strict / 品牌类型 / const 泛型', () => {
  const ts = JSON.parse(readFileSync(resolve(process.cwd(), 'tsconfig.json'), 'utf8')) as {
    compilerOptions: { strict?: boolean; target?: string };
  };
  ok(ts.compilerOptions.strict === true, 'tsconfig 必须 strict');
  ok(_idOk && _capOk && _tokOk, '类型级正向断言应全部为 true');
  ok(definePlugin({ id: 'demo.zero', version: '1', setup() {} }) !== null);
});

test('definePlugin 运行时零包装：返回的就是原对象', () => {
  const raw = { id: 'demo.zero', version: '1', provides: ['x'], setup() {} } as const;
  ok(definePlugin(raw) === (raw as unknown));
});

test('内置规则 20 条，注册后全部进注册表', () => {
  const reg = new AuditRegistry();
  const offs = registerBuiltinRules(reg);
  ok(BUILTIN_AUDIT_RULES.length === 20 && reg.size === 20, `size=${reg.size}`);
  ok(offs.length === 20);
});

test('健康运行时：0 error / 0 warn / 1 info，报告 ok', () => {
  const reg = new AuditRegistry();
  registerBuiltinRules(reg);
  const r = reg.run(healthy());
  ok(r.rules === 20, `rules=${r.rules}`);
  ok(r.counts.error === 0 && r.counts.warn === 0, JSON.stringify(r.counts));
  ok(r.counts.info === 1 && r.ok, `counts=${JSON.stringify(r.counts)}`);
  ok(r.findings[0].severity === 'info');
});

test('映射类型计数：counts / byCategory 与实际发现逐项一致', () => {
  const reg = new AuditRegistry();
  registerBuiltinRules(reg);
  const ctx = healthy();
  ctx.engine.stats.push({ label: 'x', slow: 3, totalMs: 50 });
  const r = reg.run(ctx as AuditContext);
  const manual = { error: 0, warn: 0, info: 0 };
  for (const f of r.findings) manual[f.severity]++;
  ok(JSON.stringify(r.counts) === JSON.stringify(manual), JSON.stringify(r.counts));
  ok(r.byCategory.perf === 1 && r.byCategory.types === 1, JSON.stringify(r.byCategory));
});

test('插件契约缺陷：id / 唯一性 / 依赖 / 环 / meta 全部被拦', () => {
  const reg = new AuditRegistry();
  registerBuiltinRules(reg);
  const ctx = healthy();
  ctx.plugins.push(
    { id: 'bare', provides: [], dependencies: [], optionalDependencies: [],
      hasMeta: false, requiredCapabilities: [], sandboxed: false, loaded: false, source: 'extension' },
    { id: 'bare', provides: [], dependencies: [], optionalDependencies: [],
      hasMeta: false, requiredCapabilities: [], sandboxed: false, loaded: false, source: 'extension' },
    { id: 'demo.broken', provides: [], dependencies: ['cap:missing', 'voxel.absent'],
      optionalDependencies: [], hasMeta: true, requiredCapabilities: [],
      sandboxed: false, loaded: false, source: 'extension' },
    { id: 'loop.a', provides: [], dependencies: ['loop.b'], optionalDependencies: [],
      hasMeta: true, requiredCapabilities: [], sandboxed: false, loaded: false, source: 'extension' },
    { id: 'loop.b', provides: [], dependencies: ['loop.a'], optionalDependencies: [],
      hasMeta: true, requiredCapabilities: [], sandboxed: false, loaded: false, source: 'extension' },
  );
  const r = reg.run(ctx);
  has(r, 'audit.plugin.id.namespaced', 'error');
  has(r, 'audit.plugin.id.unique', 'error');
  has(r, 'audit.plugin.deps.cap', 'error');
  has(r, 'audit.plugin.deps.plugin', 'error');
  has(r, 'audit.plugin.deps.cycle', 'error');
  has(r, 'audit.plugin.meta', 'warn');
});

test('服务缺陷：关键服务缺失 / 无命名空间 / 无 owner', () => {
  const reg = new AuditRegistry();
  registerBuiltinRules(reg);
  const ctx = healthy();
  ctx.services[0].provided = false;
  ctx.services.push({ id: 'nodot', owners: ['<unowned>'], provided: true });
  const r = reg.run(ctx);
  has(r, 'audit.service.required', 'error');
  has(r, 'audit.service.namespace', 'warn');
  has(r, 'audit.service.owner', 'warn');
});

test('二进制缺陷：系统 tag 被占用 / handler 问题 / 迁移链缺失', () => {
  const reg = new AuditRegistry();
  registerBuiltinRules(reg);
  const ctx = healthy();
  ctx.binary.claimedTags.push(0xf001);
  ctx.binary.issues.push('h: 未声明 owner');
  ctx.binary.migrationLabels = [];
  const r = reg.run(ctx);
  has(r, 'audit.binary.tag.reserved', 'error');
  has(r, 'audit.binary.validate', 'error');
  has(r, 'audit.save.migration', 'warn');
});

test('沙箱缺陷：未知能力 / 运行时插件未沙箱化', () => {
  const reg = new AuditRegistry();
  registerBuiltinRules(reg);
  const ctx = healthy();
  ctx.plugins.push({
    id: 'remote.evil', provides: [], dependencies: [], optionalDependencies: [],
    hasMeta: true, requiredCapabilities: ['godmode'], sandboxed: false,
    loaded: true, source: 'url',
  });
  const r = reg.run(ctx);
  has(r, 'audit.sandbox.capability', 'error');
  has(r, 'audit.sandbox.enforced', 'error');
});

test('运行时缺陷：慢回调 / 异常 / 生成器缺失 / dirty 积压 / 旧协议', () => {
  const reg = new AuditRegistry();
  registerBuiltinRules(reg);
  const ctx = healthy();
  ctx.engine.stats.push({ label: 'plugin.heavy', slow: 4, totalMs: 90 });
  ctx.engine.errorCount = 2;
  ctx.world.generatorId = 'none';
  ctx.world.pendingDirty = 300;
  ctx.runtime.strictTypes = false;
  ctx.runtime.envelopeVersion = 1;
  const r = reg.run(ctx);
  has(r, 'audit.perf.slow', 'warn');
  has(r, 'audit.perf.errors', 'warn');
  has(r, 'audit.world.generator', 'error');
  has(r, 'audit.world.dirty', 'warn');
  has(r, 'audit.types.strict', 'warn');
  has(r, 'audit.save.versions', 'warn');
});

test('第三方规则可注册 / 注销，规则抛错被隔离成 error 发现', () => {
  const reg = new AuditRegistry();
  registerBuiltinRules(reg);
  const custom = defineRule({
    id: 'demo.custom', category: 'types', title: '自定义', description: '第三方规则',
    check: () => [finding({ id: 'demo.custom', category: 'types' }, 'info', '第三方规则已执行')],
  });
  const off = reg.register(custom);
  ok(reg.size === 21);
  has(reg.run(healthy()), 'demo.custom', 'info');

  const boom = defineRule({
    id: 'demo.boom', category: 'plugin', title: '会抛错', description: '失败隔离',
    check() { throw new Error('boom'); },
  });
  reg.register(boom);
  const r = reg.run(healthy());
  has(r, 'demo.boom', 'error');
  const f = r.findings.find((x) => String(x.ruleId) === 'demo.boom')!;
  ok(f.severity === 'error' && !!('remedy' in f && f.remedy), '抛错规则必须转成带 remedy 的 error');
  has(r, 'demo.custom', 'info'); // 一条规则炸了不影响其余

  off();
  ok(reg.size === 21 && !reg.run(healthy()).findings.some((x) => String(x.ruleId) === 'demo.custom'));
});

test('重复规则 id 被拒绝，last() 保留最近一次报告', () => {
  const reg = new AuditRegistry();
  let threw = false;
  try {
    registerBuiltinRules(reg);
    registerBuiltinRules(reg);
  } catch { threw = true; }
  ok(threw && reg.size === 20, '重复注册必须报错且不破坏注册表');
  ok(reg.last() === null);
  const r = reg.run(healthy());
  ok(reg.last() === r && r.ok);
});

test('ServiceRegistry.inspect 能看见「被查询但无实现」的令牌', () => {
  const sr = new ServiceRegistry();
  const T = new ServiceToken<number>('probe.missing');
  sr.tryGet(T);
  const snap = sr.inspect();
  ok(snap.some((s) => s.id === 'probe.missing' && !s.provided && s.owners.length === 0),
    JSON.stringify(snap));
  sr.provide(T, 7);
  ok(sr.inspect().find((s) => s.id === 'probe.missing')?.provided === true);
});

test('BinaryHub.inspect 区分系统保留 tag 与插件申领 tag', () => {
  const bh = new BinaryHub();
  const tag = bh.claimTag('demo.owner', 3);
  const snap = bh.inspect();
  ok(snap.claimedTags.includes(tag), `tag=${tag}`);
  ok(!snap.reservedTags.includes(tag), 'claimTag 不应分到系统段');
  ok(snap.migrationLabels.some((l) => /^1→2/.test(l)));
  ok(snap.issues.length === 0);
});

console.log(`\n结果：${pass}/${pass + fail} 通过`);
if (fail > 0) process.exitCode = 1;
