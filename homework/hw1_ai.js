/* =========================================================================
   hw1_ai.js · 常州家乡页交互脚本
   -------------------------------------------------------------------------
   纯原生 JavaScript（无依赖 / 无构建 / 无网络请求），由 ./hw1_ai.html 以
   <script src="./hw1_ai.js" defer> 引入。职责：

     1) 单一 rAF 调度器 + 统一“动效开关”（手动暂停 / prefers-reduced-motion）
     2) 顶栏滚动状态、阅读进度、回顶部、移动端菜单
     3) 首屏 hero 随滚动写入 --hero-progress（裁切/缩放/标题拆分由 CSS 完成）
     4) [data-reveal] 进入视口后的轻度交错显现（无 JS 时元素默认可见）
     5) 弹性画廊三列的 --column-shift（滚动滞后 + 停手回弹，限幅约 22/40/58px）
     6) 探索区分类筛选：FLIP 重排 + 结果计数 + aria 状态
     7) 画廊模式 / 路线面板的 tab 键盘切换（← → Home End）
     8) 无限拖拽画廊：3×3 无缝平铺（含负向行列邻居）、惯性、自动漂移、多层视差、键盘平移/复位
     9) 照片查看器 dialog：缩放边界、前后切换、焦点回归、自原图扩展开场
    10) 音视频互斥播放

   约定：关闭动效（手动暂停或系统减弱动效）时，所有“持续/过渡动画”立即
   停止并清掉瞬时 transform；而筛选、拖动、缩放、tab 等显式交互仍然可用，
   只是去掉过渡动画。页面原生滚动、滚轮行为一律不劫持。
   ========================================================================= */
(function () {
  'use strict';

  /* 首行：给 <html> 打上 js 标记，供 CSS 区分“已增强”（[data-reveal] 的
     隐藏规则挂在 html.js 下，无 JS 时内容始终可见）。 */
  document.documentElement.classList.add('js');

  /* ---------- 1. 基础工具 ---------- */
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const mod = (v, m) => ((v % m) + m) % m;
  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
  const fmt = (v) => Math.round(v * 100) / 100 + 'px';

  const reducedMQ = window.matchMedia('(prefers-reduced-motion: reduce)');

  /* ---------- 2. 动效总开关 ----------
     allowed = 未手动暂停 且 系统未要求减弱动效。
     任何持续动画都必须以 Motion.allowed 为前提；变化时广播给各模块。 */
  const Motion = {
    reduced: reducedMQ.matches,
    off: false,               // 手动暂停（按钮）
    allowed: !reducedMQ.matches,
    listeners: new Set(),
    refresh() {
      const next = !this.reduced && !this.off;
      if (next === this.allowed) return;
      this.allowed = next;
      if (next) document.documentElement.removeAttribute('data-motion');
      else document.documentElement.setAttribute('data-motion', 'off');
      for (const fn of this.listeners) {
        try { fn(next); } catch (err) { warn('motion listener', err); }
      }
    },
    onChange(fn) { this.listeners.add(fn); },
  };
  if (!Motion.allowed) document.documentElement.setAttribute('data-motion', 'off');
  reducedMQ.addEventListener('change', (e) => {
    Motion.reduced = e.matches;
    Motion.refresh();
  });

  function warn(where, err) {
    if (window.console && console.warn) console.warn('[hw1_ai] ' + where, err);
  }

  /* 隔离初始化：单个模块出错不影响其它控件 */
  function module(name, fn) {
    try { fn(); } catch (err) { warn('模块初始化失败：' + name, err); }
  }

  /* ---------- 3. 单一 rAF 调度器 ----------
     所有“持续帧”的模块注册为一个 tick(dt)：
     返回 false 即表示本模块进入空闲，自动移出循环（离屏、停手、暂停均如此）。
     页面隐藏（切标签）与动效关闭时整个循环停摆，恢复后由各模块按需重新注册。 */
  const Tickers = (() => {
    const set = new Set();
    let raf = 0;
    let last = 0;
    const canRun = () => set.size > 0 && Motion.allowed && !document.hidden;
    function loop(now) {
      raf = 0;
      // rAF 的帧起点可能早于唤醒时刻；首帧给正时间步，避免吞掉已经发生的输入。
      const dt = last === 0 ? 1 / 60 : clamp((now - last) / 1000, 0, 0.066);
      last = now;
      for (const fn of Array.from(set)) {
        let keep = true;
        try { keep = fn(dt) !== false; } catch (err) { keep = false; warn('tick', err); }
        if (!keep) set.delete(fn);
      }
      if (canRun()) raf = requestAnimationFrame(loop);
    }
    return {
      add(fn) { set.add(fn); this.kick(); },
      remove(fn) { set.delete(fn); },
      kick() { if (!raf && canRun()) { last = 0; raf = requestAnimationFrame(loop); } },
      stop() { if (raf) cancelAnimationFrame(raf); raf = 0; },
    };
  })();

  /* ---------- 4. 顶栏 / 进度 / 回顶部 / 首屏 hero ----------
     这些是“功能性状态”（不随动效开关停摆），统一在一次 rAF 里按滚动量更新。
     只读 window.scrollY 与缓存尺寸，循环中不再测任何包围盒。 */
  const headerEl = $('[data-header]');
  const progressEl = $('[data-scroll-progress]');
  const backTopEl = $('[data-back-top]');
  const heroEl = $('[data-hero]');

  let docScrollable = 1;      // 文档可滚动高度（resize / load 时重测）
  let heroTop = 0, heroH = 0; // hero 的文档坐标与高度（重测同上）
  let heroP = -1, heroZeroed = false;

  function measureDoc() {
    docScrollable = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
  }
  function measureHero() {
    if (!heroEl) return;
    const r = heroEl.getBoundingClientRect();
    heroTop = r.top + window.scrollY;
    heroH = r.height;
  }
  /* hero 只负责写 0..1 到 --hero-progress；宽 ≤767px 或关闭动效时不写（写 0） */
  function heroGate() {
    return Motion.allowed && window.innerWidth > 767;
  }
  function updateHero(y) {
    if (!heroEl) return;
    if (!heroGate()) {
      if (!heroZeroed) { heroZeroed = true; heroP = 0; heroEl.style.setProperty('--hero-progress', '0'); }
      return;
    }
    heroZeroed = false;
    const range = Math.max(1, heroH - window.innerHeight);
    const p = clamp((y - heroTop) / range, 0, 1);
    if (Math.abs(p - heroP) > 0.0004) {
      heroP = p;
      heroEl.style.setProperty('--hero-progress', p.toFixed(4));
    }
  }
  let lastScrollY = window.scrollY;
  function updateUI() {
    const y = window.scrollY;
    const dy = y - lastScrollY;
    lastScrollY = y;
    if (headerEl) {
      headerEl.classList.toggle('is-scrolled', y > 24);
      /* 向下滚过首屏后隐去头部、回滚即现；移动菜单展开或关闭动效时保持常显 */
      let hide = false;
      if (Motion.allowed && y > 560 && dy > 2) {
        hide = !document.querySelector('[data-menu-toggle][aria-expanded="true"]');
      }
      if (hide) headerEl.classList.add('is-hidden');
      else if (!Motion.allowed || dy < -2 || y <= 560) headerEl.classList.remove('is-hidden');
    }
    if (progressEl) progressEl.style.setProperty('--scroll-progress', clamp(y / docScrollable, 0, 1).toFixed(4));
    if (backTopEl) {
      const show = y > 480;
      if (backTopEl.hidden === show) backTopEl.hidden = !show;
    }
    updateHero(y);
  }
  let uiRaf = 0;
  function scheduleUI() {
    if (uiRaf) return;
    uiRaf = requestAnimationFrame(() => { uiRaf = 0; updateUI(); });
  }
  if (headerEl || progressEl || backTopEl || heroEl) {
    window.addEventListener('scroll', scheduleUI, { passive: true });
    window.addEventListener('load', () => { measureDoc(); measureHero(); scheduleUI(); });
  }

  /* ---------- 5. 移动端菜单 ---------- */
  module('菜单', () => {
    const btn = $('[data-menu-toggle]');
    const nav = $('#site-nav');
    if (!btn) return;
    const setMenu = (open) => {
      btn.setAttribute('aria-expanded', String(open));
      if (nav) nav.classList.toggle('is-open', open);
    };
    setMenu(false);
    btn.addEventListener('click', () => setMenu(btn.getAttribute('aria-expanded') !== 'true'));
    if (nav) nav.addEventListener('click', (e) => { if (e.target.closest('a')) setMenu(false); });
    document.addEventListener('click', (e) => {
      if (btn.getAttribute('aria-expanded') !== 'true') return;
      if (e.target === btn || btn.contains(e.target) || (nav && nav.contains(e.target))) return;
      setMenu(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (btn.getAttribute('aria-expanded') !== 'true') return;
      setMenu(false);
      btn.focus();
    });
  });

  /* ---------- 6. [data-reveal] 显现 ----------
     默认可见由 CSS 保证（html 无 .js 类时）；这里逐元素加 .is-visible 触发
     CSS 过渡，并给同批元素轻度交错延迟（内联 transition-delay，随后清掉）。 */
  const Reveal = (() => {
    const els = $$('[data-reveal]');
    if (!els.length) return null;
    let io = null;

    function show(el, delay) {
      if (el.classList.contains('is-visible')) return;
      if (delay > 0 && Motion.allowed) {
        el.style.transitionDelay = delay + 'ms';
        window.setTimeout(() => { el.style.transitionDelay = ''; }, delay + 900);
      }
      el.classList.add('is-visible');
    }
    /* 先读完再写：收集视口内未见元素，再一次性标记 */
    function sweep() {
      const vh = window.innerHeight;
      const due = [];
      for (const el of els) {
        if (el.classList.contains('is-visible')) continue;
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && r.top < vh * 0.96 && r.bottom > 0) due.push(el);
      }
      for (const el of due) show(el, 0);
    }
    function init() {
      if (!('IntersectionObserver' in window)) { els.forEach((el) => show(el, 0)); return; }
      io = new IntersectionObserver((entries) => {
        let i = 0;
        for (const en of entries) {
          if (!en.isIntersecting) continue;
          io.unobserve(en.target);
          show(en.target, Math.min(4, i++) * 70);
        }
      }, { threshold: 0.06, rootMargin: '0px 0px -5% 0px' });
      els.forEach((el) => io.observe(el));
      sweep();
    }
    return {
      init, sweep, show,
      showAll() { for (const el of els) show(el, 0); },
    };
  })();

  /* ---------- 7. 探索卡片 3D 倾斜（[data-tilt]，可选） ----------
     pointermove 只记录坐标；每帧统一先测矩形后写 --tilt-x/--tilt-y，
     离开时数值阻尼回 0；触屏与关闭动效时完全不参与。 */
  const Tilt = (() => {
    const figs = $$('[data-tilt]');
    if (!figs.length) return null;
    const states = new Map();
    const pending = new Map();
    let tickerOn = false;
    for (const fig of figs) states.set(fig, { tx: 0, ty: 0, cx: 0, cy: 0 });

    function tick(dt) {
      const reads = [];
      for (const entry of pending) reads.push(entry);
      pending.clear();
      let active = false;
      /* 先测（仅悬挂过的元素） */
      const measured = reads.map(([fig, pt]) => ({ fig, pt, r: fig.getBoundingClientRect() }));
      for (const m of measured) {
        const st = states.get(m.fig);
        st.tx = clamp(((m.pt.x - m.r.left) / m.r.width) * 2 - 1, -1, 1);
        st.ty = clamp(((m.pt.y - m.r.top) / m.r.height) * 2 - 1, -1, 1);
      }
      /* 后写 */
      for (const [fig, st] of states) {
        const k = Math.min(1, dt * 12);
        st.cx = lerp(st.cx, st.tx, k);
        st.cy = lerp(st.cy, st.ty, k);
        if (Math.abs(st.cx - st.tx) < 0.002) st.cx = st.tx;
        if (Math.abs(st.cy - st.ty) < 0.002) st.cy = st.ty;
        fig.style.setProperty('--tilt-x', st.cx.toFixed(3));
        fig.style.setProperty('--tilt-y', st.cy.toFixed(3));
        if (st.cx !== 0 || st.cy !== 0 || st.tx !== 0 || st.ty !== 0) active = true;
      }
      if (!active) { tickerOn = false; return false; }
      return true;
    }
    function kick() { if (!tickerOn && Motion.allowed) { tickerOn = true; Tickers.add(tick); } }
    for (const fig of figs) {
      fig.addEventListener('pointermove', (e) => {
        if (!Motion.allowed || e.pointerType === 'touch') return;
        pending.set(fig, { x: e.clientX, y: e.clientY });
        kick();
      });
      const leave = () => {
        const st = states.get(fig);
        if (!st) return;
        st.tx = 0; st.ty = 0;
        kick();
      };
      fig.addEventListener('pointerleave', leave);
      fig.addEventListener('pointercancel', leave);
    }
    return {
      clearAll() {
        for (const [fig, st] of states) {
          st.tx = st.ty = st.cx = st.cy = 0;
          fig.style.setProperty('--tilt-x', '0');
          fig.style.setProperty('--tilt-y', '0');
        }
      },
    };
  })();

  /* ---------- 8. 弹性画廊列 ----------
     滚动时三列按 data-lag 以不同幅度“滞后”下移，停手后阻尼回弹到 0。
     幅度按 lag 分配（约 22 / 40 / 58px）：墙面板仍是裁剪边界（.wall-panel
     的 overflow: clip），位移期间列的首/尾会短暂越过面板裁剪范围，停手
     回弹归零后即复原。
     lastY 只在可见性进入与 reset() 时对齐当前 scrollY，唤醒时保留上次采样，
     单次滚轮/跳转的位移量才不会被 kick 采样掉。
     只在墙面板可见时工作，停手数帧后自行退出 rAF（不常驻）。 */
  const Columns = (() => {
    const panel = $('[data-gallery-panel="wall"]');
    const cols = $$('[data-elastic-column]');
    if (!cols.length) return null;
    const items = cols.map((el) => ({
      el,
      lag: clamp(parseFloat(el.getAttribute('data-lag')) || 0.15, 0.05, 0.4),
      cur: 0, target: 0, max: 12, written: NaN,
    }));
    let visible = false, tickerOn = false, vel = 0, lastY = window.scrollY, idle = 0;

    function measure() {
      for (const it of items) {
        /* 40 * (lag / 0.18) ≈ 22 / 40 / 58px（data-lag 0.10 / 0.18 / 0.26） */
        it.max = Math.max(22, Math.round(40 * (it.lag / 0.18)));
      }
    }
    function write(it, v) {
      const out = Math.abs(v) < 0.06 ? 0 : Math.round(v * 100) / 100;
      if (out !== it.written) {
        it.written = out;
        it.el.style.setProperty('--column-shift', out + 'px');
      }
      return out;
    }
    function reset() {
      for (const it of items) { it.cur = it.target = 0; write(it, 0); }
      vel = 0; idle = 0;
      lastY = window.scrollY;
    }
    function tick(dt) {
      const y = window.scrollY;
      const dy = y - lastY;
      lastY = y;
      vel = lerp(vel, dt > 0 ? dy / dt : 0, Math.min(1, dt * 12));
      const stopping = Math.abs(vel) < 40;
      let moving = false;
      for (const it of items) {
        const raw = clamp(vel * it.lag * 0.22, -it.max, it.max);
        it.target = lerp(it.target, raw, Math.min(1, dt * 10));
        it.cur = lerp(it.cur, it.target, Math.min(1, dt * 9));
        if (write(it, it.cur) !== 0) moving = true;
      }
      if (!moving && stopping) {
        idle++;
        if (idle > 4) { tickerOn = false; return false; }
      } else {
        idle = 0;
      }
      return true;
    }
    function kick() {
      if (!visible || !Motion.allowed || tickerOn) return;
      tickerOn = true;
      /* 不动 lastY：保留上次采样点，唤醒后的首帧才拿得到本次滚动的位移冲量 */
      vel = 0;
      idle = 0;
      Tickers.add(tick);
    }
    if ('IntersectionObserver' in window) {
      new IntersectionObserver((en) => {
        const v = en[0].isIntersecting;
        if (v === visible) return;
        visible = v;
        if (v) { lastY = window.scrollY; measure(); kick(); }
        else { Tickers.remove(tick); tickerOn = false; reset(); }
      }, { rootMargin: '80px 0px' }).observe(panel || cols[0]);
    } else {
      visible = true;
      lastY = window.scrollY;
    }
    return { measure, reset, kick };
  })();

  /* ---------- 9. 通用 tab 组件（画廊模式 / 路线面板） ----------
     aria-selected + panel hidden 的翻转；键盘 ← → ↑ ↓ Home End，
     焦点移动即激活（WAI-ARIA tabs 自动激活模式）。 */
  function setupTabs(tabs, panelAttr, keyAttr, onSwitch) {
    if (!tabs.length) return;
    const panels = new Map();
    for (const p of $$('[' + panelAttr + ']')) panels.set(p.getAttribute(panelAttr), p);
    function activate(tab, focus) {
      const key = tab.getAttribute(keyAttr);
      for (const t of tabs) {
        const on = t === tab;
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
        const p = panels.get(t.getAttribute(keyAttr));
        if (p) p.hidden = !on;
      }
      if (focus) tab.focus();
      if (onSwitch) onSwitch(key);
    }
    tabs.forEach((t, i) => {
      t.addEventListener('click', () => activate(t, false));
      t.addEventListener('keydown', (e) => {
        let n = -1;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') n = (i + 1) % tabs.length;
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') n = (i - 1 + tabs.length) % tabs.length;
        else if (e.key === 'Home') n = 0;
        else if (e.key === 'End') n = tabs.length - 1;
        if (n >= 0) { e.preventDefault(); activate(tabs[n], true); }
      });
    });
    const initial = tabs.find((t) => t.getAttribute('aria-selected') === 'true') || tabs[0];
    activate(initial, false);
  }

  /* ---------- 10. 分类筛选（FLIP 重排 + 计数） ----------
     读 First（含进行中动画的视觉位置）→ 取消上一轮动画 → 改 hidden/display
     → 读 Last → 用 WAAPI 从旧位置滑到新位置；新出现的卡片淡入上浮。
     关闭动效（含暂停）时全部即时生效，并取消未完成的 WAAPI 动画（含隐藏卡片）。 */
  const Filters = (() => {
    const btns = $$('[data-filter]');
    const cards = $$('[data-place]');
    if (!btns.length || !cards.length) return null;
    const countEl = $('[data-results-count]');
    const anims = new WeakMap();
    let current = null;

    function cancelAnims() {
      for (const c of cards) {
        const a = anims.get(c);
        if (a) { a.cancel(); anims.delete(c); }
      }
    }

    function apply(value, silent) {
      current = value;
      for (const b of btns) b.setAttribute('aria-pressed', String(b.getAttribute('data-filter') === value));
      const animate = !silent && Motion.allowed;
      /* First 取当前“视觉位置”：含上一轮动画尚未走完的 transform 偏移 */
      const first = new Map();
      if (animate) for (const c of cards) first.set(c, c.getBoundingClientRect());
      /* 读 Last 之前先取消全部旧动画（含刚被隐藏的卡片），否则旧 transform
         会同时混进 first/last 相互抵消，新动画从旧布局位而非视觉位起步 */
      cancelAnims();
      let shown = 0;
      for (const c of cards) {
        const match = value === 'all' || c.getAttribute('data-category') === value;
        if (match) shown++;
        c.hidden = !match;
        /* 兜底：某些 CSS 会给卡片设 display，覆盖 [hidden] 的 UA 规则 */
        c.style.display = match ? '' : 'none';
      }
      if (countEl) countEl.textContent = String(shown);
      if (animate) {
        const last = new Map();
        for (const c of cards) if (!c.hidden) last.set(c, c.getBoundingClientRect());
        for (const [c, lr] of last) {
          const f = first.get(c);
          if (f && f.width > 0) {
            const dx = f.left - lr.left, dy = f.top - lr.top;
            if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
            anims.set(c, c.animate(
              [{ transform: 'translate(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px)' }, { transform: 'none' }],
              { duration: 430, easing: 'cubic-bezier(.22,.61,.36,1)' }
            ));
          } else {
            if (Reveal) Reveal.show(c, 0);
            anims.set(c, c.animate(
              [{ opacity: 0, transform: 'scale(.96)' }, { opacity: 1, transform: 'none' }],
              { duration: 360, easing: 'cubic-bezier(.22,.61,.36,1)' }
            ));
          }
        }
        if (Reveal) Reveal.sweep();
      }
    }
    for (const b of btns) {
      b.addEventListener('click', () => {
        const v = b.getAttribute('data-filter') || 'all';
        if (v !== current) apply(v, false);
      });
    }
    const initial = (btns.find((b) => b.getAttribute('aria-pressed') === 'true') || btns[0]);
    apply(initial.getAttribute('data-filter') || 'all', true);
    return { cancelAnimations: cancelAnims };
  })();

  /* ---------- 11. 无限拖拽画廊 ----------
     结构：视口 [data-drift-gallery]（固定高、overflow hidden）内是 200%×200%
     的原始瓷砖 [data-drift-tile]。JS 复制 8 份（3×3 平铺，含负行/负列邻居）
     并将全部瓷砖用 translate3d 定位；图片超出瓷砖盒的部分（如 68% 处的竖图
     下缘）在模周期回卷处始终有相邻副本接续，不会整块闪失。平移量按周期取模。
     交互：鼠标双轴拖动 / 触屏横向拖动（纵向交给页面滚动）、松开惯性、
     低速自动漂移、键盘 ←→↑↓ 平移、Home 复位；滚轮完全不拦截。
     视差：瓷砖内 .drift-figure 叠加随世界坐标周期变化的微位移
     （写 --drift-x/--drift-y，幅值随图幅变化 → 多层速度感），
     离屏、暂停、文档隐藏时整体休眠，不产生任何常驻帧。 */
  const Drift = (() => {
    const root = $('[data-drift-gallery]');
    if (!root) return null;
    const tile = $('[data-drift-tile]', root);
    if (!tile) return null;

    /* --- 必要的布局前提（缺失时兜底，不改视觉设计） --- */
    const rootCS = getComputedStyle(root);
    if (rootCS.position === 'static') root.style.position = 'relative';
    if (rootCS.overflow === 'visible') root.style.overflow = 'hidden';

    /* --- 克隆：原块 + 8 份，3×3 无缝平铺（i/j ∈ {-1,0,1}，负向邻居也保留，
           越出瓷砖盒的图与视差位移回卷时才有人接）；克隆不可聚焦、不重复 id --- */
    const slots = [{ el: tile, i: 0, j: 0 }];
    const cloneMap = new Map(); // 克隆内元素 -> 原块对应元素
    (function build() {
      const focusSel = 'button, a[href], [tabindex]';
      const srcFocus = Array.from(tile.querySelectorAll(focusSel));
      const offsets = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
      for (const [i, j] of offsets) {
        const c = tile.cloneNode(true);
        for (const n of c.querySelectorAll('[id]')) n.removeAttribute('id');
        c.setAttribute('aria-hidden', 'true');
        c.classList.add('is-drift-clone');
        const targets = Array.from(c.querySelectorAll(focusSel));
        targets.forEach((n, idx) => {
          n.setAttribute('tabindex', '-1');
          cloneMap.set(n, srcFocus[idx] || null);
        });
        tile.parentNode.insertBefore(c, tile.nextSibling);
        slots.push({ el: c, i, j });
      }
    })();

    /* --- 尺寸 / 图形缓存（仅在 resize、首次可见时重测） --- */
    let vw = 0, vh = 0, P = 0, Q = 0;
    let figs = slots.map(() => []);
    let ox = 0, oy = 0;
    let measured = false, autoOn = true;
    let panelOn = true;   // 选中的 tab 是否是拖拽画廊（setVisible 维护）
    let onScreen = false; // 是否与视口相交（IntersectionObserver 维护）
    let running = false, dirty = true;
    /* 自动漂移只在“tab 选中且真正在视口里”时运行，避免画廊在折叠下方时留下
       看不见的常驻 ticker（IntersectionObserver 对未变化的 false 不会再回调）。 */
    const active = () => panelOn && onScreen;
    let pointer = null, glide = null, tween = null;
    let parMode = 'none', parActive = false;
    let suppressClick = false, suppressTimer = 0;
    const DRIFT_X = 15;   // 自动漂移速度 px/s（低幅度）
    const DRIFT_Y = 9;

    function figureList(tileEl) {
      const out = [];
      Array.from(tileEl.querySelectorAll('.drift-figure')).forEach((fig, idx) => {
        const cs = getComputedStyle(fig);
        const xp = parseFloat(cs.getPropertyValue('--x'));
        const yp = parseFloat(cs.getPropertyValue('--y'));
        const wp = parseFloat(cs.getPropertyValue('--w'));
        if (!isFinite(xp) || !isFinite(yp)) return;
        const bx = (xp / 100) * P;
        const by = (yp / 100) * Q;
        const wpx = ((isFinite(wp) ? wp : 22) / 100) * P;
        /* 幅值随图幅变化：大图摆得稍多、小图稍少，形成多层速度差 */
        const amp = clamp(wpx * 0.07, 12, 56);
        const a0x = (bx / P) * Math.PI * 2 + idx * 2.399 + 0.6;
        const a0y = (by / Q) * Math.PI * 2 + idx * 1.913 + 1.1;
        out.push({
          el: fig, amp, ampY: amp * 0.62,
          s0x: Math.sin(a0x), c0x: Math.cos(a0x),
          s0y: Math.sin(a0y), c0y: Math.cos(a0y),
          wx: 0, wy: 0, // 最近一次写入的位移，用于跳过亚像素变化
        });
      });
      return out;
    }
    function measure() {
      vw = root.clientWidth;
      vh = root.clientHeight;
      P = tile.offsetWidth || vw * 2;
      Q = tile.offsetHeight || vh * 2;
      measured = vw > 2 && vh > 2 && P > 2 && Q > 2;
      if (!measured) return false;
      figs = slots.map((s) => figureList(s.el));
      ox = mod(ox, P);
      oy = mod(oy, Q);
      detectParallax();
      return true;
    }
    function ensureMeasured() { return measured || measure(); }

    /* 视差接线探测：CSS 规则读 --drift-x 则用变量模式；figure 本身无 transform
       规则则退回内联模式；否则跳过视差（不覆盖设计，交由集成时对齐）。
       面板隐藏时布局值不可靠，推迟到首次可见测量（vw > 2）后再探测。 */
    let detected = false;
    function detectParallax() {
      if (detected || vw <= 2) return;
      const fig = tile.querySelector('.drift-figure');
      if (!fig) return;
      const before = getComputedStyle(fig).transform;
      fig.style.setProperty('--drift-x', '10px');
      const after = getComputedStyle(fig).transform;
      fig.style.removeProperty('--drift-x');
      if (after !== before) { parMode = 'var'; detected = true; }
      else if (before === 'none') { parMode = 'inline'; detected = true; }
    }

    function setFigOffset(el, dx, dy) {
      if (parMode === 'var') {
        el.style.setProperty('--drift-x', fmt(dx));
        el.style.setProperty('--drift-y', fmt(dy));
      } else {
        el.style.transform = 'translate3d(' + fmt(dx) + ',' + fmt(dy) + ',0)';
      }
    }
    function clearParallax() {
      for (const list of figs) {
        for (const f of list) {
          f.wx = 0;
          f.wy = 0;
          if (parMode === 'var') {
            f.el.style.setProperty('--drift-x', '0px');
            f.el.style.setProperty('--drift-y', '0px');
          } else {
            f.el.style.transform = '';
          }
        }
      }
      parActive = false;
    }
    /* 写：瓷砖定位 + 多层视差（差值为对“静止位”的相对位移，初始 0 不改变设计） */
    function apply() {
      if (!ensureMeasured()) return;
      const par = parMode !== 'none' && Motion.allowed;
      if (parActive && !par) clearParallax();
      parActive = par;
      for (let si = 0; si < slots.length; si++) {
        const s = slots[si];
        const sx = s.i * P - ox;
        const sy = s.j * Q - oy;
        s.el.style.transform = 'translate3d(' + fmt(sx) + ',' + fmt(sy) + ',0)';
        if (!par) continue;
        const phx = (Math.PI * 2 * mod(sx, P)) / P;
        const phy = (Math.PI * 2 * mod(sy, Q)) / Q;
        const cosX = Math.cos(phx), sinX = Math.sin(phx);
        const cosY = Math.cos(phy), sinY = Math.sin(phy);
        for (const f of figs[si]) {
          const dx = f.amp * (f.s0x * cosX + f.c0x * sinX - f.s0x);
          const dy = f.ampY * (f.s0y * cosY + f.c0y * sinY - f.s0y);
          /* 与上次写入相差不足 0.04px 就不碰样式（空闲漂移时的抖动更小） */
          if (Math.abs(dx - f.wx) > 0.04 || Math.abs(dy - f.wy) > 0.04) {
            f.wx = dx;
            f.wy = dy;
            setFigOffset(f.el, dx, dy);
          }
        }
      }
    }

    /* --- 帧循环：惯性 > 键盘补间 > 自动漂移，其余时间自行退出 --- */
    function tick(dt) {
      let moved = false;
      if (glide) {
        ox = mod(ox + glide.x * dt, P);
        oy = mod(oy + glide.y * dt, Q);
        const k = Math.exp(-3.4 * dt);
        glide.x *= k;
        glide.y *= k;
        if (Math.hypot(glide.x, glide.y) < 16) glide = null;
        moved = true;
      } else if (tween) {
        tween.t += dt;
        const e = easeOutCubic(clamp(tween.t / tween.dur, 0, 1));
        ox = mod(lerp(tween.fx, tween.tx, e), P);
        oy = mod(lerp(tween.fy, tween.ty, e), Q);
        if (tween.t >= tween.dur) {
          ox = mod(tween.tx, P);
          oy = mod(tween.ty, Q);
          tween = null;
        }
        moved = true;
      } else if (autoOn && !pointer) {
        ox = mod(ox + DRIFT_X * dt, P);
        oy = mod(oy + DRIFT_Y * dt, Q);
        moved = true;
      }
      if (dirty || moved) { apply(); dirty = false; }
      const keep = active() && Motion.allowed && (!!pointer || !!tween || !!glide || autoOn);
      if (!keep) running = false;
      return keep;
    }
    function ensure() {
      if (running || !active() || !Motion.allowed) return;
      if (!ensureMeasured()) return;
      running = true;
      dirty = true;
      Tickers.add(tick);
    }
    function sleep() { Tickers.remove(tick); running = false; }
    /* panelOn / onScreen 任一变化后统一收敛：两者同时成立才转，否则立即休眠 */
    function sync() {
      if (active()) {
        if (ensureMeasured()) { dirty = true; apply(); }
        ensure();
      } else {
        sleep();
      }
    }

    function pan(dx, dy) {
      if (!ensureMeasured()) return;
      ox = mod(ox + dx, P);
      oy = mod(oy + dy, Q);
      dirty = true;
      if (Motion.allowed) ensure();
      else apply(); // 暂停动效时拖动仍然可用，只是即时生效、无视差
    }
    function recenter() {
      glide = null;
      if (!ensureMeasured()) return;
      if (!Motion.allowed) {
        tween = null;
        ox = 0; oy = 0;
        dirty = true;
        apply();
        return;
      }
      tween = {
        fx: ox, fy: oy,
        tx: ox <= P / 2 ? 0 : P,
        ty: oy <= Q / 2 ? 0 : Q,
        t: 0, dur: 0.55,
      };
      ensure();
    }

    /* --- 拖动（Pointer Events；触屏纵向留给页面滚动） --- */
    function suppressClicks() {
      suppressClick = true;
      window.clearTimeout(suppressTimer);
      suppressTimer = window.setTimeout(() => { suppressClick = false; }, 420);
    }
    /* 按下先不捕获指针、不标记拖动：捕获会改写 click 目标，普通点击/轻触
       必须原样落到照片按钮上（否则查看器打不开）。累计位移越过阈值后才真正
       开始拖动并捕获；阈值内累计的位移在越界那一刻一次性补给。 */
    root.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (pointer) return;
      glide = null;
      tween = null;
      pointer = {
        id: e.pointerId,
        x: e.clientX, y: e.clientY, t: e.timeStamp,
        thresh: e.pointerType === 'mouse' ? 5 : 9,
        accX: 0, accY: 0,
        vx: 0, vy: 0,
        moved: false,
      };
    });
    root.addEventListener('pointermove', (e) => {
      if (!pointer || e.pointerId !== pointer.id) return;
      const dt = Math.max(8, e.timeStamp - pointer.t) / 1000;
      let dx = e.clientX - pointer.x;
      let dy = e.clientY - pointer.y;
      pointer.x = e.clientX;
      pointer.y = e.clientY;
      pointer.t = e.timeStamp;
      if (e.pointerType !== 'mouse') dy = 0; // 触屏纵向留给页面滚动
      if (dx === 0 && dy === 0) return;
      if (!pointer.moved) {
        pointer.accX += dx;
        pointer.accY += dy;
        if (Math.abs(pointer.accX) + Math.abs(pointer.accY) < pointer.thresh) return;
        pointer.moved = true;
        try { root.setPointerCapture(pointer.id); } catch (err) { /* 忽略 */ }
        root.classList.add('is-dragging');
        pan(-pointer.accX, -pointer.accY);
        pointer.accX = 0;
        pointer.accY = 0;
        return;
      }
      const k = 0.35;
      pointer.vx = pointer.vx * (1 - k) + (dx / dt) * k;
      pointer.vy = pointer.vy * (1 - k) + (dy / dt) * k;
      pan(-dx, -dy);
    });
    function endPointer(e, cancelled) {
      if (!pointer || e.pointerId !== pointer.id) return;
      const p = pointer;
      pointer = null;
      root.classList.remove('is-dragging');
      if (p.moved) suppressClicks();
      if (p.moved && !cancelled && Motion.allowed && Math.hypot(p.vx, p.vy) > 70) {
        glide = { x: -p.vx, y: -p.vy };
      }
      ensure();
    }
    /* 收尾监听挂在 window：起始捕获被推迟后，抬起可能发生在视口之外，
       必须有一个兜底把候选拖动状态清掉（否则 pointer 永远非空、后续拖动失效） */
    window.addEventListener('pointerup', (e) => endPointer(e, false));
    window.addEventListener('pointercancel', (e) => endPointer(e, true));
    /* 拖动结束后的“幽灵点击”在捕获阶段拦下，不触发瓷砖上的按钮 */
    root.addEventListener('click', (e) => {
      if (!suppressClick) return;
      suppressClick = false;
      e.preventDefault();
      e.stopPropagation();
    }, true);
    root.addEventListener('dragstart', (e) => e.preventDefault());

    /* --- 键盘：方向键平移 / Home 复位（Shift 加速） --- */
    root.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 260 : 96;
      let dx = 0, dy = 0, handled = true;
      switch (e.key) {
        case 'ArrowLeft': dx = -step; break;
        case 'ArrowRight': dx = step; break;
        case 'ArrowUp': dy = -step; break;
        case 'ArrowDown': dy = step; break;
        case 'Home': e.preventDefault(); recenter(); return;
        default: handled = false;
      }
      if (!handled) return;
      e.preventDefault();
      glide = null;
      if (!Motion.allowed || !ensureMeasured()) { pan(dx, dy); return; }
      tween = { fx: ox, fy: oy, tx: ox + dx, ty: oy + dy, t: 0, dur: 0.24 };
      ensure();
    });

    /* --- 自动漂移开关 / 复位按钮 ---
       aria-pressed 与动效开关同语义：true = “漂移已暂停”。页面默认开启
       低速自动漂移（初始归一到 pressed="false"，按钮文案随 CSS 显示
       「暂停漂移」），点击在 漂移 ⇄ 暂停 之间切换。 */
    const toggleBtn = $('[data-drift-toggle]');
    if (toggleBtn) {
      autoOn = true;
      toggleBtn.setAttribute('aria-pressed', 'false');
      toggleBtn.addEventListener('click', () => {
        autoOn = !autoOn;
        toggleBtn.setAttribute('aria-pressed', String(!autoOn));
        if (!autoOn) glide = null;
        if (autoOn) ensure();
      });
    }
    const resetBtn = $('[data-drift-reset]');
    if (resetBtn) resetBtn.addEventListener('click', recenter);

    /* --- 可见性：视口相交 + tab 选中两者同时成立才运行 --- */
    if ('IntersectionObserver' in window) {
      new IntersectionObserver((en) => {
        const v = en[0].isIntersecting;
        if (v === onScreen) return;
        onScreen = v;
        sync();
      }, { threshold: 0.03 }).observe(root);
    } else {
      onScreen = true;
      sync();
    }

    /* --- 可见操作提示（PageLayout 未提供时兜底注入，仅 JS 增强可见） --- */
    if (!$('.drift-hint') && !root.parentNode.querySelector('[data-drift-help]')) {
      const hint = document.createElement('p');
      hint.className = 'drift-hint';
      hint.textContent = '按住拖动画面或按方向键平移，Home 复位；滚轮照常滚动页面。';
      root.parentNode.insertBefore(hint, root.nextSibling);
    }

    /* --- 对外接口 --- */
    function setVisible(flag) {
      if (flag === panelOn) return;
      panelOn = flag;
      sync();
    }
    return {
      invalidate() { measure(); if (active()) { dirty = true; if (ensureMeasured()) apply(); ensure(); } },
      reset() { // 动效关闭：停一切运动并清瞬时 transform
        glide = null;
        tween = null;
        ox = 0; oy = 0;
        dirty = true;
        sleep();
        if (measured) { if (parActive) clearParallax(); apply(); }
      },
      wake() { if (active()) ensure(); },
      setVisible,
      /* 查看器关窗时的兜底焦点：画廊视口本身可聚焦（HTML 已给 tabindex="0"） */
      focusViewport() {
        if (!root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1');
        const r = root.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return;
        try { root.focus({ preventScroll: true }); } catch (err) { warn('聚焦画廊视口', err); }
      },
      origin(el) { return cloneMap.get(el) || el; },
    };
  })();

  /* ---------- 12. 照片查看器 dialog ----------
     收集所有 [data-lightbox] 触发按钮（克隆画廊里的副本除外），按 src 去重
     成一份有序列表。支持：关闭/上一张/下一张/放大/缩小/复位/计数/标题说明，
     Escape（原生）+ ← → 切换 + 数字键缩放；点击遮罩（.viewer 等背景容器）关闭。
     缩放有明确上下界并同步按钮 disabled。开场动画用 WAAPI 自原图矩形放大，
     任何缩放/切图前先取消动画。关闭后焦点：优先回视口内可见的原按钮，否则回到
     画廊视口；一律 preventScroll，不把不可见的平铺副本滚进视野。 */
  const Lightbox = (() => {
    const dlg = document.getElementById('photo-viewer');
    if (!dlg) return null;
    const imgEl = document.getElementById('lightbox-image');
    if (!imgEl) return null;
    const capEl = document.getElementById('lightbox-caption');
    const titleEl = $('[data-lightbox-title]', dlg);
    const counterEl = $('[data-lightbox-counter]', dlg);
    const btnClose = $('[data-lightbox-close]', dlg);
    const btnPrev = $('[data-lightbox-prev]', dlg);
    const btnNext = $('[data-lightbox-next]', dlg);
    const btnIn = $('[data-lightbox-zoom-in]', dlg);
    const btnOut = $('[data-lightbox-zoom-out]', dlg);
    const btnReset = $('[data-lightbox-reset]', dlg);

    const ZMIN = 1, ZMAX = 4, ZSTEP = 1.4;
    const items = [];
    const seen = new Set();
    let opener = null, index = 0, zoom = 1, anim = null;

    function collect() {
      items.length = 0;
      seen.clear();
      for (const btn of $$('[data-lightbox]')) {
        if (btn.closest('[aria-hidden="true"]')) continue; // 平铺克隆中的副本
        const img = btn.querySelector('img');
        const src = img && img.getAttribute('src');
        if (!src || seen.has(src)) continue;
        seen.add(src);
        items.push({ btn, img, src, preloaded: false });
      }
    }
    function stopAnim() {
      if (anim) {
        try { anim.cancel(); } catch (err) { /* 忽略 */ }
        anim = null;
      }
    }
    function applyZoom() {
      /* 同时写 CSS 变量与内联 transform：两种实现（var 规则 / 直接 transform）
         都能工作，且都会经过 CSS 的 transform transition */
      imgEl.style.setProperty('--lb-zoom', String(zoom));
      imgEl.style.transform = zoom === 1 ? '' : 'scale(' + zoom.toFixed(3) + ')';
      if (btnOut) btnOut.disabled = zoom <= ZMIN + 1e-3;
      if (btnReset) btnReset.disabled = zoom <= ZMIN + 1e-3;
      if (btnIn) btnIn.disabled = zoom >= ZMAX - 1e-3;
    }
    function render() {
      const it = items[index];
      if (!it) return;
      stopAnim();
      zoom = 1;
      applyZoom();
      imgEl.src = it.src;
      const title = (it.btn.getAttribute('data-title') || '').trim();
      const caption = (it.btn.getAttribute('data-caption') || '').trim();
      const alt = ((it.img && it.img.getAttribute('alt')) || '').trim();
      imgEl.alt = title || alt || '照片';
      if (titleEl) titleEl.textContent = title;
      if (capEl) {
        capEl.textContent = (title && !titleEl)
          ? (caption ? title + ' · ' + caption : title)
          : caption;
      }
      if (counterEl) counterEl.textContent = (index + 1) + ' / ' + items.length;
      if (btnPrev) btnPrev.disabled = items.length < 2;
      if (btnNext) btnNext.disabled = items.length < 2;
      preload();
    }
    function preload() {
      const n = items.length;
      if (n < 2) return;
      for (const d of [1, -1]) {
        const it = items[(index + d + n) % n];
        if (it && !it.preloaded) {
          it.preloaded = true;
          const im = new Image();
          im.src = it.src;
        }
      }
    }
    function playOpen(btn) {
      stopAnim();
      if (!Motion.allowed) return;
      const src = btn.querySelector('img') || btn;
      const from = src.getBoundingClientRect();
      const to = imgEl.getBoundingClientRect();
      if (!to.width || !from.width) return;
      const dx = from.left + from.width / 2 - (to.left + to.width / 2);
      const dy = from.top + from.height / 2 - (to.top + to.height / 2);
      const sc = clamp(from.width / to.width, 0.15, 1);
      anim = imgEl.animate([
        {
          transform: 'translate(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px) scale(' + sc.toFixed(3) + ')',
          opacity: 0.35,
        },
        { transform: 'none', opacity: 1 },
      ], { duration: 460, easing: 'cubic-bezier(.2,.7,.2,1)' });
      anim.onfinish = stopAnim;
    }
    function open(btn) {
      if (!items.length) collect();
      if (!items.length) return;
      let i = items.findIndex((it) => it.btn === btn);
      if (i < 0) {
        const im = btn.querySelector('img');
        const src = im && im.getAttribute('src');
        i = items.findIndex((it) => it.src === src);
      }
      if (i < 0) return; // 找不到对应条目就不假装打开
      opener = btn;
      index = i;
      render();
      if (!dlg.open) {
        try { dlg.showModal(); } catch (err) { return; }
      }
      if (btnClose) btnClose.focus();
      playOpen(btn);
    }
    function step(d) {
      if (items.length < 2) return;
      index = (index + d + items.length) % items.length;
      render();
      if (Motion.allowed) {
        stopAnim();
        anim = imgEl.animate([{ opacity: 0.25 }, { opacity: 1 }], { duration: 220, easing: 'ease-out' });
        anim.onfinish = stopAnim;
      }
    }
    function setZoom(z) {
      const next = clamp(z, ZMIN, ZMAX);
      if (Math.abs(next - zoom) < 1e-4) return;
      stopAnim(); // 先停开场/切图动画，再应用缩放
      zoom = next;
      applyZoom();
    }
    const zoomBy = (f) => setZoom(zoom * f);

    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-lightbox]');
      if (btn) open(btn);
    });
    if (btnClose) btnClose.addEventListener('click', () => dlg.close());
    if (btnPrev) btnPrev.addEventListener('click', () => step(-1));
    if (btnNext) btnNext.addEventListener('click', () => step(1));
    if (btnIn) btnIn.addEventListener('click', () => zoomBy(ZSTEP));
    if (btnOut) btnOut.addEventListener('click', () => zoomBy(1 / ZSTEP));
    if (btnReset) btnReset.addEventListener('click', () => setZoom(1));
    dlg.addEventListener('keydown', (e) => {
      switch (e.key) {
        case 'ArrowLeft': e.preventDefault(); step(-1); break;
        case 'ArrowRight': e.preventDefault(); step(1); break;
        case '+': case '=': e.preventDefault(); zoomBy(ZSTEP); break;
        case '-': case '_': e.preventDefault(); zoomBy(1 / ZSTEP); break;
        case '0': e.preventDefault(); setZoom(1); break;
        default: break;
      }
    });
    /* 点暗处关闭：dialog 铺满视口、.viewer 又是全高容器，普通一击命中的是
       .viewer / .viewer-body / .viewer-stage 这些背景容器本身（不会是 dialog）。
       只在这些容器本身上关闭；落在大图与任何控件上都不关。 */
    const backdropSel = '.viewer, .viewer-body, .viewer-stage';
    dlg.addEventListener('click', (e) => {
      const t = e.target;
      if (t === dlg || (t instanceof Element && t.matches(backdropSel))) dlg.close();
    });
    dlg.addEventListener('close', () => {
      stopAnim();
      let target = opener;
      opener = null;
      if (target && Drift) target = Drift.origin(target) || target;
      /* 平铺克隆里的原按钮可能已被拖出视口、或落进 aria-hidden 的克隆：
         只回到视口内可见、可聚焦的原按钮；否则聚焦画廊视口。统一 preventScroll，
         绝不把不可见元素滚进视野。 */
      if (target && typeof target.focus === 'function' && !target.closest('[aria-hidden="true"]')) {
        const r = target.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth) {
          try { target.focus({ preventScroll: true }); return; } catch (err) { /* 落到视口兜底 */ }
        }
      }
      if (Drift) Drift.focusViewport();
    });
    applyZoom(); // 初始化边界按钮 disabled 状态
    return { stopAnimations: stopAnim };
  })();

  /* ---------- 13. 音视频互斥 / 动效开关 ---------- */
  module('音视频互斥', () => {
    const vids = $$('video');
    const auds = $$('audio');
    if (!vids.length || !auds.length) return;
    for (const v of vids) {
      v.addEventListener('play', () => { for (const a of auds) if (!a.paused) a.pause(); });
    }
    for (const a of auds) {
      a.addEventListener('play', () => { for (const v of vids) if (!v.paused) v.pause(); });
    }
  });

  module('动效开关', () => {
    const btn = $('[data-motion-toggle]');
    if (!btn) return;
    const sync = () => btn.setAttribute('aria-pressed', String(Motion.off));
    btn.addEventListener('click', () => {
      Motion.off = !Motion.off;
      sync();
      Motion.refresh();
    });
    sync();
  });

  /* ---------- 14. tab 初始化（依赖 Drift 已就绪） ---------- */
  module('画廊模式 tab', () => {
    setupTabs($$('[data-gallery-mode]'), 'data-gallery-panel', 'data-gallery-mode', (mode) => {
      if (Drift) Drift.setVisible(mode === 'drift');
      if (Reveal) Reveal.sweep();
    });
  });
  module('路线 tab', () => {
    setupTabs($$('[data-route-select]'), 'data-route-panel', 'data-route-select', () => {
      if (Reveal) Reveal.sweep();
    });
  });

  /* ---------- 15. 动效开关联动：暂停即停帧、清瞬时 transform；恢复即重挂 ---------- */
  Motion.onChange((allowed) => {
    if (allowed) {
      scheduleUI();
      /* 恢复时先让中央调度器转起来：暂停只停了 rAF，ticker 仍留在注册表里
         （Columns/Tilt 的 tickerOn 要到 tick 自行退出时才归位），不 kick
         它们会一直睡在表里，后续滚动/悬停也无法重新启动。 */
      Tickers.kick();
      if (Columns) Columns.kick();
      if (Drift) Drift.wake();
    } else {
      Tickers.stop();
      if (Reveal) Reveal.showAll();
      if (Columns) Columns.reset();
      if (Tilt) Tilt.clearAll();
      if (Drift) Drift.reset();
      if (Filters) Filters.cancelAnimations();
      if (Lightbox) Lightbox.stopAnimations();
      scheduleUI(); // hero 在门关闭时会归零
    }
  });

  /* ---------- 16. 滚动 / 尺寸 / 页面可见性 ---------- */
  window.addEventListener('scroll', () => { if (Columns) Columns.kick(); }, { passive: true });
  let resizeRaf = 0;
  function onResize() {
    if (resizeRaf) return;
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = 0;
      measureDoc();
      measureHero();
      scheduleUI();
      if (Columns) Columns.measure();
      if (Drift) Drift.invalidate();
    });
  }
  window.addEventListener('resize', onResize);
  window.addEventListener('load', () => {
    measureDoc(); measureHero(); scheduleUI();
    if (Columns) Columns.measure();
    if (Drift) Drift.invalidate();
  });
  if ('ResizeObserver' in window) {
    let roRaf = 0;
    new ResizeObserver(() => {
      if (roRaf) return;
      roRaf = requestAnimationFrame(() => { roRaf = 0; measureDoc(); measureHero(); });
    }).observe(document.body);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    Tickers.kick();
    scheduleUI();
    if (Drift) Drift.wake();
  });

  /* ---------- 17. 初始化显现与首帧状态 ---------- */
  if (Reveal) module('显现', () => Reveal.init());
  measureDoc();
  measureHero();
  updateUI();
})();

