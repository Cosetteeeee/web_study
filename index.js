/* ==========================================================================
   26-27（1）Web前端开发课程作业索引 — index.js
   全部为渐进增强：脚本不可用时，页面内容与原生链接完整可用。
   模块：
     1. 动效偏好管理（prefers-reduced-motion + 手动暂停按钮）
     2. H1 逐字入场 + 指针邻近抬升
     3. 课程作业行：指针跟随浮动照片预览（精细指针）
     4. 照片墙：自动漂移 + 拖拽 + 键盘滚动 + 离屏暂停
     5. 磁性按钮
     6. MOOC 章节：平滑折叠动画 + 搜索过滤 + 全部展开/收起
     7. CSS 层叠实时演示（真实 style 元素 disabled 切换 + 行内属性切换）
     8. 滚动进入视口动效
   ========================================================================== */
(function () {
  'use strict';

  document.documentElement.classList.add('js');

  var FINE_POINTER = window.matchMedia('(pointer: fine)');
  var REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)');
  var STORE_KEY = 'index-motion-paused';

  /* ----------------------------------------------------------------------
     1. 动效偏好管理
     ---------------------------------------------------------------------- */
  var Motion = {
    manualPaused: false,
    paused: false, /* 有效状态 = 系统减少 || 手动暂停 */
    listeners: [],
    button: null,
    init: function () {
      var stored = null;
      try { stored = window.localStorage.getItem(STORE_KEY); } catch (e) { /* file:// 隐私模式等 */ }
      this.manualPaused = stored === '1';

      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'motion-toggle';
      btn.innerHTML = '<span class="dot" aria-hidden="true"></span><span class="label"></span>';
      document.body.appendChild(btn);
      this.button = btn;
      var label = btn.querySelector('.label');

      this.syncControl = function () {
        var systemForced = REDUCED.matches;
        var eff = Motion.paused;
        btn.setAttribute('aria-pressed', String(eff));
        btn.disabled = systemForced;
        if (systemForced) {
          label.textContent = '动效已随系统减少';
          btn.title = '操作系统「减少动态效果」已开启，页面动效随之停止；关闭该系统设置后即可用此按钮手动控制。';
        } else {
          label.textContent = eff ? '动效已暂停' : '暂停动效';
          btn.title = eff ? '恢复页面动效' : '暂停页面动效（照片墙、标题与预览的指针动效）';
        }
      };

      btn.addEventListener('click', function () {
        if (REDUCED.matches) return; /* 系统强制时不允许覆盖 */
        Motion.setPaused(!Motion.manualPaused, true);
      });

      this.refresh();
      this.syncControl();

      var onMedia = function () {
        Motion.refresh();
        Motion.syncControl();
      };
      if (REDUCED.addEventListener) REDUCED.addEventListener('change', onMedia);
    },
    setPaused: function (value, persist) {
      this.manualPaused = value;
      if (persist) {
        try { window.localStorage.setItem(STORE_KEY, value ? '1' : '0'); } catch (e) { /* 忽略 */ }
      }
      this.refresh();
      this.syncControl();
    },
    refresh: function () {
      var eff = REDUCED.matches || this.manualPaused;
      var changed = eff !== this.paused;
      this.paused = eff;
      this.apply();
      if (changed) {
        for (var i = 0; i < this.listeners.length; i++) this.listeners[i](eff);
      }
    },
    apply: function () {
      document.documentElement.classList.toggle('motion-paused', this.paused);
    },
    onChange: function (fn) { this.listeners.push(fn); }
  };
  Motion.init();

  /* ----------------------------------------------------------------------
     2. H1 逐字入场 + 指针邻近抬升
     ---------------------------------------------------------------------- */
  (function heroTitle() {
    var title = document.querySelector('.hero-title');
    if (!title) return;
    var text = title.textContent;
    title.textContent = '';
    title.setAttribute('aria-label', text);
    var chars = [];
    var frag = document.createDocumentFragment();
    for (var i = 0; i < text.length; i++) {
      var span = document.createElement('span');
      span.className = 'char';
      span.setAttribute('aria-hidden', 'true');
      span.style.setProperty('--i', String(i));
      span.textContent = text[i] === ' ' ? ' ' : text[i];
      frag.appendChild(span);
      chars.push(span);
    }
    title.appendChild(frag);

    /* 入场动画结束（或动效被暂停）后摘掉动画，transform 交还给指针交互 */
    function finishIntro() {
      for (var i = 0; i < chars.length; i++) chars[i].classList.add('intro-done');
    }
    chars.forEach(function (span) {
      span.addEventListener('animationend', function () {
        span.classList.add('intro-done');
      }, { once: true });
    });
    if (Motion.paused) finishIntro();
    Motion.onChange(function (paused) { if (paused) finishIntro(); });

    if (!FINE_POINTER.matches) return;
    var hero = title.closest('.hero') || title;
    var rafId = 0;
    var px = -9999, py = -9999;

    function update() {
      rafId = 0;
      if (Motion.paused) return;
      for (var i = 0; i < chars.length; i++) {
        var r = chars[i].getBoundingClientRect();
        if (r.width === 0) continue;
        var cx = r.left + r.width / 2;
        var cy = r.top + r.height / 2;
        var dist = Math.hypot(px - cx, py - cy);
        var range = Math.max(140, r.height * 2.2);
        var force = Math.max(0, 1 - dist / range);
        chars[i].style.setProperty('--lift', (-force * r.height * 0.22).toFixed(1) + 'px');
        chars[i].style.setProperty('--swell', (1 + force * 0.06).toFixed(3));
        chars[i].classList.toggle('is-near', force > 0.35);
      }
    }
    hero.addEventListener('pointermove', function (e) {
      px = e.clientX; py = e.clientY;
      if (!rafId) rafId = requestAnimationFrame(update);
    });
    hero.addEventListener('pointerleave', function () {
      px = py = -9999;
      if (!rafId) rafId = requestAnimationFrame(update);
    });
    Motion.onChange(function (paused) {
      if (paused) {
        finishIntro();
        for (var i = 0; i < chars.length; i++) {
          chars[i].style.setProperty('--lift', '0px');
          chars[i].style.setProperty('--swell', '1');
          chars[i].classList.remove('is-near');
        }
      }
    });
  })();

  /* ----------------------------------------------------------------------
     3. 课程作业行：指针跟随浮动照片预览
     ---------------------------------------------------------------------- */
  (function floatingPreview() {
    var section = document.getElementById('coursework');
    if (!section || !FINE_POINTER.matches) return;
    if (!window.matchMedia('(min-width: 64rem)').matches) return;
    var rows = section.querySelectorAll('.work[data-preview]');
    if (!rows.length) return;

    var box = document.createElement('div');
    box.className = 'preview-float';
    box.setAttribute('aria-hidden', 'true');
    box.setAttribute('data-caption', '');
    var imgs = {};
    rows.forEach(function (row) {
      var src = row.getAttribute('data-preview');
      var img = document.createElement('img');
      img.src = src;
      img.alt = '';
      img.decoding = 'async';
      box.appendChild(img);
      imgs[src] = img;
    });
    document.body.appendChild(box);

    var tx = 0, ty = 0, cx = 0, cy = 0, lastX = 0, rafId = 0, active = false;

    function frame() {
      rafId = 0;
      if (!active || Motion.paused) return;
      cx += (tx - cx) * 0.16;
      cy += (ty - cy) * 0.16;
      var tilt = Math.max(-6, Math.min(6, (tx - lastX) * 0.35));
      lastX += (tx - lastX) * 0.2;
      box.style.left = cx + 'px';
      box.style.top = cy + 'px';
      box.style.setProperty('--tilt', tilt.toFixed(2) + 'deg');
      rafId = requestAnimationFrame(frame);
    }

    section.addEventListener('pointermove', function (e) {
      tx = e.clientX; ty = e.clientY + 24;
      if (!active) { cx = tx; cy = ty; lastX = tx; }
    });

    rows.forEach(function (row) {
      row.addEventListener('pointerenter', function (e) {
        if (Motion.paused) return;
        var src = row.getAttribute('data-preview');
        for (var key in imgs) imgs[key].classList.toggle('is-current', key === src);
        box.setAttribute('data-caption', row.getAttribute('data-preview-caption') || '');
        active = true;
        tx = e.clientX; ty = e.clientY + 24;
        cx = tx; cy = ty; lastX = tx;
        box.classList.add('is-on');
        if (!rafId) rafId = requestAnimationFrame(frame);
      });
      row.addEventListener('pointerleave', function () {
        active = false;
        box.classList.remove('is-on');
      });
      /* 键盘聚焦时也给出预览位置提示（固定在行附近） */
      row.addEventListener('focusin', function () {
        if (Motion.paused) return;
        var src = row.getAttribute('data-preview');
        for (var key in imgs) imgs[key].classList.toggle('is-current', key === src);
        box.setAttribute('data-caption', row.getAttribute('data-preview-caption') || '');
        var r = row.getBoundingClientRect();
        tx = Math.max(180, Math.min(window.innerWidth - 180, r.right - 160));
        ty = Math.max(150, Math.min(window.innerHeight - 120, r.top + r.height * 0.5));
        cx = tx; cy = ty;
        active = true;
        box.classList.add('is-on');
        if (!rafId) rafId = requestAnimationFrame(frame);
      });
      row.addEventListener('focusout', function () {
        active = false;
        box.classList.remove('is-on');
      });
    });

    Motion.onChange(function (paused) {
      if (paused) { active = false; box.classList.remove('is-on'); }
    });
  })();

  /* ----------------------------------------------------------------------
     4. 照片墙：自动漂移 + 拖拽 + 键盘 + 离屏暂停
     ---------------------------------------------------------------------- */
  (function photoWall() {
    var wall = document.querySelector('.wall');
    var track = wall && wall.querySelector('.wall-track');
    if (!wall || !track) return;

    /* 复制一份实现无缝循环 */
    var originals = Array.prototype.slice.call(track.children);
    originals.forEach(function (item) {
      var clone = item.cloneNode(true);
      clone.setAttribute('aria-hidden', 'true');
      track.appendChild(clone);
    });

    /* 关闭图片原生拖拽（dragstart 会触发 pointercancel，吃掉自定义拖拽） */
    track.querySelectorAll('img').forEach(function (img) { img.draggable = false; });
    wall.addEventListener('dragstart', function (e) { e.preventDefault(); });

    track.style.position = 'relative';

    var offset = 0;
    var halfWidth = 0;
    var dragging = false;
    var dragStartX = 0;
    var dragStartOffset = 0;
    var dragMoved = false;
    var hoverSlow = false;
    var offscreen = false;
    var rafId = 0;
    var lastTime = 0;
    var SPEED = 36; /* px/s */

    function measure() {
      var firstClone = track.children[originals.length];
      halfWidth = firstClone ? firstClone.offsetLeft - track.children[0].offsetLeft : 0;
    }
    measure();
    window.addEventListener('resize', measure);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(measure);
    window.addEventListener('load', measure);

    function apply() {
      track.style.transform = 'translate3d(' + (-offset).toFixed(2) + 'px, 0, 0)';
    }

    function frame(now) {
      rafId = 0;
      if (Motion.paused || offscreen) { lastTime = 0; return; }
      if (!lastTime) lastTime = now;
      var dt = Math.min(64, now - lastTime) / 1000;
      lastTime = now;
      if (!dragging) {
        var speed = hoverSlow ? SPEED * 0.15 : SPEED;
        offset += speed * dt;
        if (halfWidth > 0 && offset >= halfWidth) offset -= halfWidth;
        if (offset < 0) offset += halfWidth;
        apply();
      }
      rafId = requestAnimationFrame(frame);
    }

    function ensureLoop() {
      if (!rafId && !Motion.paused && !offscreen) rafId = requestAnimationFrame(frame);
    }
    ensureLoop();

    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        offscreen = !entries[0].isIntersecting;
        if (!offscreen) { lastTime = 0; ensureLoop(); }
      }, { threshold: 0.02 }).observe(wall);
    }

    wall.addEventListener('pointerenter', function () { hoverSlow = true; });
    wall.addEventListener('pointerleave', function () { hoverSlow = false; });

    /* 拖拽（阈值 6px，区分点击与拖拽；不吞掉普通点击） */
    wall.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      dragging = true;
      dragMoved = false;
      dragStartX = e.clientX;
      dragStartOffset = offset;
      wall.classList.add('is-dragging');
      wall.setPointerCapture(e.pointerId);
    });
    wall.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var dx = e.clientX - dragStartX;
      if (!dragMoved && Math.abs(dx) > 6) dragMoved = true;
      if (dragMoved) {
        offset = dragStartOffset - dx;
        if (halfWidth > 0) {
          offset = ((offset % halfWidth) + halfWidth) % halfWidth;
        }
        apply();
      }
    });
    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      wall.classList.remove('is-dragging');
      try { wall.releasePointerCapture(e.pointerId); } catch (err) { /* 已释放 */ }
      lastTime = 0;
      ensureLoop();
    }
    wall.addEventListener('pointerup', endDrag);
    wall.addEventListener('pointercancel', endDrag);
    wall.addEventListener('click', function (e) {
      if (dragMoved) {
        e.preventDefault();
        e.stopPropagation();
        dragMoved = false;
      }
    }, true);

    /* 键盘：左右方向键 / PageUp / PageDown 平移照片带 */
    wall.setAttribute('tabindex', '0');
    wall.addEventListener('keydown', function (e) {
      var step = 0;
      if (e.key === 'ArrowRight') step = 120;
      else if (e.key === 'ArrowLeft') step = -120;
      else if (e.key === 'PageDown') step = wall.clientWidth * 0.8;
      else if (e.key === 'PageUp') step = -wall.clientWidth * 0.8;
      if (!step) return;
      e.preventDefault();
      offset += step;
      if (halfWidth > 0) offset = ((offset % halfWidth) + halfWidth) % halfWidth;
      apply();
    });

    Motion.onChange(function (paused) {
      if (!paused) { lastTime = 0; ensureLoop(); }
    });
  })();

  /* ----------------------------------------------------------------------
     5. 磁性按钮（精细指针）
     ---------------------------------------------------------------------- */
  (function magnetic() {
    if (!FINE_POINTER.matches) return;
    var els = document.querySelectorAll('.magnetic');
    els.forEach(function (el) {
      var rafId = 0;
      var mx = 0, my = 0;
      var base = null; /* pointerenter 时未变形的边界，用于把位移限制在视口内 */
      function apply() {
        rafId = 0;
        if (Motion.paused) { el.style.transform = ''; return; }
        if (base) {
          var margin = 8;
          mx = Math.max(margin - base.left, Math.min(window.innerWidth - margin - base.right, mx));
          my = Math.max(margin - base.top, Math.min(window.innerHeight - margin - base.bottom, my));
        }
        el.style.transform = 'translate(' + mx.toFixed(1) + 'px,' + my.toFixed(1) + 'px)';
      }
      el.addEventListener('pointerenter', function () {
        base = el.getBoundingClientRect();
      });
      el.addEventListener('pointermove', function (e) {
        var r = base || el.getBoundingClientRect();
        mx = (e.clientX - (r.left + r.width / 2)) * 0.18;
        my = (e.clientY - (r.top + r.height / 2)) * 0.28;
        if (!rafId) rafId = requestAnimationFrame(apply);
      });
      el.addEventListener('pointerleave', function () {
        mx = my = 0;
        base = null;
        el.style.transform = '';
      });
    });
  })();

  /* ----------------------------------------------------------------------
     6. MOOC 章节：平滑折叠 + 搜索 + 展开/收起全部
     ---------------------------------------------------------------------- */
  (function moocArchive() {
    var section = document.getElementById('mooc');
    if (!section) return;
    var chapters = Array.prototype.slice.call(section.querySelectorAll('details.chapter'));
    if (!chapters.length) return;

    /* 为每个 details 包一层可动画容器 */
    chapters.forEach(function (details) {
      var body = document.createElement('div');
      body.className = 'chapter-body';
      var inner = document.createElement('div');
      inner.className = 'chapter-inner';
      var node = details.querySelector('summary').nextSibling;
      while (node) {
        var next = node.nextSibling;
        inner.appendChild(node);
        node = next;
      }
      body.appendChild(inner);
      details.appendChild(body);
    });

    var animating = new WeakSet();
    function toggle(details, open, instant) {
      var body = details.querySelector('.chapter-body');
      if (!body) { details.open = open; return; }
      if (instant || Motion.paused || animating.has(details)) {
        details.open = open;
        body.style.height = '';
        return;
      }
      animating.add(details);
      var inner = body.firstElementChild;
      if (open) {
        details.open = true;
        var target = inner.offsetHeight;
        var anim = body.animate(
          [{ height: '0px', opacity: 0 }, { height: target + 'px', opacity: 1 }],
          { duration: 380, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }
        );
        anim.onfinish = function () { body.style.height = ''; animating.delete(details); };
      } else {
        var start = inner.offsetHeight;
        var anim2 = body.animate(
          [{ height: start + 'px', opacity: 1 }, { height: '0px', opacity: 0 }],
          { duration: 320, easing: 'cubic-bezier(0.5, 0, 0.75, 0)' }
        );
        anim2.onfinish = function () {
          details.open = false;
          body.style.height = '';
          animating.delete(details);
        };
      }
    }

    chapters.forEach(function (details) {
      var summary = details.querySelector('summary');
      summary.addEventListener('click', function (e) {
        e.preventDefault();
        toggle(details, !details.open, false);
      });
    });

    /* 工具条：搜索 + 展开/收起全部（JS 注入，无 JS 时原生 details 照常可用） */
    var head = section.querySelector('.section-head');
    var tools = document.createElement('div');
    tools.className = 'mooc-tools';
    tools.innerHTML =
      '<div class="mooc-search" role="search">' +
        '<label class="visually-hidden" for="mooc-filter">搜索练习编号或标题</label>' +
        '<input id="mooc-filter" type="search" placeholder="搜索练习：如 ex5-03 或 导航" autocomplete="off">' +
        '<button type="button" class="mooc-clear" aria-label="清除搜索">×</button>' +
      '</div>' +
      '<button type="button" class="mooc-tool-btn" data-act="open">全部展开</button>' +
      '<button type="button" class="mooc-tool-btn" data-act="close">全部收起</button>' +
      '<p class="mooc-status" aria-live="polite"></p>';
    head.insertAdjacentElement('afterend', tools);

    var input = tools.querySelector('#mooc-filter');
    var clearBtn = tools.querySelector('.mooc-clear');
    var status = tools.querySelector('.mooc-status');
    var emptyMsg = document.createElement('p');
    emptyMsg.className = 'mooc-empty';
    emptyMsg.hidden = true;
    emptyMsg.textContent = '没有匹配的练习。试试练习编号（如 ex7-06）或标题关键词（如 表格、菜单、JavaScript）。';
    section.querySelector('.chapters').appendChild(emptyMsg);

    var items = [];
    chapters.forEach(function (details) {
      details.querySelectorAll('.ex-list > li').forEach(function (li) {
        items.push({ li: li, details: details, text: li.textContent.toLowerCase() });
      });
    });
    var total = items.length;

    function setStatus(html) { status.innerHTML = html; }
    setStatus('共 <strong>' + total + '</strong> 个练习，可直接浏览或输入关键词过滤');

    function runSearch() {
      var q = input.value.trim().toLowerCase();
      clearBtn.classList.toggle('is-visible', q.length > 0);
      if (!q) {
        items.forEach(function (it) { it.li.hidden = false; });
        chapters.forEach(function (d) { d.hidden = false; });
        emptyMsg.hidden = true;
        setStatus('共 <strong>' + total + '</strong> 个练习，可直接浏览或输入关键词过滤');
        return;
      }
      var hits = 0;
      var chapterHits = new Map();
      items.forEach(function (it) {
        var match = it.text.indexOf(q) !== -1;
        it.li.hidden = !match;
        if (match) {
          hits++;
          chapterHits.set(it.details, (chapterHits.get(it.details) || 0) + 1);
        }
      });
      chapters.forEach(function (d) {
        var count = chapterHits.get(d) || 0;
        d.hidden = count === 0;
        if (count > 0 && !d.open) toggle(d, true, false);
      });
      emptyMsg.hidden = hits > 0;
      setStatus(hits > 0
        ? '匹配 <strong>' + hits + '</strong> / ' + total + ' 个练习（已自动展开所在章节，点击卡片在新窗口打开）'
        : '匹配 <strong>0</strong> / ' + total + ' 个练习');
    }

    var debounce = 0;
    input.addEventListener('input', function () {
      clearTimeout(debounce);
      debounce = setTimeout(runSearch, 120);
    });
    clearBtn.addEventListener('click', function () {
      input.value = '';
      runSearch();
      input.focus();
    });

    tools.querySelector('[data-act="open"]').addEventListener('click', function () {
      chapters.forEach(function (d) { if (!d.hidden && !d.open) toggle(d, true, false); });
    });
    tools.querySelector('[data-act="close"]').addEventListener('click', function () {
      input.value = '';
      runSearch();
      chapters.forEach(function (d) { if (d.open) toggle(d, false, false); });
    });
  })();

  /* ----------------------------------------------------------------------
     7. CSS 层叠实时演示
     真实机制：#cascade-layer-1 / #cascade-layer-2 两个 style 元素的 disabled
     切换 + 段落行内 style 属性的增删，浏览器原生重算层叠。
     ---------------------------------------------------------------------- */
  (function cascadeDemo() {
    var section = document.getElementById('cascade');
    if (!section) return;
    var layer1 = document.getElementById('cascade-layer-1');
    var layer2 = document.getElementById('cascade-layer-2');
    var para = section.querySelector('.cascade-stage .welcome-lede');
    var mount = section.querySelector('.cascade-controls');
    var winnerOut = section.querySelector('#cascade-winner');
    var computedOut = section.querySelector('#cascade-computed');
    var rules = section.querySelectorAll('.cascade-rules li');
    if (!layer1 || !layer2 || !para || !mount || !winnerOut || !computedOut) return;

    var INLINE_VALUE = para.getAttribute('data-inline-value') || '0.1em';
    var state = { l1: true, l2: true, l3: true };

    /* 构建开关（无 JS 时三层全开，与静态说明一致） */
    mount.hidden = false;
    var defs = [
      { key: 'l1', label: '第 1 层 · 外部基础层 <code>.welcome-lede</code> 权重 (0,1,0)' },
      { key: 'l2', label: '第 2 层 · 内部样式表 <code>#welcome .welcome-lede</code> 权重 (1,1,0)' },
      { key: 'l3', label: '第 3 层 · 行内样式 <code>style 属性</code>' }
    ];
    defs.forEach(function (def) {
      var label = document.createElement('label');
      label.className = 'switch';
      label.innerHTML =
        '<input type="checkbox" checked data-layer="' + def.key + '">' +
        '<span class="switch-ui" aria-hidden="true"></span>' +
        '<span class="switch-label">' + def.label + '</span>';
      mount.appendChild(label);
    });
    var reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'mooc-tool-btn';
    reset.textContent = '还原三层全部生效';
    mount.appendChild(reset);

    function updateComputed() {
      var cs = window.getComputedStyle(para);
      var ls = cs.letterSpacing;
      var fs = parseFloat(cs.fontSize);
      if (ls !== 'normal' && fs) {
        var px = parseFloat(ls);
        computedOut.textContent = ls + '（约 ' + (px / fs).toFixed(3) + 'em，字号 ' + cs.fontSize + '）';
      } else {
        computedOut.textContent = ls;
      }
    }

    /* letter-spacing 有 0.5s 过渡：过渡结束后才读取计算值，避免读到中间态；
       transitionend 被快速连打/减少动态效果跳过时可由兜底定时器刷新 */
    var computedTimer = 0;
    para.addEventListener('transitionend', function (e) {
      if (e.propertyName !== 'letter-spacing') return;
      clearTimeout(computedTimer);
      updateComputed();
    });

    function scheduleComputed() {
      clearTimeout(computedTimer);
      computedTimer = setTimeout(updateComputed, 650);
    }

    function apply() {
      layer1.disabled = !state.l1;
      layer2.disabled = !state.l2;
      if (state.l3) para.style.letterSpacing = INLINE_VALUE;
      else para.style.removeProperty('letter-spacing');

      /* 说明列表的高亮/删除线与真实层叠规则一致 */
      var winner = state.l3 ? 3 : state.l2 ? 2 : state.l1 ? 0 : -1;
      rules.forEach(function (li, idx) {
        var layerOn = idx === 0 ? state.l1 : (idx === 3 ? state.l3 : state.l2);
        li.classList.toggle('is-off', !layerOn);
        li.classList.toggle('is-winner', layerOn && idx === winner);
        li.classList.toggle('is-loser', layerOn && idx !== winner);
      });

      var names = [
        '第 1 层 · 外部样式表 .welcome-lede → 0.02em',
        '',
        '第 2 层 · 内部样式表 #welcome .welcome-lede → 0.07em',
        '第 3 层 · 行内 style → 0.1em'
      ];
      winnerOut.textContent = winner === -1 ? '三层全部关闭，回落到浏览器默认 normal' : names[winner];

      scheduleComputed();
    }

    mount.addEventListener('change', function (e) {
      var key = e.target.getAttribute('data-layer');
      if (!key) return;
      state[key] = e.target.checked;
      apply();
    });
    reset.addEventListener('click', function () {
      state = { l1: true, l2: true, l3: true };
      mount.querySelectorAll('input[data-layer]').forEach(function (input) { input.checked = true; });
      apply();
    });
    apply();
  })();

  /* ----------------------------------------------------------------------
     8. 滚动进入视口动效
     ---------------------------------------------------------------------- */
  (function scrollReveal() {
    var els = document.querySelectorAll('.reveal');
    if (!els.length) return;
    if (!('IntersectionObserver' in window) || Motion.paused) {
      els.forEach(function (el) { el.classList.add('in-view'); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('in-view');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
    els.forEach(function (el) { io.observe(el); });
    Motion.onChange(function (paused) {
      if (paused) {
        io.disconnect();
        els.forEach(function (el) { el.classList.add('in-view'); });
      }
    });
  })();

})();
