(function () {
  'use strict';

  /* ============================================================
     逐字歌词
     ------------------------------------------------------------
     一个字被颜色填满之后，才开始填下一个字。
     每个字的填充时长 = 酷狗 KRC 里该字自己的 startTime/endTime，
     不同歌、不同字速度都不同，不是均速。

     快慢偏移：按歌曲 hash 单独存，每首歌互不影响。

     两条关键约束（都是踩过坑换来的）：
     ① MoeKoe 的 .char 字形是 color:transparent，颜色全来自背景渐变。
        绝对不能去动 color，一动整行歌词就消失。
     ② 当前行必须用自己的时间轴判断，不能用 .current-line-group ——
        它是按不含偏移的时间算的，偏移会被卡死，调了等于没调。
     ============================================================ */

  var SET_KEY = 'lyc_word_cfg';
  var OFF_PREFIX = 'lyc_off_';

  var CFG = { sung: '#ff4d8d', unsung: '#e3e3e3e8' };

  // 歌词字体默认跟随应用设置，见 appFont()。
  // 歌词的大小不归这里管：桌面歌词窗口的控制条自带 −A / A+。
  var LOOK = { follow: true };

  // 界面缩放。应用把界面字号全部写死成 px（369 处 font-size:px，rem 只有 11 处），
  // 所以 html{font-size} 这类靠继承的做法根本压不动，只能整体缩放。
  var ZOOM_KEY = 'lyc_ui_zoom';

  // 应用自带的字体栈。设成空字符串会让 font-family 整条失效，所以任何时候
  // --lyc-font 都必须是一个完整的字体列表。
  var APP_FONT_STACK =
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Microsoft YaHei", sans-serif';

  function log() { console.log.apply(console, ['[LyricW]'].concat([].slice.call(arguments))); }

  /* ---------- 配置 ---------- */

  var FILL = { on: true };

  // 歌词描边。桌面歌词窗口是 transparent:true 的无边框置顶窗，背后是桌面
  // 本身，网页层读不到背后的像素 —— 按背景亮度自动判断这条路不存在，
  // 所以做成开关：浅色背景上打开，深色背景上关掉。理由见 styles.css 第 5b 节。
  var STROKE = { on: false };

  // 换行动画。应用原本给 .line-group 的字号加了 .42s 过渡（还带 1.35 的过冲），
  // 可它的 currentTime 是 throttle(…, 200) 节流过的 —— 420ms 的动画配 200ms
  // 才动一次的时钟，动画永远在追，看着就是「歌词到了、版式没跟上」。
  //
  // 注意这里不能靠「提前点亮当前行」来解决。应用自己的顺序（LyricsHandler.js）：
  // highlightCurrentChar -> scrollToCurrentLine -> nextTick 里量 offsetTop，
  // 注释写得很明白「当前行用 font-size 放大会改变各行高度，须等 DOM 应用放大后
  // 再测量」。也就是它本来就是先涨后滚、两条动画在同一个 tick 里起跑、彼此重叠。
  // 谁要是单独把 .current-line-group 提前挂上去，放大会跑到滚动前面去，中间
  // 那段时间行已经变大了却还停在旧位置 —— 看着就是先放大再滚上去，慢一拍。
  //
  // 所以这里不去抢时钟，只把两条过渡调成同一个时长、同一条曲线，让它们读起来
  // 是一个动作而不是两下。参数和取舍写在 styles.css 第 7 节。
  var FLOW = { soft: true };

  function loadCfg() {
    try {
      var raw = localStorage.getItem(SET_KEY);
      if (!raw) return;
      var o = JSON.parse(raw);
      if (o && o.sung) CFG.sung = o.sung;
      if (o && o.unsung) CFG.unsung = o.unsung;
      if (o && o.fill !== undefined) FILL.on = !!o.fill;
      if (o && o.follow !== undefined) LOOK.follow = !!o.follow;
      if (o && o.stroke !== undefined) STROKE.on = !!o.stroke;
      if (o && o.soft !== undefined) FLOW.soft = !!o.soft;
      // 1.1.0 的两个开关（换行即时 / 快速切行）在 1.2.0 合成了「柔和切行」。
      // 读旧的存档，好让升级过来的用户别突然变回应用原本的 420ms 动画。
      if (o && o.soft === undefined && (o.nowrap !== undefined || o.fast !== undefined)) {
        FLOW.soft = !!(o.nowrap && o.fast);
      }
      // 「歌词字号」那个功能撤掉之前存进去的 size 是死数据，读都不读了，
      // 顺手抹掉，免得留在存储里一直误导人。
      if (o && o.size !== undefined) {
        delete o.size;
        try { localStorage.setItem(SET_KEY, JSON.stringify(o)); } catch (x) {}
      }
    } catch (e) {}
  }


  function saveCfg() {
    try {
      localStorage.setItem(SET_KEY, JSON.stringify({
        sung: CFG.sung, unsung: CFG.unsung, fill: FILL.on,
        follow: LOOK.follow, stroke: STROKE.on, soft: FLOW.soft
      }));
    } catch (e) {}
  }

  /* ---------- 字体与字号 ----------

     设置页里有两项字体，存的键不一样：
         settings.font              界面字体（「字体设置」那一栏）
         settings.desktopLyricsFont 歌词字体（「歌词字体」那一栏）
     桌面歌词窗口只读后者，而且读的是 CSS 变量 --desktop-lyrics-font-family。
     在「字体设置」里换成楷体，歌词纹丝不动，就是这两项各管一头造成的。
     所以这里优先用歌词字体，没设就退回界面字体。

     字号同理：应用自己把 lyrics-font-size 存在 localStorage（12~72，默认 32），
     但配套的 .font-size-controls 是 display:none，界面上根本点不到。
  */

  function appFont() {
    var st = {};
    try { st = JSON.parse(localStorage.getItem('settings') || '{}'); } catch (e) {}
    return String(st.desktopLyricsFont || st.font || '').replace(/["\\]/g, '').trim();
  }

  function lookFont() {
    return LOOK.follow && appFont() ? '"' + appFont() + '", ' + APP_FONT_STACK : APP_FONT_STACK;
  }

  // 应用只注入字体族，没有字号（app.asar 里 Pp() 写的是
  //   body, html, button, input, textarea, select { font-family: ... !important }
  //）。换成楷体之后字面变小、看不清，就是因为没有字号这一档可调。
  //
  // 只改字号做不到：界面里 369 处 font-size 全写死 px（rem 只有 11 处），
  // 靠 html{font-size} 继承压不动，逐条覆盖也不现实。
  // 所以走整体缩放 —— Chromium 的 zoom 会重新排版，不是 transform:scale
  // 那种拉伸，布局不会塌。
  //
  // 范围 80~120。再往上侧栏最后一项「退出」会被固定在底部的播放条盖住，
  // 120 下七项全可见（首页/发现/音乐库/设置/更新/关于/退出），实测过。
  //
  // 存的是百分数（滑块原值），用的时候才除以 100。写成倍率读回来过一次，
  // 130 落在倍率区间 [0.8,1.4] 之外被判非法，静默退回 100% ——
  // 滑块动了、界面纹丝不动。
  function uiZoom() {
    var pct = parseFloat(localStorage.getItem(ZOOM_KEY));
    if (!isFinite(pct) || pct < 80 || pct > 120) return 1;
    return pct / 100;
  }

  function applyUiZoom() {
    // 桌面歌词窗口也加载同一个 index.html、也有一个 #app，但那边有自己的
    // 字号控件，不归这里管。
    if (location.hash.indexOf('lyrics') >= 0) return;
    if (!document.getElementById('app')) return;
    var st = document.getElementById('lyc-ui-zoom');
    if (!st) {
      st = document.createElement('style');
      st.id = 'lyc-ui-zoom';
      document.head.appendChild(st);
    }
    // 缩放挂在 html 上，不挂在 #app 上，差别很关键。
    //
    // 挂在子元素上时视口单位不跟着缩放：#app 声明的 100vh 仍是整个视口
    // 高度，再乘上倍率就撑出去，多出来的一截被裁掉 —— 侧栏下半截掉到
    // 播放条底下、滚也滚不到，等于把用户锁死在一个再也调不回来的字号里
    // （而那个字号正是在设置页里调的）。
    //
    // 挂在 html 上等价于浏览器的页面缩放：视口单位按缩放后的尺寸解析，
    // 布局正好收进可视区，不产生溢出，也就不需要 height:auto、
    // overflow:auto、nav 滚动之类补丁 —— 那几个补丁试过，都不对。
    var z = uiZoom();
    // 这段每 40 帧跑一次，值没变就别碰样式表：重写 textContent 会触发一次
    // 全量样式重算，写多了白白掉帧。
    if (st.getAttribute('data-z') === String(z)) return;
    st.setAttribute('data-z', String(z));

    if (z === 1) {
      st.textContent = '';
      document.documentElement.classList.remove('lyc-zoomed');
      return;
    }
    st.textContent = 'html.lyc-zoomed { zoom: ' + z + ' !important; }';
    document.documentElement.classList.add('lyc-zoomed');
  }

  // 两个窗口各跑一份 content script，各自持有一份内存里的 LOOK。
  // 主窗口在设置页改了字号，如果桌面歌词窗口一直用启动时读的那份，
  // 它就得重开一次才生效 —— 这里每次重算前都从存储同步一次，
  // 两边才能实时对上。
  function syncLook() {
    try {
      var o = JSON.parse(localStorage.getItem(SET_KEY) || '{}');
      if (o.follow !== undefined) LOOK.follow = !!o.follow;
      if (o.stroke !== undefined) STROKE.on = !!o.stroke;
      if (o.soft !== undefined) FLOW.soft = !!o.soft;
    } catch (e) {}
  }

  function applyLyricLook() {
    syncLook();
    var r = document.documentElement;
    r.style.setProperty('--lyc-font', lookFont());
    applyUiZoom();
  }

  function applyVars() {
    var r = document.documentElement;
    r.style.setProperty('--lyc-sung', CFG.sung);
    r.style.setProperty('--lyc-unsung', CFG.unsung);
  }

  function applyStroke() {
    document.documentElement.classList.toggle('lyc-stroke', STROKE.on);
  }

  function applyFlow() {
    var r = document.documentElement;
    r.classList.toggle('lyc-flow-soft', FLOW.soft);
  }

  // "rgba(227,227,227,.9)" -> "#e3e3e3"  (needed by <input type=color>)
  function hexOf(v, fallback) {
    var m = /rgba?\(([^)]+)\)/.exec(String(v || ''));
    if (!m) return /^#/.test(v || '') ? v : fallback;
    var p = m[1].split(',').map(function (x) { return parseInt(x, 10) || 0; });
    return '#' + [p[0], p[1], p[2]].map(function (x) {
      return ('0' + x.toString(16)).slice(-2);
    }).join('');
  }

  function getOffset(hash) {
    if (!hash) return 0;
    var v = parseFloat(localStorage.getItem(OFF_PREFIX + hash));
    return isFinite(v) ? Math.max(-30, Math.min(30, v)) : 0;
  }

  function setOffset(hash, v) {
    if (!hash) return 0;
    var n = Math.max(-30, Math.min(30, Math.round(v * 10) / 10));
    try {
      if (n === 0) localStorage.removeItem(OFF_PREFIX + hash);
      else localStorage.setItem(OFF_PREFIX + hash, String(n));
    } catch (e) {}
    return n;
  }

  /* ---------- 播放位置 ---------- */

  function currentSong() {
    try {
      var raw = localStorage.getItem('current_song');
      if (raw) {
        var s = JSON.parse(raw);
        if (s && (s.hash || s.playHash)) return s;
      }
    } catch (e) {}
    return null;
  }

  function currentHash() {
    var s = currentSong();
    return s ? (s.hash || s.playHash || '') : '';
  }

  function parseClock(t) {
    var m = /(\d+):(\d+)/.exec(String(t || ''));
    return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : 0;
  }

  function durationSec() {
    var s = currentSong();
    if (s) {
      var d = Number(s.duration || s.timeLength || 0);
      if (d > 0) return d > 10000 ? d / 1000 : d;
    }
    var el = document.querySelector('.player-container .duration');
    return el ? parseClock(el.textContent) : 0;
  }

  // 进度条按 timeupdate 刷新（约 4Hz），两次之间线性外推
  var clk = { pct: -1, anchor: 0, wall: 0 };

  function currentSec() {
    var bar = document.querySelector('.player-container .progress-bar .progress');
    var dur = durationSec();
    if (!bar || !dur) return 0;

    var pct = parseFloat(bar.style.width || '0');
    if (!isFinite(pct)) pct = 0;
    var now = performance.now();
    if (Math.abs(pct - clk.pct) > 0.02) {
      clk.pct = pct;
      clk.anchor = pct / 100 * dur;
      clk.wall = now;
    }
    var v = clk.anchor + Math.min(0.5, (now - clk.wall) / 1000);
    return Math.max(0, Math.min(dur, v));
  }

  /* ---------- API ---------- */

  function apiBase() {
    try {
      var s = JSON.parse(localStorage.getItem('settings') || '{}');
      var c = (s.apiBaseUrl || '').toString().trim().replace(/\/+$/, '');
      if (c && /^https?:\/\//.test(c)) return c;
    } catch (e) {}
    return 'http://127.0.0.1:6521';
  }

  function headers() {
    try {
      var moe = JSON.parse(localStorage.getItem('MoeData') || '{}');
      var u = moe.UserInfo || {}, d = moe.Device || {};
      var p = [];
      if (u.token) p.push('token=' + u.token);
      if (u.userid) p.push('userid=' + u.userid);
      if (d.dfid) p.push('dfid=' + d.dfid);
      if (u.t1) p.push('t1=' + u.t1);
      if (d.mid) p.push('KUGOU_API_MID=' + d.mid);
      if (d.guid) p.push('KUGOU_API_GUID=' + d.guid);
      if (d.serverDev) p.push('KUGOU_API_DEV=' + d.serverDev);
      if (d.mac) p.push('KUGOU_API_MAC=' + d.mac);
      return p.length ? { Authorization: p.join(';') } : {};
    } catch (e) { return {}; }
  }

  function api(path) {
    return fetch(new URL(path, apiBase()).toString(), {
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers()),
      credentials: 'include'
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  /* ---------- KRC 解析 ----------
     真实格式：[764,1871]<0,305,0>王<305,252,0>大<557,252,0>毛
     行首 ms、整行时长 ms，随后每个字 <字内偏移ms, 字长ms, 0>字 */

  function parseKrc(text) {
    var out = [];
    // KRC 行首带一个 '['，形如 [764,1871] —— 漏掉这个 [ 会导致永远解析不出歌词
    var row = /^\[(\d+),(\d+)\](.*)$/;
    var word = /<(\d+),(\d+),\d+>([^<]*)/g;

    String(text || '').split(/\r?\n/).forEach(function (l) {
      var m = row.exec(l);
      if (!m) return;

      var start = parseInt(m[1], 10);
      var span = parseInt(m[2], 10);
      var chars = [];
      var hit;
      word.lastIndex = 0;
      while ((hit = word.exec(m[3])) !== null) {
        var ch = hit[3];
        if (!ch) continue;
        var st = start + parseInt(hit[1], 10);
        chars.push({ c: ch, s: st, e: st + parseInt(hit[2], 10) });
      }

      if (!chars.length) {
        var txt = m[3].replace(/<.*?>/g, '');
        if (txt.trim()) {
          var step = span / txt.length;
          for (var i = 0; i < txt.length; i++) {
            chars.push({ c: txt[i], s: start + i * step, e: start + (i + 1) * step });
          }
        }
      }

      // 真实数据里确实有字时长为 0（连唱）。用后一个字的起点补齐，
      // 否则这些字永远算不出进度，会一直卡在灰色。
      for (var k = 0; k < chars.length - 1; k++) {
        if (chars[k].e > chars[k].s) continue;
        var j2 = k + 1;
        while (j2 < chars.length && chars[j2].s <= chars[k].s) j2++;
        if (j2 < chars.length) chars[k].e = chars[j2].s;
      }
      // 整段连唱（一堆 <0,0,0>）补不出来，就用行时长均分
      var bad = false;
      for (var q = 0; q < chars.length; q++) {
        if (chars[q].e <= chars[q].s) { bad = true; break; }
      }
      if (bad) {
        var lo = chars[0].s;
        var hi = span > 0 ? start + span : chars[chars.length - 1].s + 250;
        if (hi <= lo) hi = lo + chars.length * 250;
        var st = (hi - lo) / chars.length;
        for (var q2 = 0; q2 < chars.length; q2++) {
          chars[q2].s = lo + q2 * st;
          chars[q2].e = chars[q2].s + st;
        }
      }

      if (chars.length) out.push({ chars: chars, text: chars.map(function (x) { return x.c; }).join('') });
    });

    return out;
  }

  var lyr = { hash: '', lines: null };

  function loadLyric(hash) {
    lyr.hash = hash;
    lyr.lines = null;
    if (!hash) return;

    api('/search/lyric?hash=' + encodeURIComponent(hash))
      .then(function (r) {
        if (!r || r.status !== 200 || !r.candidates || !r.candidates.length) throw new Error('无歌词');
        return api('/lyric?id=' + encodeURIComponent(r.candidates[0].id) +
          '&accesskey=' + encodeURIComponent(r.candidates[0].accesskey || '') +
          '&fmt=krc&decode=true');
      })
      .then(function (r) {
        if (lyr.hash !== hash) return;
        if (!r || r.status !== 200 || !r.decodeContent) throw new Error('空');
        var lines = parseKrc(r.decodeContent);
        if (lyr.hash !== hash) return;
        lyr.lines = lines.length ? lines : null;
        log('歌词', hash, lines.length, '行');
      })
      .catch(function (e) {
        if (lyr.hash === hash) { lyr.lines = null; log('歌词失败', hash, e.message); }
      });
  }

  /* ---------- 逐帧刷新 ---------- */

  var dbg = { line: '' };

  function root() { return document.getElementById('lyrics'); }

  function mainLine(g) {
    for (var i = 0; i < g.children.length; i++) {
      var k = g.children[i];
      if (k.classList.contains('line') &&
        !k.classList.contains('translated') &&
        !k.classList.contains('romanized')) return k;
    }
    return null;
  }

  function norm(s) { return String(s || '').replace(/\s+/g, ''); }

  /** DOM 的 .line-group 顺序 -> 歌词数组下标 */
  function buildMap(groups) {
    var n = groups.length;
    var map = new Array(n);
    for (var i = 0; i < n; i++) map[i] = -1;

    if (lyr.lines.length === n) {
      for (var k = 0; k < n; k++) map[k] = k;
      return map;
    }
    var li = 0;
    for (var g = 0; g < n; g++) {
      var line = mainLine(groups[g]);
      if (!line) continue;
      var t = norm(line.textContent);
      if (!t) continue;
      while (li < lyr.lines.length && norm(lyr.lines[li].text) !== t) li++;
      if (li < lyr.lines.length) map[g] = li++;
    }
    return map;
  }

  function paint() {
    var el = root();
    if (!el) return;
    if (!FILL.on || !lyr.lines) {
      if (el.classList.contains('lyc-word-on')) reset();
      return;
    }

    var groups = el.querySelectorAll('.line-group');
    if (!groups.length) return;

    var off = getOffset(currentHash());
    var now = currentSec() * 1000 + off * 1000;

    // 当前行完全用自己的时间轴判断（含偏移），不依赖 .current-line-group
    var cur = -1;
    for (var t = 0; t < lyr.lines.length; t++) {
      var cs = lyr.lines[t].chars;
      if (!cs.length) continue;
      if (now >= cs[0].s && now <= cs[cs.length - 1].e) { cur = t; break; }
    }
    if (cur < 0) {
      var gap = Infinity;
      for (var t2 = 0; t2 < lyr.lines.length; t2++) {
        var c2 = lyr.lines[t2].chars;
        if (!c2.length) continue;
        var d = now < c2[0].s ? c2[0].s - now
              : (now > c2[c2.length - 1].e ? now - c2[c2.length - 1].e : 0);
        if (d < gap) { gap = d; cur = t2; }
      }
    }
    if (cur < 0) { reset(); return; }

    var map = buildMap(groups);
    el.classList.add('lyc-word-on');

    for (var g = 0; g < groups.length; g++) {
      var li = map[g];
      if (li < 0) continue;

      var line = mainLine(groups[g]);
      if (!line) continue;
      var spans = line.querySelectorAll('.char');
      if (!spans.length) continue;

      var data = lyr.lines[li];
      if (data.chars.length !== spans.length) continue;

      var mode = li < cur ? 2 : (li > cur ? 0 : 1);
      for (var k = 0; k < spans.length; k++) {
        var ch = data.chars[k];
        var p;
        if (mode === 2) p = 100;
        else if (mode === 0) p = 0;
        else if (now >= ch.e) p = 100;
        else if (now <= ch.s) p = 0;
        else p = (now - ch.s) / (ch.e - ch.s) * 100;
        spans[k].style.setProperty('--lyc-p', p.toFixed(2) + '%');
      }
    }

    }

  function reset() {
    var el = root();
    if (!el) return;
    el.classList.remove('lyc-word-on');
    var spans = el.querySelectorAll('.char[style*="--lyc-p"]');
    for (var i = 0; i < spans.length; i++) spans[i].style.removeProperty('--lyc-p');
  }

  /*
     Two sets of speed controls used to live outside the settings panel.
     Both are gone; 词速 is edited in 歌词增强 only, and that panel keeps its
     own readout at `[data-num="off"]`.

     1. A bottom-left strip in the lyrics page (buildBar/showOffset):
        −0.1 / +0.1s / 归零. Same controls as the panel, in the one corner
        that had nothing else in it.

     2. A "词速" button in the player bar (buildButton), appended to
        `.player-container .extra-controls` with `document.body` as the
        fallback. That fallback is what put it in the desktop-lyrics
        window: this content script runs there too, that document has no
        `.extra-controls`, so the button ended up pinned to the top-left of
        the floating lyrics window -- a duplicate control sitting on top of
        the lyrics.

     openSettingsPanel() went with them; nothing opened the panel by button
     any more.
  */

  /* ============================================================
     设置面板
     ------------------------------------------------------------
     插在 MoeKoe 自带的歌词设置面板 .fullscreen-lyrics-settings 里，
     视觉与它原有的分组一致，可折叠。

     为什么敢往 Vue 渲染的面板里插：
       · 面板是独立元素。不像 .lyrics-screen 同时承载歌词、关闭按钮
         和播放条，Vue 重渲染时会整体替换面板，我们的节点随之消失，
         不会留下错位的孤儿节点。
       · 只 appendChild 到末尾，绝不改动它已有的任何节点。
       · 定期检查，面板被重建后自动补回来。
     ============================================================ */

  var VIZ_KEY = 'viz_cfg';
  var OPEN_KEY = 'lyc_sec_open';

  var SUNG_SWATCH = ['#ff4d8d', '#ff7a45', '#ffd166', '#4dd4ac', '#5aa9ff', '#c58cff'];
  var UNSUNG_SWATCH = ['#e8e8ec', '#c9c9cf', '#a3a3ab', '#7d7d86', '#5a5a63', '#3f3f47'];

  // The spectrum plugin keeps its own config under viz_cfg. Both plugins
  // read the same key, so this panel is the only place it gets changed.
  function readViz() {
    var d = {
      on: true, style: 'mirror', height: 150, opacity: 0.72,
      glow: 0.55, smoothing: 1.0, peakHold: 520, peakFade: 780
    };
    try {
      var raw = localStorage.getItem(VIZ_KEY);
      if (raw) {
        var o = JSON.parse(raw);
        if (o.on !== undefined) d.on = !!o.on;
        if (o.style !== undefined) d.style = String(o.style);
        if (o.height !== undefined) d.height = +o.height;
        if (o.opacity !== undefined) d.opacity = +o.opacity;
        if (o.glow !== undefined) d.glow = +o.glow;
        if (o.smoothing !== undefined) d.smoothing = +o.smoothing;
        if (o.peakHold !== undefined) d.peakHold = +o.peakHold;
        if (o.peakFade !== undefined) d.peakFade = +o.peakFade;
      }
    } catch (e) {}
    return d;
  }

  function writeViz(d) {
    try { localStorage.setItem(VIZ_KEY, JSON.stringify(d)); } catch (e) {}
  }

  function fmtOff(v) {
    return (v > 0 ? '+' : '') + v.toFixed(1) + 's';
  }

  // Must stay in step with audio-viz's STYLE_LIST -- same eight modes as
  // hvianna/audioMotion-analyzer. The spectrum plugin reads `style` out of
  // viz_cfg, so this panel is the only place it gets chosen.
  var VIZ_STYLES = [
    ['classic', '经典柱'], ['led', 'LED'], ['mirror', '镜像'], ['wave', '波形'],
    ['radial', '环形'], ['line', '折线'], ['area', '面积'], ['reflex', '反射']
  ];

  // A grid of small buttons rather than a <select>: eight options is too
  // many to scan in a dropdown, and each one deserves a readable label.
  function segRow(label, options, current, key) {
    var out = '<div class="lycx-gridwrap"><span class="lycx-gridlabel">' + label + '</span>' +
      '<div class="lycx-grid">';
    for (var i = 0; i < options.length; i++) {
      out += '<button type="button" class="lycx-cell' +
        (options[i][0] === current ? ' active' : '') +
        '" data-seg="' + key + '" data-val="' + options[i][0] + '">' +
        options[i][1] + '</button>';
    }
    return out + '</div></div>';
  }

  function swRow(label, on, key) {
    return '<div class="lycx-swrow"><span>' + label + '</span>' +
      '<button type="button" class="lycx-sw' + (on ? ' on' : '') +
      '" data-sw="' + key + '" aria-pressed="' + (on ? 'true' : 'false') + '"></button></div>';
  }

  function sliderRow(label, min, max, step, val, unit, key) {
    return '<div class="lycx-sliderow"><span>' + label + '</span>' +
      '<input class="lycx-range" type="range" data-rng="' + key + '" ' +
      'min="' + min + '" max="' + max + '" step="' + step + '" value="' + val + '">' +
      '<span class="lycx-num" data-num="' + key + '">' + unit + '</span></div>';
  }

  // A native <input type=color> opens the OS picker, which steals focus and
  // makes MoeKoe collapse this panel. Preset swatches keep it clickable.
  function swatchRow(label, key, list, current) {
    var cur = String(current || '').toLowerCase();
    var hexes = list.slice();
    var i;
    if (hexes.map(function (x) { return x.toLowerCase(); }).indexOf(cur) < 0) {
      hexes.unshift(current);
    }

    var out = '<div class="lycx-swrow"><span>' + label + '</span>' +
      '<div class="lycx-swatches">';
    for (i = 0; i < hexes.length; i++) {
      var h = hexes[i];
      out += '<button type="button" class="lycx-swatch' +
        (h.toLowerCase() === cur ? ' on' : '') + '" data-color="' + key +
        '" data-hex="' + h + '" title="' + h + '" style="background:' + h + '"></button>';
    }
    return out + '</div></div>';
  }

  /* ============================================================
     设置页：在「字体设置」旁边插一行界面字号
     ------------------------------------------------------------
     用户要的是放在设置里，不是放在歌词页的面板上。

     做法是克隆一张现成的 .setting-card 再改内容，这样边框、圆角、
     背景、字号全部跟应用自己的卡片一致，不用去猜它的 CSS。

     定位靠标题文字而不是类名：卡片标题和值都可能是任意文案，
     但 .setting-card-title 里就是「字体设置」/「歌词字体」。
     两张都存在时插在后面那张（歌词字体）旁边 —— 它才是挨着歌词的那张。
     ============================================================ */

  // 标题里还嵌着一个帮助图标（字体设置那张右上角有个 ?），textContent 会带上它，
  // 所以用包含匹配而不是相等。完全相同的那张排前面，其次才是「歌词字体」——
  // 两张都存在时挨着歌词的是后者，插在它旁边。
  function settingsFontCards() {
    var exact = [];
    var loose = [];
    var cards = document.querySelectorAll('.setting-card');
    for (var i = 0; i < cards.length; i++) {
      var t = cards[i].querySelector('.setting-card-title');
      if (!t) continue;
      var label = (t.textContent || '').replace(/\s+/g, '');
      if (label === '歌词字体') exact.unshift(cards[i]);
      else if (label === '字体设置') exact.push(cards[i]);
      else if (label.indexOf('歌词字体') >= 0) loose.unshift(cards[i]);
      else if (label.indexOf('字体设置') >= 0) loose.push(cards[i]);
    }
    return exact.concat(loose);
  }

  function mountSettingsRow() {
    if (location.hash.indexOf('settings') < 0) return;

    var cards = settingsFontCards();
    if (!cards.length) return;
    var anchor = cards[cards.length - 1];
    var host = anchor.parentElement;
    if (!host) return;

    // Already inserted right after the anchor (Vue may have re-rendered and
    // dropped it, in which case we insert again).
    var next = anchor.nextElementSibling;
    if (next && next.id === 'lyc-zoom-card') return;

    var card = anchor.cloneNode(true);
    card.id = 'lyc-zoom-card';
    card.removeAttribute('style');

    // 丢掉克隆来的图标和帮助链接：字号行自己不需要，? 也没有对应文档可跳。
    var head = card.querySelector('.setting-card-header');
    if (head) {
      var junk = head.querySelectorAll('i, a, svg, button');
      for (var j = junk.length - 1; j >= 0; j--) junk[j].remove();
    }
    var title = card.querySelector('.setting-card-title');
    if (title) {
      title.innerHTML = '';
      var lab = document.createElement('span');
      lab.textContent = '界面字号';
      title.appendChild(lab);
    }

    var val = card.querySelector('.setting-card-value');
    if (!val) { anchor.parentElement.appendChild(card); return; }

    val.innerHTML = '';
    val.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 12px';
    var pct = Math.round(uiZoom() * 100);
    var rng = document.createElement('input');
    rng.type = 'range';
    rng.min = '80';
    rng.max = '120';
    rng.step = '5';
    rng.value = String(pct);
    rng.title = '界面字号';
    rng.style.cssText = 'flex:1;height:4px;accent-color:#ff4d8d;cursor:pointer';
    var num = document.createElement('span');
    num.textContent = pct + '%';
    num.style.cssText = 'min-width:44px;text-align:right;font-variant-numeric:tabular-nums';

    // The wrapper collapses on click-out, so keep focus inside our own row.
    rng.addEventListener('mousedown', function (e) { e.stopPropagation(); });

    // 拖动过程中只改数字，不动界面。
    //
    // 缩放会重排整个应用，滑块自己也会跟着挪位。绑在 input 上（每移动
    // 一像素就生效）的话，滑块会从指针底下跑掉，根本没法对准 —— 拖半天
    // 出来的值不是想要的。所以改成松手（change）才真正生效，拖动期间
    // 只更新右边的百分数，让人知道当前瞄的是多少。
    rng.addEventListener('input', function (e) {
      e.stopPropagation();
      num.textContent = rng.value + '%';
    });
    rng.addEventListener('change', function (e) {
      e.stopPropagation();
      try { localStorage.setItem(ZOOM_KEY, rng.value); } catch (x) {}
      var st = document.getElementById('lyc-ui-zoom');
      if (st) st.removeAttribute('data-z');   // 强制重写，别被幂等判断挡掉
      applyUiZoom();
    });
    // 键盘操作（左右方向键）也会触发 input，同样等 change，避免连按就跳。
    rng.addEventListener('keyup', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        try { localStorage.setItem(ZOOM_KEY, rng.value); } catch (x) {}
        applyUiZoom();
      }
    });

    val.appendChild(rng);
    val.appendChild(num);
    host.insertBefore(card, anchor.nextSibling);
  }

  function buildSection() {
    var viz = readViz();
    var off = getOffset(currentHash());
    var open = false;
    try { open = localStorage.getItem(OPEN_KEY) === '1'; } catch (e) {}

    var sec = document.createElement('div');
    sec.className = 'lycx-sec' + (open ? ' open' : '');
    sec.innerHTML =
      '<button type="button" class="lycx-head">' +
      '<span>歌词增强</span><i class="fas fa-chevron-down"></i></button>' +

      '<div class="lycx-body">' +

      swRow('频谱', viz.on, 'viz') +
      segRow('样式', VIZ_STYLES.map(function (s) { return [s[0], s[1]]; }),
        viz.style, 'style') +
      sliderRow('高度', 40, 260, 4, viz.height, viz.height + 'px', 'vh') +
      sliderRow('透明度', 10, 100, 5, Math.round(viz.opacity * 100),
        Math.round(viz.opacity * 100) + '%', 'vo') +
      sliderRow('光晕', 0, 100, 5, Math.round(viz.glow * 100),
        Math.round(viz.glow * 100) + '%', 'vg') +
      sliderRow('柔和度', 30, 200, 5, Math.round(viz.smoothing * 100),
        Math.round(viz.smoothing * 100) + '%', 'vs') +

      '<div class="lycx-sep"></div>' +

      swRow('逐字连续填充', FILL.on, 'fill') +
      swatchRow('已唱颜色', 'sung', SUNG_SWATCH, hexOf(CFG.sung, '#ff4d8d')) +
      swatchRow('未唱颜色', 'unsung', UNSUNG_SWATCH, hexOf(CFG.unsung, '#e8e8ec')) +
      swRow('歌词描边', STROKE.on, 'stroke') +

      '<div class="lycx-sep"></div>' +

      swRow('柔和切行', FLOW.soft, 'soft') +

      '<div class="lycx-sep"></div>' +

      '<div class="lycx-swrow"><span>歌词快慢</span>' +
      '<span class="lycx-num" data-num="off">' + fmtOff(off) + '</span></div>' +
      '<div class="lycx-seg">' +
      '<button type="button" data-off="-0.1">−0.1s</button>' +
      '<button type="button" data-off="0.1">+0.1s</button>' +
      '<button type="button" data-off="0">归零</button></div>' +

      '</div>';

    return sec;
  }

  /*
     MoeKoe's own card is always in the DOM while the lyrics page is open,
     but the wrapper ships collapsed:
         .fullscreen-lyrics-settings { transform: ... translate(280px) }
         .fullscreen-lyrics-settings.open { transform: ... translate(0) }
     The card itself is .settings-panel inside it, so that is where we
     append -- our section then slides in and out with the panel and gets
     the same blur, radius and padding for free.

     Appending into a fully-rendered container is also far safer than
     touching .lyrics-screen, which holds the lyrics, the close button and
     the player bar all at once; inserting there is what previously broke
     the close button.
  */

  function mount() {
    try {
      var card = document.querySelector('.fullscreen-lyrics-settings .settings-panel');
      if (!card) return false;
      if (card.querySelector('.lycx-sec')) return true;

      var sec = buildSection();
      card.appendChild(sec);
      wire(sec);
      return true;
    } catch (e) {
      log('mount failed: ' + (e && e.message));
      return false;
    }
  }

  function wire(sec) {
    // The wrapper collapses on focusout whenever focus lands outside it, and
    // on mouseleave. Every control here is a real focusable element so the
    // browser has somewhere to put focus; the focusout guard is the net for
    // clicks that land on a plain patch of our own padding.
    sec.addEventListener('focusout', function (e) { e.stopPropagation(); });
    sec.addEventListener('mousedown', function (e) { e.stopPropagation(); });

    sec.querySelector('.lycx-head').addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var open = sec.classList.toggle('open');
      this.setAttribute('aria-expanded', open ? 'true' : 'false');
      try { localStorage.setItem(OPEN_KEY, open ? '1' : '0'); } catch (x) {}
    });

    sec.querySelectorAll('[data-sw]').forEach(function (el) {
      el.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        el.focus();
        var key = el.getAttribute('data-sw');
        if (key === 'viz') {
          var v = readViz();
          v.on = !v.on;
          writeViz(v);
          el.classList.toggle('on', v.on);
          el.setAttribute('aria-pressed', v.on ? 'true' : 'false');
        } else if (key === 'stroke') {
          STROKE.on = !STROKE.on;
          saveCfg();
          applyStroke();
          el.classList.toggle('on', STROKE.on);
          el.setAttribute('aria-pressed', STROKE.on ? 'true' : 'false');
        } else if (key === 'soft') {
          FLOW.soft = !FLOW.soft;
          saveCfg();
          applyFlow();
          el.classList.toggle('on', FLOW.soft);
          el.setAttribute('aria-pressed', FLOW.soft ? 'true' : 'false');
        } else {
          FILL.on = !FILL.on;
          saveCfg();
          applyVars();
          el.classList.toggle('on', FILL.on);
          el.setAttribute('aria-pressed', FILL.on ? 'true' : 'false');
          if (!FILL.on) reset();
        }
      });
    });

    sec.querySelectorAll('[data-seg]').forEach(function (el) {
      el.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        el.focus();
        var v = readViz();
        v.style = el.getAttribute('data-val');
        writeViz(v);
        el.parentElement.querySelectorAll('[data-seg]').forEach(function (b) {
          b.classList.toggle('active', b === el);
        });
      });
    });

    sec.querySelectorAll('[data-rng]').forEach(function (el) {
      var key = el.getAttribute('data-rng');
      var num = sec.querySelector('[data-num="' + key + '"]');
      el.addEventListener('input', function (e) {
        e.stopPropagation();
        var v = readViz();
        if (key === 'vh') {
          v.height = +el.value;
          if (num) num.textContent = v.height + 'px';
        } else if (key === 'vo') {
          v.opacity = +el.value / 100;
          if (num) num.textContent = el.value + '%';
        } else if (key === 'vg') {
          v.glow = +el.value / 100;
          if (num) num.textContent = el.value + '%';
        } else if (key === 'vs') {
          v.smoothing = +el.value / 100;
          if (num) num.textContent = el.value + '%';
        }
        writeViz(v);
      });
    });

    sec.querySelectorAll('[data-color]').forEach(function (el) {
      el.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        el.focus();
        var hex = el.getAttribute('data-hex');
        if (el.getAttribute('data-color') === 'sung') CFG.sung = hex;
        else CFG.unsung = hex;
        saveCfg();
        applyVars();
        el.parentElement.querySelectorAll('[data-color]').forEach(function (b) {
          b.classList.toggle('on', b === el);
        });
      });
    });

    sec.querySelectorAll('[data-off]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var h = currentHash();
        if (!h) return;
        var d = parseFloat(b.getAttribute('data-off'));
        setOffset(h, d === 0 ? 0 : Math.round((getOffset(h) + d) * 10) / 10);
        var v = getOffset(h);
        var num = sec.querySelector('[data-num="off"]');
        if (num) num.textContent = fmtOff(v);
      });
    });
  }

  /* ============================================================
     浅色浮层文字：按实际背景亮度决定要不要改色
     ------------------------------------------------------------
     判断依据是算出来的，不是拍脑袋：
     · 菜单这类浮层的背景可能深可能浅，读它的 computed
       backgroundColor，半透明的先和它下面（白底）合成，算出眼睛实际
       看到的亮度，超过 140 就把文字改深。
     · 歌词区不用走这条路：.lyrics-screen 自带 #1616169c（黑 61% 遮罩），
       歌词永远落在偏暗的背景上，粉字/浅灰字对比本来就够。
       这是算出来的结论，不是省事。歌词要描边的话是第 5b 节的开关，
       那是给桌面歌词窗口的浅背景用的，跟这里不是一回事。
     ============================================================ */

  function perceivedLuminance(cssColor) {
    var m = /rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*(?:,\s*([\d.]+)\s*)?\)/
      .exec(cssColor || '');
    if (!m) return -1;
    var a = m[4] === undefined ? 1 : parseFloat(m[4]);
    var lum = 0.2126 * parseFloat(m[1]) + 0.7152 * parseFloat(m[2]) + 0.0722 * parseFloat(m[3]);
    return lum * a + 255 * (1 - a);
  }

  function adaptMenus() {
    var menus = document.querySelectorAll(
      '.player-menu, .quality-menu, .speed-menu, .playback-mode-menu');
    for (var i = 0; i < menus.length; i++) {
      var el = menus[i];
      var lum = perceivedLuminance(getComputedStyle(el).backgroundColor);
      if (lum < 0) continue;
      el.classList.toggle('lyc-on-light', lum > 140);
    }
  }

  function tickSettings() {
    // 三步各自兜住：设置面板插不进去、字号算不出来，都不该影响菜单配色
    // 和逐字填充。
    try { mount(); } catch (e) { log('挂载设置面板失败：' + (e && e.message)); }
    try { mountSettingsRow(); } catch (e) { log('挂载界面字号失败：' + (e && e.message)); }
    try { adaptMenus(); } catch (e) { log('菜单配色适配失败：' + (e && e.message)); }
    // 应用设置是运行时可改的（设置页改完立刻生效），而两个窗口各自跑一份
    // content script，所以这里每次都重新算一遍，别的窗口靠 CSS 变量同步。
    try { applyLyricLook(); } catch (e) { log('应用字体/缩放失败：' + (e && e.message)); }
    try { applyStroke(); } catch (e) { log('应用描边失败：' + (e && e.message)); }
    try { applyFlow(); } catch (e) { log('应用换行设置失败：' + (e && e.message)); }
  }

  /* ============================================================
     主循环
     ============================================================ */

  var lastHash = null;
  var n = 0;
  var tickFails = 0;

  /* ============================================================
     主循环
     ------------------------------------------------------------
     这一帧里的任何一步抛异常，都不能让循环停掉，也不能刷屏。
     requestAnimationFrame 在最前面，下一帧一定排上了；用 try 包住
     剩下部分，异常记一次就够了 —— 同一种错误连报几十条没有意义，
     真正需要的是「哪一步炸了」这一条。
     ============================================================ */

  function tick() {
    requestAnimationFrame(tick);
    n++;

    try {
      var h = currentHash();
      if (h !== lastHash) {
        lastHash = h;
        clk.pct = -1;
        reset();
        loadLyric(h);
      }

      if (n % 40 === 0) tickSettings();

      paint();
    } catch (e) {
      if (tickFails++ < 5) {
        log('第 ' + n + ' 帧出错：' + (e && e.message) + '\n' + (e && e.stack || ''));
      }
    }
  }

  loadCfg();
  applyVars();
  applyStroke();
  applyFlow();
  applyLyricLook();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tick);
  } else {
    tick();
  }

  log('已加载');
})();