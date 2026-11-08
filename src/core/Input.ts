export interface InputState {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  jump: boolean;
  sprint: boolean;
  down: boolean;
  /** v0.3：鼠标左 / 右键是否按住 */
  attack: boolean;
  use: boolean;
  /** v0.3：创造模式飞行开关（双击 Space 切换） */
  flying: boolean;
  lookX: number;
  lookY: number;
  locked: boolean;
}

export interface PressCount { primary: number; secondary: number }

/**
 * 只输出「意图」，不碰相机、不碰世界。
 * v0.3 增加：鼠标按键 / 滚轮 / 数字键 / 双击空格飞行 / 灵敏度，
 * 全部通过 consume* 由插件按需取用，避免多个插件抢同一事件。
 */
export class Input {
  readonly state: InputState = {
    forward: false, back: false, left: false, right: false,
    jump: false, sprint: false, down: false,
    attack: false, use: false, flying: false,
    lookX: 0, lookY: 0, locked: false,
  };

  /** 鼠标灵敏度倍率（设置面板可改，控制器读取） */
  sensitivity = 1;
  /** 生存模式置 false，禁止飞行 */
  allowFly = true;

  private readonly keys = new Set<string>();
  private readonly pressed = new Set<string>();
  private press: PressCount = { primary: 0, secondary: 0 };
  private wheel = 0;
  private digits: number[] = [];
  private lastSpaceUp = 0;

  constructor(private readonly el: HTMLElement) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('pointerlockchange', this.onLockChange);
    document.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('mousedown', this.onMouseDown);
    document.addEventListener('mouseup', this.onMouseUp);
    document.addEventListener('wheel', this.onWheel, { passive: true });
    this.el.addEventListener('contextmenu', this.onContextMenu);
  }

  requestLock(): void {
    void this.el.requestPointerLock();
  }

  /** 读取并清空本帧累计的鼠标位移 */
  consumeLook(): { x: number; y: number } {
    const r = { x: this.state.lookX, y: this.state.lookY };
    this.state.lookX = 0;
    this.state.lookY = 0;
    return r;
  }

  /** 单次点击边沿（左=primary 破坏，右=secondary 放置） */
  consumePress(): PressCount {
    const r = this.press;
    this.press = { primary: 0, secondary: 0 };
    return r;
  }

  /** 滚轮累积量，正值向下滚 */
  consumeWheel(): number {
    const w = this.wheel;
    this.wheel = 0;
    return w;
  }

  /** 数字键 1~9，返回槽位下标 0~8 */
  consumeDigits(): number[] {
    const d = this.digits;
    this.digits = [];
    return d;
  }

  /** 取走一次「本帧刚按下」的键；不同插件读不同 code 互不干扰 */
  consumeKey(code: string): boolean {
    if (!this.pressed.has(code)) return false;
    this.pressed.delete(code);
    return true;
  }

  isDown(code: string): boolean {
    return this.keys.has(code);
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    this.keys.add(e.code);
    if (!e.repeat) {
      this.pressed.add(e.code);
      const m = /^Digit([1-9])$/.exec(e.code);
      if (m) this.digits.push(Number(m[1]) - 1);
    }
    // 只在锁定指针时拦截按键，未进入世界时不破坏 Tab 焦点导航
    if (this.state.locked && (e.code === 'Space' || e.code === 'Tab')) e.preventDefault();
    this.sync();
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
    // 双击 Space 切换飞行（仅创造模式 + 指针锁定状态）
    if (e.code === 'Space') {
      const now = Date.now();
      if (this.allowFly && this.state.locked && now - this.lastSpaceUp < 320) {
        this.state.flying = !this.state.flying;
      }
      this.lastSpaceUp = now;
    }
    this.sync();
  };

  private readonly onBlur = (): void => {
    this.keys.clear();
    this.clearActions();
    this.sync();
  };

  private readonly onLockChange = (): void => {
    this.state.locked = document.pointerLockElement === this.el;
    if (!this.state.locked) {
      this.keys.clear();
      this.state.lookX = 0;
      this.state.lookY = 0; // 残留的鼠标位移会在重新锁定时造成视角跳变
      this.clearActions();
      this.sync();
    }
  };

  private readonly onMouseMove = (e: MouseEvent): void => {
    if (!this.state.locked) return;
    this.state.lookX += e.movementX;
    this.state.lookY += e.movementY;
  };

  private readonly onMouseDown = (e: MouseEvent): void => {
    if (!this.state.locked) return;
    if (e.button === 0) { this.press.primary++; this.state.attack = true; }
    if (e.button === 2) { this.press.secondary++; this.state.use = true; }
  };

  private readonly onMouseUp = (e: MouseEvent): void => {
    if (e.button === 0) this.state.attack = false;
    if (e.button === 2) this.state.use = false;
  };

  private readonly onWheel = (e: WheelEvent): void => {
    if (!this.state.locked) return;
    this.wheel += Math.sign(e.deltaY);
  };

  private readonly onContextMenu = (e: Event): void => {
    if (this.state.locked) e.preventDefault();
  };

  private clearActions(): void {
    this.press = { primary: 0, secondary: 0 };
    this.wheel = 0;
    this.digits = [];
    this.pressed.clear();
    this.state.attack = false;
    this.state.use = false;
    this.state.flying = false;
  }

  private sync(): void {
    const s = this.state;
    s.forward = this.keys.has('KeyW') || this.keys.has('ArrowUp');
    s.back = this.keys.has('KeyS') || this.keys.has('ArrowDown');
    s.left = this.keys.has('KeyA') || this.keys.has('ArrowLeft');
    s.right = this.keys.has('KeyD') || this.keys.has('ArrowRight');
    s.jump = this.keys.has('Space');
    s.sprint = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    s.down = this.keys.has('ControlLeft') || this.keys.has('KeyC');
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('pointerlockchange', this.onLockChange);
    document.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('mousedown', this.onMouseDown);
    document.removeEventListener('mouseup', this.onMouseUp);
    document.removeEventListener('wheel', this.onWheel);
    this.el.removeEventListener('contextmenu', this.onContextMenu);
    this.clearActions();
  }
}
