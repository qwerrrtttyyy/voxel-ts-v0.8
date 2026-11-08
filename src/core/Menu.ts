import type * as THREE from 'three';
import type { ServiceRegistry } from './ServiceRegistry';
import type { GameState, Settings } from './GameState';
import type { DayCycle } from './DayCycle';
import type { PluginCatalog, CatalogEntry } from './PluginCatalog';
import type { Input } from './Input';
import type { Ui } from './Ui';
import type { World } from '../world/World';
import type { BlockRegistry } from '../world/BlockRegistry';
import { CHUNK_SIZE, WORLD_CHUNKS } from '../config';
import {
  AUDIT_API, CHUNK_VIEW, DAY_CYCLE, FIRST_PERSON, GENERATOR, PROFILER,
  SAVE_API, SAVE_STORE, type SaveApi,
} from './tokens';

export interface MenuDeps {
  game: GameState;
  catalog: PluginCatalog;
  services: ServiceRegistry;
  input: Input;
  ui: Ui;
  world: World;
  blocks: BlockRegistry;
  camera: THREE.PerspectiveCamera;
  /** 生成新地形 + 重建网格 + 重生玩家（由 main 提供，避免 Menu 依赖策略细节） */
  onNewWorld: () => void;
}

const EXAMPLE_SOURCE = `export default {
  id: 'demo.pulse',
  version: '1.0.0',
  meta: {
    label: '示例 · 脉冲信标',
    description: '粘贴源码即时编译的第三方插件，注册一个发光方块',
    category: 'remote', author: 'you', badge: 'DM',
  },
  provides: ['cap:demo.pulse'],
  setup(ctx) {
    const tile = ctx.scope.tile('pulse', (set, s) => {
      for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
        set(x, y, 255, 110 + ((x * 9) % 120), 70 + ((y * 7) % 80), 255);
      }
    });
    const id = ctx.scope.block('pulse', {
      opaque: false, solid: true, emissive: true, all: tile,
    });
    ctx.log('demo.pulse hot-loaded, block id = ' + id);
  },
};`;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c] ?? c);
}

/** 主菜单 / 暂停 / 设置 / 插件仓库 / 存档 / 说明 的 UI 状态机 */
export class Menu {
  private readonly root: HTMLElement | null;
  private readonly pages: HTMLElement[];
  private current = 'main';
  private origin: 'main' | 'pause' = 'main';
  private timer = 0;
  private lastAo: boolean;
  private readonly unsubscribers: Array<() => void> = [];

  constructor(private readonly d: MenuDeps) {
    this.root = document.getElementById('menu');
    this.pages = Array.from(document.querySelectorAll<HTMLElement>('.page'));
    this.lastAo = d.game.settings.ao;

    if (this.root) {
      this.root.addEventListener('click', this.onClick);
      for (const el of Array.from(this.root.querySelectorAll<HTMLElement>('[data-setting]'))) {
        el.addEventListener('input', () => this.applySetting(el));
        el.addEventListener('change', () => this.applySetting(el));
      }
    }
    document.addEventListener('pointerlockchange', this.onLockChange);

    this.unsubscribers.push(d.game.onChange(() => {
      this.inputSideEffects();
      if (this.current === 'settings') this.syncValues();
    }));
    this.unsubscribers.push(d.catalog.onChange(() => {
      if (this.current === 'plugins') this.renderPlugins();
      this.refreshCounts();
    }));
    this.timer = window.setInterval(() => {
      this.refreshSide();
      if (this.current === 'plugins') this.renderPerf();
    }, 1200);
    this.refreshCounts();
  }

  // ---------- 页面切换 ----------
  show(page: string, origin: 'main' | 'pause' = this.origin): void {
    if (!this.root) return;
    this.origin = origin;
    this.current = page;
    this.root.classList.remove('hidden');
    for (const p of this.pages) p.classList.toggle('active', p.dataset.page === page);
    this.d.game.setPaused(true, page === 'pause' ? 'escape' : 'menu');
    this.d.ui.setHotbarVisible(false);
    this.d.ui.setHud('');
    if (page === 'main') void this.refreshContinue();
    if (page === 'settings') this.syncSettings(true);
    if (page === 'plugins') this.renderPlugins();
    if (page === 'audit') this.renderAudit(false);
    if (page === 'saves') void this.renderSaves();
    this.refreshSide();
    this.scrollTop();
  }

  openMain(): void { this.show('main', 'main'); }
  openPause(): void { this.show('pause', 'pause'); }

  private scrollTop(): void {
    const body = this.root?.querySelector<HTMLElement>('.menu-body');
    if (body) body.scrollTop = 0;
  }

  /** 进入游戏：隐藏菜单、恢复循环、请求指针锁定 */
  enter(): void {
    if (!this.root) return;
    this.root.classList.add('hidden');
    this.d.game.started = true;
    this.d.game.setPaused(false, 'resume');
    this.d.ui.setHotbarVisible(this.d.game.settings.showHud !== false);
    this.d.input.requestLock();
  }

  private readonly onLockChange = (): void => {
    if (!this.d.input.state.locked && this.d.game.started && !this.d.game.paused) {
      this.openPause();
    }
  };

  // ---------- 事件委托 ----------
  private readonly onClick = (e: MouseEvent): void => {
    const el = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-action]');
    if (!el) return;
    e.stopPropagation();
    const action = el.dataset.action ?? '';
    const id = el.dataset.id ?? '';
    switch (action) {
      case 'goto': this.show(el.dataset.target ?? 'main'); break;
      case 'back': this.show(this.origin); break;
      case 'main': this.openMain(); break;
      case 'resume': this.enter(); break;
      case 'new': this.d.onNewWorld(); this.enter(); this.d.ui.toast('新世界已生成 · 左键挖 / 右键放', 'good'); break;
      case 'continue': void this.continueWorld(); break;
      case 'reset-settings': this.d.game.resetSettings(); this.syncSettings(true); break;
      case 'toggle': void this.d.catalog.setEnabled(id, !this.d.catalog.get(id)?.enabled); break;
      case 'reload': void this.d.catalog.reload(id); break;
      case 'remove': void this.d.catalog.remove(id); break;
      case 'audit-run': this.renderAudit(true); break;
      case 'install-url': void this.installUrl(); break;
      case 'install-source': void this.installSource(); break;
      case 'fill-example': {
        const ta = document.getElementById('plugin-source') as HTMLTextAreaElement | null;
        if (ta) ta.value = EXAMPLE_SOURCE;
        this.status('已填入示例源码，点「编译并加载」即可热加载', false);
        break;
      }
      case 'save': void this.saveSlot(Number(el.dataset.slot)); break;
      case 'load': void this.loadSlot(Number(el.dataset.slot)); break;
      case 'delete': void this.deleteSlot(Number(el.dataset.slot)); break;
      case 'export': void this.api()?.export(Number(el.dataset.slot)); break;
      case 'import': void this.importFile(); break;
      default: break;
    }
  };

  // ---------- 设置 ----------
  private applySetting(el: HTMLElement): void {
    const key = el.dataset.setting as keyof Settings | 'phase' | undefined;
    if (!key) return;
    const input = el as HTMLInputElement;
    if (key === 'phase') {
      const cycle = this.d.services.tryGet(DAY_CYCLE);
      cycle?.setPhase(Number(input.value));
      this.syncValue('phase', cycle ? cycle.clock() : '');
      return;
    }
    if (key === 'mode') {
      this.d.game.setMode(input.value as Settings['mode']);
      this.d.input.allowFly = input.value === 'creative';
    } else if (input.type === 'checkbox') {
      this.d.game.setSetting(key, input.checked as never);
    } else {
      this.d.game.setSetting(key, Number(input.value) as never);
    }
    this.syncValues();
    this.inputSideEffects();
  }

  private inputSideEffects(): void {
    const s = this.d.game.settings;
    this.d.input.sensitivity = s.sensitivity;
    this.d.input.allowFly = s.mode === 'creative';
    if (Math.abs(this.d.camera.fov - s.fov) > 0.01) {
      this.d.camera.fov = s.fov;
      this.d.camera.updateProjectionMatrix();
    }
    // 顶点 AO 是烘焙进顶点色的，开关后必须整体重建一次
    if (s.ao !== this.lastAo) {
      this.lastAo = s.ao;
      const view = this.d.services.tryGet(CHUNK_VIEW);
      try { view?.rebuildAll(); } catch { /* 视图可能正在热插拔 */ }
    }
    this.d.ui.setHotbarVisible(!this.d.game.paused && s.showHud);
  }

  private syncSettings(writeValues: boolean): void {
    const s = this.d.game.settings;
    for (const el of Array.from(this.root?.querySelectorAll<HTMLElement>('[data-setting]') ?? [])) {
      const key = el.dataset.setting as keyof Settings | 'phase';
      const input = el as HTMLInputElement;
      if (key === 'phase') {
        const cycle = this.d.services.tryGet(DAY_CYCLE);
        if (writeValues && cycle) input.value = String(cycle.phase);
        continue;
      }
      const v = s[key];
      if (typeof v === 'boolean') input.checked = v;
      else input.value = String(v);
    }
    this.syncValues();
  }

  private syncValues(): void {
    const s = this.d.game.settings;
    const cycle = this.d.services.tryGet(DAY_CYCLE);
    const map: Record<string, string> = {
      timeScale: `${s.timeScale}×`, phase: cycle?.clock() ?? '',
      viewDistance: `${s.viewDistance.toFixed(1)}×`, sensitivity: s.sensitivity.toFixed(1),
      fov: `${s.fov}°`,
    };
    for (const [k, v] of Object.entries(map)) this.syncValue(k, v);
  }

  private syncValue(key: string, text: string): void {
    const el = this.root?.querySelector<HTMLElement>(`[data-value="${key}"]`);
    if (el) el.textContent = text;
  }

  // ---------- 插件仓库 ----------
  private renderPlugins(): void {
    const list = document.getElementById('plugin-list');
    if (!list) return;
    const entries = this.d.catalog.list();
    const order = ['core', 'world', 'render', 'gameplay', 'extension', 'community', 'remote'];
    entries.sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category) || a.id.localeCompare(b.id));
    list.innerHTML = entries.map((e) => this.pluginHtml(e)).join('');
    this.renderPerf();

    const s = this.d.catalog.stats;
    const strip = document.getElementById('catalog-stats');
    if (strip) {
      strip.innerHTML = [
        ['全部', s.total], ['启用', s.enabled], ['已加载', s.loaded], ['运行时', s.remote],
      ].map(([k, v]) => `<div class="stat"><b>${v}</b><span>${k}</span></div>`).join('');
    }
  }

  /** v0.6：逐插件回调耗时 Top 5，直接回答「谁在吃帧」 */
  private renderPerf(): void {
    const el = document.getElementById('perf-stats');
    if (!el) return;
    const api = this.d.services.tryGet(PROFILER);
    if (!api) {
      el.innerHTML = '<div class="perf-empty">性能画像插件未启用</div>';
      return;
    }
    const top = api.top(5);
    const slow = api.slowCount();
    const rows = top.length
      ? top.map((s) => `<div class="perf-row"><span>${esc(s.label)} · ${s.calls} 次${s.slow ? ` · 慢 ${s.slow}` : ''}</span><b>${s.totalMs.toFixed(1)}ms / 峰值 ${s.maxMs.toFixed(1)}ms</b></div>`).join('')
      : '<div class="perf-empty">暂无采样，进入游戏后开始统计</div>';
    el.innerHTML = `<div class="perf-title">回调耗时画像 · 慢回调累计 ${slow}</div>${rows}`;
  }

  /** v0.8：深度审批报告 —— 规则由插件注册，报告每次从运行时重新采样 */
  private renderAudit(rerun: boolean): void {
    const sum = document.getElementById('audit-summary');
    const list = document.getElementById('audit-findings');
    if (!sum || !list) return;
    const api = this.d.services.tryGet(AUDIT_API);
    if (!api) {
      sum.innerHTML = '<div class="stat"><b>—</b><span>未启用</span></div>';
      list.innerHTML = '<div class="perf-empty">「深度审批」插件未启用，可在插件仓库打开</div>';
      return;
    }
    const report = rerun || !api.last() ? api.run() : api.last()!;
    const stats: Array<[string, number]> = [
      ['规则', report.rules], ['错误', report.counts.error],
      ['警告', report.counts.warn], ['提示', report.counts.info],
    ];
    sum.innerHTML = stats.map(([k, v]) => `<div class="stat"><b>${v}</b><span>${k}</span></div>`).join('');
    const order = { error: 0, warn: 1, info: 2 } as const;
    const rows = [...report.findings].sort((a, b) => order[a.severity] - order[b.severity]);
    list.innerHTML = rows.length
      ? rows.map((f) => `<div class="audit-row ${f.severity}">
          <div class="audit-head"><b>${esc(f.ruleId)}</b><span>${esc(f.category)}</span></div>
          <div class="audit-msg">${esc(f.message)}</div>
          ${f.detail ? `<div class="audit-detail">${esc(f.detail)}</div>` : ''}
          ${'remedy' in f && f.remedy ? `<div class="audit-remedy">建议：${esc(f.remedy)}</div>` : ''}
        </div>`).join('')
      : '<div class="perf-empty">全部规则通过，无发现项</div>';
  }

  private pluginHtml(e: CatalogEntry): string {
    const tags = [
      ...e.provides.slice(0, 2).map((p) => `+${p}`),
      ...e.dependencies.slice(0, 1).map((p) => `→${p}`),
      e.source === 'builtin' ? '内核' : e.source === 'url' ? 'URL' : e.source === 'source' ? '源码' : e.source,
      ...(e.sandboxed ? ['受限沙箱'] : []),
      ...e.capabilities.map((c) => `权限:${c}`),
    ];
    const impact = e.enabled ? this.d.catalog.impactOf(e.id) : [];
    const tip = e.required
      ? '内核必需，不可关闭'
      : impact.length
        ? `停用将连带停用 ${impact.length} 个插件：${impact.join('、')}`
        : '开关（即时热插拔）';
    return `<div class="plugin ${esc(e.source)}">
      <div class="badge">${esc(e.badge)}</div>
      <div class="info">
        <div class="name">${esc(e.label)}<em>v${esc(e.version)} · ${esc(e.author)}</em></div>
        <div class="desc">${esc(e.description)}</div>
        <div class="tags">${tags.map((t) => `<i>${esc(t)}</i>`).join('')}${e.loaded ? '<i style="color:#9be36d">运行中</i>' : ''}</div>
        ${e.error ? `<div class="desc" style="color:#ffb08c">加载失败：${esc(e.error)}</div>` : ''}
      </div>
      <div class="ops">
        <div class="switch ${e.enabled ? 'on' : ''} ${e.required ? 'locked' : ''}"
             data-action="toggle" data-id="${esc(e.id)}" title="${esc(tip)}"></div>
        <div>
          <button class="mini" data-action="reload" data-id="${esc(e.id)}">重载</button>
          ${e.removable ? `<button class="mini danger" data-action="remove" data-id="${esc(e.id)}">移除</button>` : ''}
        </div>
      </div>
    </div>`;
  }

  private status(text: string, error: boolean): void {
    const el = document.getElementById('install-status');
    if (!el) return;
    el.textContent = text;
    el.className = `install-status ${error ? 'err' : 'ok'}`;
  }

  private async installUrl(): Promise<void> {
    const input = document.getElementById('plugin-url') as HTMLInputElement | null;
    if (!input) return;
    try {
      this.status('正在动态 import…', false);
      const e = await this.d.catalog.installFromUrl(input.value);
      this.status(`已热加载 ${e.label}，新方块已自动进入快捷栏`, false);
    } catch (err) {
      this.status(`安装失败：${String(err)}`, true);
    }
  }

  private async installSource(): Promise<void> {
    const ta = document.getElementById('plugin-source') as HTMLTextAreaElement | null;
    if (!ta) return;
    try {
      this.status('正在编译 Blob URL 并动态 import…', false);
      const e = await this.d.catalog.installFromSource(ta.value);
      this.status(`已热加载 ${e.label}，无需重建、无需刷新`, false);
    } catch (err) {
      this.status(`加载失败：${String(err)}`, true);
    }
  }

  // ---------- 存档 ----------
  private api(): SaveApi | undefined { return this.d.services.tryGet(SAVE_API); }

  private async renderSaves(): Promise<void> {
    const el = document.getElementById('save-list');
    if (!el) return;
    const store = this.d.services.tryGet(SAVE_STORE);
    const metas = await (this.api()?.list() ?? store?.list() ?? Promise.resolve([]));
    const bySlot = new Map(metas.map((m) => [m.slot, m]));
    el.innerHTML = [0, 1, 2].map((slot) => {
      const m = bySlot.get(slot);
      const when = m ? new Date(m.createdAt).toLocaleString('zh-CN', { hour12: false }) : '空槽位';
      const size = m ? `${(m.bytes / 1024).toFixed(1)} KB` : '—';
      return `<div class="save-item">
        <div class="top"><span>槽位 ${slot + 1} · ${esc(m?.name ?? '未使用')}</span><span>${size}</span></div>
        <div class="meta">${when}${this.api() ? '' : ' · 存档插件未启用'}</div>
        <div class="ops">
          <button class="mini" data-action="save" data-slot="${slot}">保存</button>
          <button class="mini" data-action="load" data-slot="${slot}" ${m ? '' : 'disabled'}>读取</button>
          <button class="mini" data-action="export" data-slot="${slot}" ${m ? '' : 'disabled'}>导出 .bin</button>
          ${m ? `<button class="mini danger" data-action="delete" data-slot="${slot}">删除</button>` : ''}
        </div>
      </div>`;
    }).join('');
  }

  private async continueWorld(): Promise<void> {
    const ok = await this.api()?.load(0);
    if (!ok) { this.d.ui.toast('槽位 1 暂无存档，请先开始新世界', 'warn'); return; }
    this.enter();
  }

  private async saveSlot(slot: number): Promise<void> {
    if (!this.api()) { this.d.ui.toast('存档插件未启用', 'warn'); return; }
    await this.api()!.save(slot);
    this.d.ui.toast(`已保存到槽位 ${slot + 1}`, 'good');
    await this.renderSaves();
  }

  private async loadSlot(slot: number): Promise<void> {
    const ok = await this.api()?.load(slot);
    if (!ok) { this.d.ui.toast('读取失败', 'warn'); return; }
    await this.renderSaves();
  }

  private async deleteSlot(slot: number): Promise<void> {
    await this.api()?.remove(slot);
    await this.renderSaves();
  }

  private async importFile(): Promise<void> {
    const f = document.getElementById('save-file') as HTMLInputElement | null;
    const sel = document.getElementById('import-slot') as HTMLSelectElement | null;
    const file = f?.files?.[0];
    if (!file) { this.d.ui.toast('请先选择 .bin 文件', 'warn'); return; }
    try {
      await this.api()?.import(file, Number(sel?.value ?? 0));
      await this.renderSaves();
    } catch (err) {
      this.d.ui.toast(`导入失败：${String(err)}`, 'warn');
    }
  }

  private async refreshContinue(): Promise<void> {
    const hint = document.getElementById('continue-hint');
    const btn = this.root?.querySelector<HTMLElement>('[data-action="continue"]');
    const metas = await (this.api()?.list() ?? Promise.resolve([]));
    const m = metas.find((x) => x.slot === 0);
    if (hint) hint.textContent = m ? `最近：${m.name}` : '暂无存档，先开始新世界';
    if (btn) btn.classList.toggle('disabled', !m);
  }

  // ---------- 右侧状态与计数 ----------
  private refreshCounts(): void {
    const el = document.getElementById('plugin-count');
    if (el) el.textContent = String(this.d.catalog.stats.loaded);
  }

  private refreshSide(): void {
    const el = document.getElementById('side-info');
    if (!el || !this.root || this.root.classList.contains('hidden')) return;
    const cycle = this.d.services.tryGet(DAY_CYCLE);
    const rows: Array<[string, string]> = [
      ['时间', cycle?.clock() ?? '—'],
      ['模式', this.d.game.mode === 'creative' ? '创造' : '生存'],
      ['区块', String(this.d.world.keys().length)],
      ['方块种类', String(this.d.blocks.all().length)],
      ['插件', `${this.d.catalog.stats.loaded}/${this.d.catalog.stats.total}`],
      ['物理', this.d.services.get(CHUNK_VIEW).mesherId],
    ];
    el.innerHTML = rows.map(([k, v]) => `<div><span>${k}</span><b>${esc(v)}</b></div>`).join('');
  }

  dispose(): void {
    window.clearInterval(this.timer);
    for (const off of this.unsubscribers) off();
    this.unsubscribers.length = 0;
    document.removeEventListener('pointerlockchange', this.onLockChange);
    this.root?.removeEventListener('click', this.onClick);
  }
}

/** 供 main.ts 使用的新世界生成辅助（集中在这里，Menu 不碰具体策略） */
export function regenerateWorld(d: Pick<MenuDeps, 'services' | 'world'>): void {
  const view = d.services.get(CHUNK_VIEW);
  const gen = d.services.get(GENERATOR);
  const ctrl = d.services.get(FIRST_PERSON);
  d.world.setGenerator(gen);
  // v0.6：新世界要把滑动窗口拉回出生点，否则会按「上一个世界玩家跑到的位置」
  // 生成一整窗 chunk，随即又因玩家重生再生成一遍。
  if (d.world.streamInfo.enabled) {
    const spawnChunk = Math.floor(WORLD_CHUNKS / 2);
    d.world.enableStreaming({ centerCx: spawnChunk, centerCz: spawnChunk });
  }
  d.world.pregenerate();
  view.rebuildAll();
  const c = (WORLD_CHUNKS * CHUNK_SIZE) / 2;
  ctrl.spawn(c + 0.5, c + 0.5);
}
