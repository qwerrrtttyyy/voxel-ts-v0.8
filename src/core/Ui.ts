/** 快捷栏槽位的最小形状（避免 Ui 反向依赖 Inventory 实现） */
export interface HotbarSlot {
  label: string;
  tileKey: string | null;
  emissive: boolean;
}

export type ToastKind = 'info' | 'good' | 'warn' | 'achievement';

/**
 * HUD / 菜单 DOM 的薄封装。
 * 所有元素缺失时（嵌入、Node 自检）一律降级为 no-op，绝不因为 DOM 不存在而崩溃。
 */
export class Ui {
  private readonly overlay = document.getElementById('overlay');
  private readonly startBtn = document.getElementById('start');
  private readonly hud = document.getElementById('hud');
  private readonly target = document.getElementById('target');
  private readonly clock = document.getElementById('clock-badge');
  private readonly hotbar = document.getElementById('hotbar');
  private readonly toasts = document.getElementById('toasts');
  /** v0.6：入水 / 置于实体内时的全屏色罩，位于 canvas 之上、HUD 之下 */
  private readonly tint = document.getElementById('tint');

  /** v0.2 兼容入口：新主菜单不再有 #start，这里会自然降级为 no-op */
  onStart(cb: () => void): () => void {
    if (!this.overlay || !this.startBtn) return () => {};
    const handler = (e: MouseEvent): void => {
      e.stopPropagation();
      cb();
    };
    this.startBtn.addEventListener('click', handler);
    this.overlay.addEventListener('click', handler);
    return () => {
      this.startBtn?.removeEventListener('click', handler);
      this.overlay?.removeEventListener('click', handler);
    };
  }

  setLocked(locked: boolean): void {
    this.overlay?.classList.toggle('hidden', locked);
  }

  setHud(text: string): void {
    if (this.hud) this.hud.textContent = text;
  }

  setTarget(text: string): void {
    if (this.target) this.target.textContent = text;
  }

  setClock(text: string): void {
    if (this.clock) this.clock.textContent = text;
  }

  /** 传入 '' 恢复透明；DOM 缺失时静默降级，Node 自检不会崩 */
  setTint(css: string): void {
    if (!this.tint) return;
    this.tint.style.backgroundColor = css;
    this.tint.style.opacity = css ? '1' : '0';
  }

  setHotbarVisible(v: boolean): void {
    this.hotbar?.classList.toggle('hidden', !v);
  }

  /** 用 atlas 的真实像素画图标：插件新方块无需准备图片资源就能出现在快捷栏 */
  renderHotbar(
    slots: readonly (HotbarSlot | null)[],
    selected: number,
    pixels: (key: string) => Uint8Array | null,
  ): void {
    if (!this.hotbar) return;
    const html = slots.map((s, i) => {
      const cls = `slot${i === selected ? ' sel' : ''}${s?.emissive ? ' glow' : ''}${!s ? ' empty' : ''}`;
      const img = s?.tileKey ? `<img src="${this.icon(s.tileKey, pixels)}" alt="" />` : '';
      const key = `<span class="slot-key">${i + 1}</span>`;
      return `<div class="${cls}" title="${s?.label ?? '空'}">${key}${img}</div>`;
    }).join('');
    this.hotbar.innerHTML = html;
  }

  private icon(key: string, pixels: (key: string) => Uint8Array | null): string {
    if (typeof document.createElement !== 'function') return '';
    const px = pixels(key);
    if (!px) return '';
    try {
      const cv = document.createElement('canvas') as HTMLCanvasElement;
      cv.width = 16; cv.height = 16;
      const g = cv.getContext('2d');
      if (!g) return '';
      const img = g.createImageData(16, 16);
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          const src = (y * 16 + x) * 4;
          const dst = ((15 - y) * 16 + x) * 4; // tile 的 y=0 在底部，翻转成屏幕坐标
          img.data[dst] = px[src];
          img.data[dst + 1] = px[src + 1];
          img.data[dst + 2] = px[src + 2];
          img.data[dst + 3] = 255;
        }
      }
      g.putImageData(img, 0, 0);
      return cv.toDataURL('image/png');
    } catch { return ''; }
  }

  toast(text: string, kind: ToastKind = 'info'): void {
    if (!this.toasts || typeof document.createElement !== 'function') return;
    try {
      const el = document.createElement('div');
      el.className = `toast ${kind}`;
      el.textContent = text;
      this.toasts.appendChild(el);
      window.setTimeout(() => {
        el.classList.add('out');
        window.setTimeout(() => el.remove(), 320);
      }, 3000);
    } catch { /* DOM 不可用时静默 */ }
  }
}
