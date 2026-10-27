/** 页面内浮层提示：右键菜单 / 快捷键触发时显示进度与结果（无弹窗场景）。 */

const CSS = `
  :host { all: initial; }
  .w2m {
    position: fixed;
    right: 20px;
    bottom: 20px;
    z-index: 2147483647;
    width: 340px;
    max-width: calc(100vw - 32px);
    background: rgba(14, 23, 38, 0.96);
    color: #fff;
    border-radius: 14px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    box-shadow: 0 18px 48px -12px rgba(15, 23, 42, 0.55);
    font: 13px/1.5 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
    padding: 13px 14px 12px;
    opacity: 0;
    transform: translateY(10px);
    transition: opacity .18s ease, transform .18s ease;
    pointer-events: none;
    backdrop-filter: blur(8px);
  }
  .w2m.show { opacity: 1; transform: translateY(0); }
  .row { display: flex; align-items: flex-start; gap: 9px; }
  .icon {
    flex: none;
    width: 18px; height: 18px; border-radius: 50%;
    margin-top: 1px;
    display: flex; align-items: center; justify-content: center;
    font-size: 11px; font-weight: 700;
    background: linear-gradient(135deg, #6366f1, #8b5cf6);
  }
  .icon.ok { background: #10b981; }
  .icon.err { background: #ef4444; }
  .icon.spin { background: none; border: 2px solid rgba(255,255,255,.25); border-top-color: #a5b4fc; }
  .icon.spin::after { content: ""; }
  .spin { animation: w2m-spin .8s linear infinite; }
  @keyframes w2m-spin { to { transform: rotate(360deg); } }
  .text { min-width: 0; flex: 1; }
  .title { font-weight: 600; font-size: 13px; word-break: break-word; }
  .sub { margin-top: 3px; font-size: 11.5px; color: rgba(255,255,255,.62); word-break: break-word; }
  .bar { margin-top: 9px; height: 3px; border-radius: 999px; background: rgba(255,255,255,.14); overflow: hidden; display: none; }
  .bar.on { display: block; }
  .bar > i { display: block; height: 100%; width: 0; border-radius: 999px; background: linear-gradient(90deg, #818cf8, #c084fc); transition: width .25s ease; }
  .err .title { color: #fecaca; }
`;

export class Toast {
  private host: HTMLElement | null = null;
  private root: ShadowRoot | null = null;
  private hideTimer = 0;
  private titleEl: HTMLElement | null = null;
  private subEl: HTMLElement | null = null;
  private iconEl: HTMLElement | null = null;
  private barEl: HTMLElement | null = null;
  private fillEl: HTMLElement | null = null;

  private ensure(): void {
    if (this.host?.isConnected) return;
    const host = document.createElement('div');
    host.id = 'w2m-toast-host';
    host.style.cssText = 'all: initial; position: fixed; inset: auto 0 0 auto; z-index: 2147483647;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>${CSS}</style>
      <div class="w2m" part="card">
        <div class="row">
          <div class="icon spin"></div>
          <div class="text">
            <div class="title"></div>
            <div class="sub"></div>
          </div>
        </div>
        <div class="bar"><i></i></div>
      </div>`;
    document.documentElement.appendChild(host);
    this.host = host;
    this.root = root;
    this.titleEl = root.querySelector('.title');
    this.subEl = root.querySelector('.sub');
    this.iconEl = root.querySelector('.icon');
    this.barEl = root.querySelector('.bar');
    this.fillEl = root.querySelector('.bar > i');
  }

  private reveal(): void {
    this.ensure();
    const card = this.root?.querySelector('.w2m') as HTMLElement | null;
    // 强制 reflow 让过渡生效
    void card?.offsetHeight;
    card?.classList.add('show');
    window.clearTimeout(this.hideTimer);
  }

  set(message: string, sub = ''): void {
    this.reveal();
    if (this.titleEl) this.titleEl.textContent = message;
    if (this.subEl) this.subEl.textContent = sub;
    if (this.iconEl) this.iconEl.className = 'icon spin';
    this.setProgress(undefined);
  }

  setProgress(value: number | undefined, total?: number): void {
    if (!this.barEl || !this.fillEl) return;
    if (value === undefined || !total) {
      this.barEl.classList.remove('on');
      return;
    }
    this.barEl.classList.add('on');
    const pct = Math.max(2, Math.min(100, Math.round((value / total) * 100)));
    this.fillEl.style.width = `${pct}%`;
  }

  success(title: string, sub = ''): void {
    this.reveal();
    if (this.titleEl) this.titleEl.textContent = title;
    if (this.subEl) this.subEl.textContent = sub;
    if (this.iconEl) {
      this.iconEl.className = 'icon ok';
      this.iconEl.textContent = '✓';
    }
    this.setProgress(undefined);
    this.hideTimer = window.setTimeout(() => this.hide(), 5000);
  }

  error(message: string): void {
    this.reveal();
    if (this.titleEl) this.titleEl.textContent = message;
    if (this.subEl) this.subEl.textContent = '';
    if (this.iconEl) {
      this.iconEl.className = 'icon err';
      this.iconEl.textContent = '!';
    }
    this.setProgress(undefined);
    this.hideTimer = window.setTimeout(() => this.hide(), 8000);
  }

  hide(): void {
    const card = this.root?.querySelector('.w2m') as HTMLElement | null;
    card?.classList.remove('show');
    window.setTimeout(() => {
      this.host?.remove();
      this.host = null;
      this.root = null;
    }, 250);
  }
}
