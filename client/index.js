/**
 * dsh-world — 浏览器半侧：设置里的「世界控制台」。
 * 模块 id 必须等于 bundle 行名 dsh-world；数据来自宿主半侧的 /dsh-world/console/* 路由。
 * 读取是 GET；会改变东西的（开始、停止、人设、世界提示词、额度、记忆轮数）是带 x-dsh-world 头的 JSON POST。
 */
window.__ModuleLoader__.load({
  id: 'dsh-world',
  factory: (require) => {
    var react = require('react')
    var h = react.createElement
    var useState = react.useState
    var useEffect = react.useEffect
    var useRef = react.useRef

    function settle(r) {
      return r.json().then(function (body) { return { body: body } }, function () { return null }).then(function (parsed) {
        var body = parsed && parsed.body
        if (!r.ok) { var err = new Error((body && body.error) || ('HTTP ' + r.status)); err.status = r.status; throw err }
        if (!parsed) { var bad = new Error('回复不是 JSON'); bad.notJson = true; throw bad }
        return body
      })
    }
    function getFrom(base, path) { return fetch(base + path, { cache: 'no-store' }).then(settle) }
    function postTo(base, path, body) {
      return fetch(base + path, { method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json', 'x-dsh-world': '1' }, body: JSON.stringify(body || {}) }).then(settle)
    }
    function api(path) { return getFrom('/dsh-world/console/', path) }
    function post(path, body) { return postTo('/dsh-world/console/', path, body) }
    /** QQ 那几扇门在自己的前缀下（/dsh-world/qq/*），不和 console 混在一起。 */
    function qqGet(path) { return getFrom('/dsh-world/qq/', path) }
    function qqPost(path, body) { return postTo('/dsh-world/qq/', path, body) }
    /** 保存没成时的那句话。 */
    function failedTo(setMsg) { return function (e) { setMsg('保存失败：' + (e.message || e)) } }
    /** 设置卡下面那行状态：没成（失败、请填…）标红，其余灰色。 */
    function Status(props) { return props.msg ? h('div', { role: 'status', className: /失败|请填/.test(props.msg) ? 'dw-bad' : 'dw-muted' }, props.msg) : null }
    /** 快照，或 null 表示控制台不在（404、不是 JSON 的页面、没有 life 字段的回复）。 */
    function loadSnapshot() {
      return api('snapshot').then(function (s) {
        return s && typeof s === 'object' && typeof s.life === 'object' ? s : null
      }, function (e) { if (e && (e.status === 404 || e.notJson)) return null; throw e })
    }
    function clock(iso, zone) {
      try { return new Date(iso).toLocaleTimeString('zh-CN', { timeZone: zone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }) } catch (e) { return String(iso) }
    }
    function local(iso, zone) {
      if (!iso) return '—'
      try { return new Date(iso).toLocaleString('zh-CN', { timeZone: zone, hourCycle: 'h23', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) } catch (e) { return iso }
    }
    function remaining(iso) {
      var ms = Date.parse(iso) - Date.now()
      if (!(ms > 0)) return '马上'
      var m = Math.round(ms / 60000), d = Math.floor(m / 1440), hr = Math.floor(m % 1440 / 60), mi = m % 60
      return (d ? d + ' 天 ' : '') + (hr ? hr + ' 小时 ' : '') + mi + ' 分'
    }
    function list(value) { return Array.isArray(value) ? value : [] }
    var sourceLabel = { first: '新家', return: '回来', plan: '闹钟', fallback: '早上兜底', review: '回顾' }
    var statusLabel = { running: '正在做事', idle: '空闲', cold: '休息中' }

    var LAYERS = [
      { key: '名字', hint: '她叫什么。家的标题、记忆里她的署名都用它。', rows: 1 },
      { key: '她是谁', hint: '一句话：她是什么样的存在。', rows: 2 },
      { key: '性格', hint: '她的脾气、偏好和小习惯。', rows: 4 },
      { key: '说话方式', hint: '口吻、句子长短、会不会用表情。', rows: 3 },
      { key: '愿景', hint: '你希望她成为什么样子。', rows: 4 },
      { key: '补充', hint: '其他想让她知道的：底线、默契、约定。', rows: 3 },
    ]
    /** 和宿主半侧 renderPersona 一样拼：她读到的就是这段。 */
    function renderPersona(p) {
      var opening = (p['名字'] ? '我是' + p['名字'] + '。' : '') + (p['她是谁'] || '')
      var parts = [opening]
      ;['性格', '说话方式', '愿景'].forEach(function (k) { if (p[k]) parts.push('# ' + k + '\n' + p[k]) })
      parts.push(p['补充'] || '')
      return parts.filter(Boolean).join('\n\n')
    }

    var CSS = [
      '.dw{--ink:var(--dsw-alias-label-primary,#2a2620);--soft:var(--dsw-alias-label-tertiary,#8b8475);--gold:#c49a52;',
      '--line:color-mix(in srgb,currentColor 13%,transparent);--paper:color-mix(in srgb,currentColor 3.5%,transparent);',
      '--glow:color-mix(in srgb,var(--gold) 22%,transparent);--warn:#c4553a;--serif:"Noto Serif SC","Source Han Serif SC","Songti SC","STSong","SimSun",serif;',
      'max-width:780px;display:flex;flex-direction:column;gap:18px;font-size:13px;line-height:1.65;color:var(--ink)}',
      '.dw *{box-sizing:border-box}',
      '.dw-head{position:relative;display:flex;align-items:flex-end;gap:16px;padding:18px 20px 16px;border:1px solid var(--line);border-radius:14px;',
      'background:radial-gradient(120% 140% at 100% 0%,var(--glow),transparent 55%),var(--paper);overflow:hidden}',
      '.dw-head:after{content:"";position:absolute;left:20px;right:20px;bottom:0;height:1px;background:linear-gradient(90deg,transparent,var(--gold),transparent);opacity:.55}',
      '.dw-title{flex:1;min-width:0}.dw-title small{display:block;letter-spacing:.24em;font-size:10px;text-transform:uppercase;color:var(--soft)}',
      '.dw-title h2{margin:2px 0 0;font:600 24px/1.25 var(--serif);letter-spacing:.04em}',
      '.dw-state{display:inline-flex;align-items:center;gap:7px;font-size:12px;color:var(--soft);margin-top:6px}',
      '.dw-dot{width:8px;height:8px;border-radius:50%;background:var(--soft);opacity:.6}',
      '.dw-on .dw-dot{background:var(--gold);opacity:1;box-shadow:0 0 0 0 var(--glow);animation:dw-breathe 2.6s ease-in-out infinite}',
      '@keyframes dw-breathe{0%,100%{box-shadow:0 0 0 0 var(--glow)}50%{box-shadow:0 0 0 7px transparent}}',
      '.dw-power{font:600 13px var(--serif);letter-spacing:.2em;padding:9px 20px 9px 22px;border-radius:999px;cursor:pointer;transition:transform .15s,box-shadow .2s,background .2s;',
      'border:1px solid var(--gold);background:var(--gold);color:#fffaf0;box-shadow:0 6px 18px -8px var(--gold)}',
      '.dw-power:hover{transform:translateY(-1px);box-shadow:0 10px 22px -8px var(--gold)}',
      '.dw-power.stop{background:transparent;color:var(--ink);border-color:var(--line);box-shadow:none}.dw-power.stop:hover{border-color:var(--warn);color:var(--warn)}',
      '.dw-power:disabled{opacity:.5;cursor:default;transform:none}',
      '.dw-tabs{display:flex;flex-wrap:wrap;gap:4px;border-bottom:1px solid var(--line);padding:0 6px}',
      '.dw-tab{position:relative;font:500 13px var(--serif);letter-spacing:.12em;padding:8px 14px 10px;background:none;border:0;color:var(--soft);cursor:pointer}',
      '.dw-tab:after{content:"";position:absolute;left:50%;right:50%;bottom:-1px;height:2px;background:var(--gold);transition:left .25s,right .25s}',
      '.dw-tab.on{color:var(--ink)}.dw-tab.on:after{left:12px;right:12px}',
      '.dw-pane{display:flex;flex-direction:column;gap:14px}',
      '.dw-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}',
      '.dw-card{min-width:0;border:1px solid var(--line);border-radius:12px;padding:14px 16px;background:var(--paper);animation:dw-rise .45s both}',
      '@keyframes dw-rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}',
      '.dw-card h4{margin:0 0 10px;font:600 13px var(--serif);letter-spacing:.14em;display:flex;align-items:center;gap:8px}',
      '.dw-card h4:before{content:"";width:14px;height:1px;background:var(--gold)}',
      '.dw-kv{display:grid;grid-template-columns:auto 1fr;gap:4px 14px}.dw-kv dt{color:var(--soft);white-space:nowrap}.dw-kv dd{margin:0;min-width:0;overflow-wrap:anywhere}',
      '.dw-big{font:600 20px/1.2 var(--serif)}.dw-muted{color:var(--soft)}.dw-bad{color:var(--warn)}.dw-ok{color:var(--gold)}',
      '.dw-quote{border-left:2px solid var(--gold);padding:2px 0 2px 10px;margin:8px 0 0;font-family:var(--serif)}',
      '.dw-meter{height:4px;border-radius:4px;background:var(--line);overflow:hidden;margin:8px 0 4px}.dw-meter i{display:block;height:100%;background:linear-gradient(90deg,var(--gold),color-mix(in srgb,var(--gold) 55%,#fff))}',
      '.dw-trail{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:4px}.dw-trail span{display:inline-flex;align-items:center;gap:6px}.dw-trail span:before{content:"";width:5px;height:5px;border-radius:50%;background:var(--gold)}',
      '.dw-welcome{text-align:center;padding:30px 20px}.dw-welcome h3{font:600 20px var(--serif);margin:0 0 8px;letter-spacing:.06em}',
      '.dw-steps{display:inline-flex;flex-direction:column;gap:6px;text-align:left;margin-top:12px;counter-reset:s}',
      '.dw-steps li{list-style:none;counter-increment:s;display:flex;gap:10px}.dw-steps li:before{content:counter(s);font:600 12px var(--serif);color:var(--gold);border:1px solid var(--gold);border-radius:50%;width:20px;height:20px;display:inline-grid;place-items:center;flex:none}',
      '.dw-layer{display:grid;grid-template-columns:96px 1fr;gap:4px 16px;padding:14px 0;border-bottom:1px dashed var(--line)}',
      '.dw-layer:last-child{border-bottom:0}.dw-layer label{font:600 14px var(--serif);letter-spacing:.1em;padding-top:6px}',
      '.dw-layer small{grid-column:2;color:var(--soft);font-size:11.5px}',
      '.dw textarea,.dw input[type=text]{width:100%;font:inherit;color:inherit;background:color-mix(in srgb,currentColor 2%,transparent);border:1px solid var(--line);border-radius:8px;padding:8px 10px;resize:vertical;transition:border-color .2s,box-shadow .2s}',
      '.dw textarea:focus,.dw input[type=text]:focus{outline:none;border-color:var(--gold);box-shadow:0 0 0 3px var(--glow)}',
      '.dw input.dw-name{font:600 18px var(--serif);letter-spacing:.06em}',
      '.dw-code{font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;font-size:12px;line-height:1.6;min-height:340px}',
      '.dw-bar{position:sticky;bottom:0;display:flex;align-items:center;gap:10px;padding:10px 0 2px;background:linear-gradient(transparent,var(--dsw-alias-background-primary,transparent) 40%)}',
      '.dw-btn{flex-shrink:0;white-space:nowrap;font:inherit;cursor:pointer;border:1px solid var(--line);background:transparent;color:inherit;border-radius:8px;padding:6px 14px;transition:border-color .2s,background .2s}',
      '.dw-btn:hover{border-color:var(--gold)}.dw-btn.primary{background:var(--gold);border-color:var(--gold);color:#fffaf0}.dw-btn:disabled{opacity:.45;cursor:default}',
      '.dw-preview{white-space:pre-wrap;font-family:var(--serif);font-size:12.5px;margin:0;max-height:260px;overflow:auto}',
      '.dw-chip{display:inline-block;font-size:11px;padding:1px 8px;border-radius:999px;border:1px solid var(--line);color:var(--soft)}',
      '.dw table{width:100%;border-collapse:collapse}.dw td{padding:3px 6px;vertical-align:top;border-bottom:1px solid color-mix(in srgb,currentColor 6%,transparent)}',
      '.dw-activity{table-layout:fixed}.dw-activity td{overflow:hidden;overflow-wrap:anywhere}.dw-activity td:first-child{white-space:nowrap}',
      '.dw-clamp{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;font-size:12px}',
      '.dw-setting{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;align-items:center}.dw-setting input[type=text]{flex:1 1 120px;max-width:200px;min-width:0}',
      '.dw-setting select{flex:1 1 140px;max-width:100%;min-width:0}',
      '.dw pre.dw-diary{white-space:pre-wrap;margin:10px 0 0;font-family:var(--serif)}',
      '.dw select{font:inherit;color:inherit;background:transparent;border:1px solid var(--line);border-radius:6px;padding:2px 6px}',
      '@media (prefers-reduced-motion:reduce){.dw *{animation:none!important;transition:none!important}}',
    ].join('')
    function ensureStyle() {
      if (document.getElementById('dsh-world-console-style')) return
      var tag = document.createElement('style'); tag.id = 'dsh-world-console-style'; tag.textContent = CSS; document.head.appendChild(tag)
    }

    function Card(props) {
      return h('section', { className: 'dw-card', style: { animationDelay: (props.delay || 0) + 'ms' } }, props.title ? h('h4', null, props.title) : null, props.children)
    }
    function KV(rows) {
      return h('dl', { className: 'dw-kv' }, rows.filter(Boolean).map(function (row, i) { return [h('dt', { key: 'k' + i }, row[0]), h('dd', { key: 'v' + i }, row[1])] }))
    }

    function Activity(props) {
      var days = props.days, zone = props.zone
      var dayState = useState(days[0] || ''), day = dayState[0], setDay = dayState[1]
      var outsideState = useState(false), outside = outsideState[0], setOutside = outsideState[1]
      var rowsState = useState([]), rows = rowsState[0], setRows = rowsState[1]
      var errState = useState(null), err = errState[0], setErr = errState[1]
      useEffect(function () {
        if (!day) return
        var alive = true
        api('activity?day=' + encodeURIComponent(day) + (outside ? '&outside=1' : '')).then(
          function (r) { if (alive) { setRows(r); setErr(null) } },
          function (e) { if (alive) { setRows([]); setErr(String(e.message || e)) } })
        return function () { alive = false }
      }, [day, outside, props.tick])
      return h(Card, { title: '活动记录' },
        days.length === 0 ? h('div', { className: 'dw-muted' }, '还没有活动记录') : h('div', null,
          h('select', { value: day, onChange: function (e) { setDay(e.target.value) } }, days.map(function (d) { return h('option', { key: d, value: d }, d) })),
          ' ', h('label', { className: 'dw-muted' }, h('input', { type: 'checkbox', checked: outside, onChange: function (e) { setOutside(e.target.checked) } }), ' 只看房间外'),
          err ? h('div', { className: 'dw-bad' }, '读取失败：' + err) : null,
          h('table', { className: 'dw-activity' },
            h('colgroup', null, h('col', { style: { width: 48 } }), h('col', { style: { width: '22%' } }), h('col'), h('col', { style: { width: 40 } }), h('col', { style: { width: 64 } })),
            h('tbody', null, rows.map(function (r) {
            return h('tr', { key: r.callId + r.time }, h('td', { className: 'dw-muted' }, clock(r.time, zone)), h('td', null, r.tool), h('td', { title: r.summary }, h('div', { className: 'dw-clamp' }, r.summary)), h('td', { className: 'dw-bad' }, r.status === 'error' ? '失败' : ''), h('td', { className: r.outside ? 'dw-bad' : 'dw-muted' }, (r.gapBefore ? '（此前有缺口）' : '') + (r.outside ? '房间外' : '')))
          })))))
    }
    function Diary(props) {
      var openState = useState(null), open = openState[0], setOpen = openState[1]
      var textState = useState(''), text = textState[0], setText = textState[1]
      var errState = useState(null), err = errState[0], setErr = errState[1]
      var wanted = useRef(null)
      function show(date) {
        wanted.current = date; setOpen(date); setText(''); setErr(null)
        api('diary?date=' + encodeURIComponent(date)).then(
          function (b) { if (wanted.current === date) setText(String(b.text || '')) },
          function (e) { if (wanted.current === date) setErr(String(e.message || e)) })
      }
      return h(Card, { title: '日记' },
        props.dates.length === 0 ? h('div', { className: 'dw-muted' }, '还没有日记') : h('div', null,
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } }, props.dates.map(function (d) { return h('button', { key: d, className: 'dw-btn' + (open === d ? ' primary' : ''), onClick: function () { show(d) } }, d) })),
          err ? h('div', { className: 'dw-bad' }, '读取失败：' + err) : null,
          open && !err ? h('pre', { className: 'dw-diary' }, text) : null))
    }

    function PhotoAlbum(props) {
      var pageState = useState({ photos: [], total: 0, hasMore: false }), page = pageState[0], setPage = pageState[1]
      var offsetState = useState(0), offset = offsetState[0], setOffset = offsetState[1]
      var openState = useState(null), open = openState[0], setOpen = openState[1]
      var errorState = useState(''), error = errorState[0], setError = errorState[1]
      useEffect(function () {
        var alive = true
        api('photos?limit=12&offset=' + offset).then(function (value) { if (alive) { setPage(value); setError('') } }, function (e) { if (alive) setError(String(e.message || e)) })
        return function () { alive = false }
      }, [offset, props.tick])
      return h('div', { className: 'dw-pane' },
        h(Card, { title: '她收藏的照片' },
          h('div', { className: 'dw-muted' }, '由她用 keep_photo 决定收藏。列表只读取说明，点开才加载图片。'),
          error ? h('div', { className: 'dw-bad', role: 'alert' }, error) : null,
          page.photos.length ? page.photos.map(function (photo) {
            return h('div', { className: 'dw-setting', key: photo.id },
              h('span', { style: { flex: '1 1 180px', overflowWrap: 'anywhere' } }, photo.description || '未写说明', ' · ', photo.width + '×' + photo.height, ' · ', local(photo.savedAt, props.zone), photo.tags.length ? ' · ' + photo.tags.join('、') : ''),
              h('button', { className: 'dw-btn', onClick: function () { setOpen(open === photo.id ? null : photo.id) } }, open === photo.id ? '收起照片' : '查看照片'),
              open === photo.id ? h('img', { src: '/dsh-world/console/photo?id=' + encodeURIComponent(photo.id), alt: photo.description || '收藏的照片', style: { display: 'block', width: '100%', maxHeight: 480, objectFit: 'contain' }, onError: function () { setError('照片读取失败，请刷新后重试。') } }) : null)
          }) : h('div', { className: 'dw-muted' }, '她还没有收藏照片。'),
          h('div', { className: 'dw-setting' },
            h('button', { className: 'dw-btn', disabled: offset === 0, onClick: function () { setOffset(Math.max(0, offset - 12)); setOpen(null) } }, '上一页'),
            h('span', { className: 'dw-muted' }, '共 ' + page.total + ' 张 · 第 ' + (Math.floor(offset / 12) + 1) + ' 页'),
            h('button', { className: 'dw-btn', disabled: !page.hasMore, onClick: function () { setOffset(offset + 12); setOpen(null) } }, '下一页'))))
    }
    /** 分层人设：每层一张卡，右边是她实际读到的样子。 */
    function PersonaEditor(props) {
      var state = useState(null), persona = state[0], setPersona = state[1]
      var savedState = useState(null), saved = savedState[0], setSaved = savedState[1]
      var msgState = useState(''), msg = msgState[0], setMsg = msgState[1]
      var busyState = useState(false), busy = busyState[0], setBusy = busyState[1]
      useEffect(function () {
        api('prompts').then(function (b) { setPersona(b.persona); setSaved(b.persona) }, function (e) { setMsg('读取失败：' + (e.message || e)) })
      }, [])
      if (!persona) return h('div', { className: 'dw-muted' }, msg || '读取中…')
      var dirty = JSON.stringify(persona) !== JSON.stringify(saved)
      function set(key, value) { var next = Object.assign({}, persona); next[key] = value; setPersona(next); setMsg('') }
      function save() {
        setBusy(true)
        post('persona', persona).then(function () { setSaved(persona); setMsg('已保存。新会话或下次压缩后生效，也可点击「应用并压缩家会话」。'); if (props.onSaved) props.onSaved() },
          failedTo(setMsg)).then(function () { setBusy(false) })
      }
      var preview = renderPersona(persona)
      return h('div', { className: 'dw-pane' },
        h(Card, { title: '她是谁' }, h('div', { className: 'dw-muted' }, '这里写的会取代 DSH 自带的那句默认身份（“You are an AI agent powered by DeepSeek Harness.”）；如果你在 DSH 里已经设过系统人设，它原样保留，这里写的排在它后面。'), LAYERS.map(function (layer) {
          var common = { id: 'dw-' + layer.key, value: persona[layer.key] || '', onChange: function (e) { set(layer.key, e.target.value) } }
          return h('div', { className: 'dw-layer', key: layer.key },
            h('label', { htmlFor: common.id }, layer.key),
            layer.rows === 1 ? h('input', Object.assign({ type: 'text', className: 'dw-name', placeholder: '比如：鲸鲸' }, common)) : h('textarea', Object.assign({ rows: layer.rows }, common)),
            h('small', null, layer.hint))
        })),
        h(Card, { title: '她读到的样子', delay: 80 }, preview ? h('pre', { className: 'dw-preview' }, preview) : h('div', { className: 'dw-muted' }, '还什么都没写。没写的时候，她沿用 DSH 自带的默认身份和你在 DSH 里设的系统人设。')),
        h('div', { className: 'dw-bar' },
          h('button', { className: 'dw-btn primary', disabled: !dirty || busy, onClick: save }, busy ? '保存中…' : '保存人设'),
          h('span', { className: msg.indexOf('失败') >= 0 ? 'dw-bad' : 'dw-muted' }, msg || (dirty ? '有改动还没保存' : ''))))
    }
    /** 世界提示词模板：自己的一份，或插件自带的。 */
    function PromptEditor() {
      var state = useState(null), prompt = state[0], setPrompt = state[1]
      var textState = useState(''), text = textState[0], setText = textState[1]
      var msgState = useState(''), msg = msgState[0], setMsg = msgState[1]
      function load() { api('prompts').then(function (b) { setPrompt(b.worldPrompt); setText(b.worldPrompt.text) }, function (e) { setMsg('读取失败：' + (e.message || e)) }) }
      useEffect(load, [])
      if (!prompt) return h('div', { className: 'dw-muted' }, msg || '读取中…')
      function save(value, done) {
        post('world-prompt', { text: value }).then(function () { setMsg(done); load() }, failedTo(setMsg))
      }
      return h('div', { className: 'dw-pane' },
        h(Card, { title: '世界提示词' },
          h('div', { style: { marginBottom: 8 } }, h('span', { className: 'dw-chip' }, prompt.custom ? '你自己的一份' : '插件自带'), ' ',
            h('span', { className: 'dw-muted' }, '可用 {{name}} {{partner}} {{homeTitle}} {{roomDir}} {{diaryDir}} {{selfFile}} {{self}} 和 {{#home}}…{{/home}} 等，见 README')),
          h('textarea', { className: 'dw-code', value: text, onChange: function (e) { setText(e.target.value); setMsg('') } })),
        h('div', { className: 'dw-bar' },
          h('button', { className: 'dw-btn primary', disabled: text === prompt.text, onClick: function () { save(text, '已保存。新会话或下次压缩后生效，也可点击「应用并压缩家会话」。') } }, '保存'),
          prompt.custom ? h('button', { className: 'dw-btn', onClick: function () { if (window.confirm('删掉你自己的这份，换回插件自带的模板？')) save('', '已换回插件自带的模板。') } }, '恢复默认') : null,
          h('span', { className: msg.indexOf('失败') >= 0 ? 'dw-bad' : 'dw-muted' }, msg)))
    }

    function HomeApply(props) {
      var snap = props.snap, state = snap.homeApply || {}
      var sendingState = useState(false), sending = sendingState[0], setSending = sendingState[1]
      var errorState = useState(''), error = errorState[0], setError = errorState[1]
      var waiting = state.status === 'waiting', compacting = state.status === 'compacting'
      function apply() {
        setSending(true); setError('')
        post('apply-home').then(function () { props.refresh() }, function (e) { setError(String(e.message || e)) }).then(function () { setSending(false) })
      }
      return h(Card, { title: '应用已保存配置' },
        h('div', { className: 'dw-muted' }, '先保存人设和世界提示词，再提交。等待家空闲后压缩一次；压缩会调用模型并重建上下文缓存。'),
        h('div', { className: 'dw-setting' },
          h('button', { className: 'dw-btn', disabled: sending || waiting || compacting || !snap.running || !snap.life || !snap.homeApply, onClick: apply }, waiting ? '等待家空闲…' : compacting ? '正在压缩家会话…' : sending ? '提交中…' : '应用并压缩家会话'),
          h('span', { role: 'status', 'aria-live': 'polite', className: error || state.status === 'failed' ? 'dw-bad' : 'dw-muted' }, error || (waiting ? '已排队，不打断当前对话。' : compacting ? '正在执行，请稍候。' : state.message) || (!snap.running || !snap.life ? '请先启动世界生活线。' : ''))))
    }

    /** 今天家里花了多少，和每天的额度（留空不限）。 */
    function Budget(props) {
      var budget = props.budget || {}, daily = budget.daily, today = budget.today
      var spent = today ? today.yuan : 0
      var draftState = useState(daily == null ? '' : String(daily)), draft = draftState[0], setDraft = draftState[1]
      var msgState = useState(''), msg = msgState[0], setMsg = msgState[1]
      function save() {
        var text = String(draft).trim(), value = text === '' ? null : Number(text)
        if (value !== null && !(value >= 0)) { setMsg('请填一个不小于 0 的数，或留空表示不限'); return }
        post('budget', { daily: value }).then(function () { setMsg(value === null ? '已改为不限' : '已保存'); if (props.onSaved) props.onSaved() }, failedTo(setMsg))
      }
      var over = daily != null && spent >= daily
      return h(Card, { title: '今日花费', delay: 240 },
        h('div', null, h('span', { className: 'dw-big' + (over ? ' dw-bad' : '') }, '¥' + spent.toFixed(2)), h('span', { className: 'dw-muted' }, daily == null ? ' · 不限额' : ' / ¥' + Number(daily).toFixed(2) + ' 每天')),
        daily != null ? h('div', { className: 'dw-meter' }, h('i', { style: { width: Math.min(100, daily > 0 ? Math.round(spent / daily * 100) : 100) + '%' } })) : null,
        h('div', { className: 'dw-muted', style: { marginTop: 4 } }, '只算家里；按 DeepSeek 官方价与峰谷时段估算。超过后提醒她一次。'),
        h('div', { className: 'dw-setting' },
          h('input', { type: 'text', inputMode: 'decimal', placeholder: '每天额度（元），留空不限', value: draft, onChange: function (e) { setDraft(e.target.value); setMsg('') } }),
          h('button', { className: 'dw-btn', onClick: save }, '保存')),
        h(Status, { msg: msg }))
    }
    /** 记忆块带最近几轮：默认 200，下次开始对话或压缩之后生效。 */
    function Memory(props) {
      var mem = props.mem, window_ = mem && mem.windowTurns || 200
      var activeScope = mem && mem.archiveScope || 'workspace'
      var scopeNames = { home: '仅家会话', workspace: '家所在工作区' }
      var scopeState = useState(mem && mem.selectedArchiveScope || activeScope), scope = scopeState[0], setScope = scopeState[1]
      var draftState = useState(String(window_)), draft = draftState[0], setDraft = draftState[1]
      var msgState = useState(''), msg = msgState[0], setMsg = msgState[1]
      function save() {
        var text = String(draft).trim(), value = text === '' ? null : Number(text)
        if (value !== null && !(Number.isInteger(value) && value >= 1)) { setMsg('请填一个不小于 1 的整数，留空恢复默认 200'); return }
        post('memory', { turns: value }).then(function () { setMsg('已保存。下次开始对话或压缩之后生效。'); if (value === null) setDraft('200'); if (props.onSaved) props.onSaved() }, failedTo(setMsg))
      }
      function saveScope() {
        post('archive-scope', { scope: scope }).then(function (result) {
          setMsg(result.restartRequired ? '已保存。请重启 DSH，启动后按新范围和消息时间重建记忆块。' : '归档范围已保存。')
          if (props.onSaved) props.onSaved()
        }, failedTo(setMsg))
      }
      return h(Card, { title: '记忆', delay: 180 }, mem ? [
        h('div', { key: 'm' }, h('span', { className: 'dw-big' }, mem.turns), h('span', { className: 'dw-muted' }, ' / ' + window_ + ' 轮')),
        h('div', { key: 'b', className: 'dw-meter' }, h('i', { style: { width: Math.min(100, Math.round((mem.turns || 0) / window_ * 100)) + '%' } })),
        h('div', { key: 'd', className: 'dw-muted' }, '约 ' + mem.approxTokens + ' token · 归档 ' + mem.records + ' 条 · 来自 ' + mem.sessions + ' 个会话'),
        h('div', { key: 'active', className: 'dw-muted' }, '当前归档：' + scopeNames[activeScope]),
        h('div', { key: 'scope', className: 'dw-setting' },
          h('select', { value: scope, 'aria-label': '记忆归档范围', onChange: function (e) { setScope(e.target.value); setMsg('') } },
            h('option', { value: 'home' }, '仅家会话'), h('option', { value: 'workspace' }, '家所在工作区')),
          h('button', { className: 'dw-btn', onClick: saveScope }, '保存范围')),
        mem.restartRequired ? h('div', { key: 'restart', className: 'dw-muted', role: 'status' }, '范围已修改，请重启 DSH。重启前继续使用当前范围。') : null,
        h('div', { key: 's', className: 'dw-setting' },
          h('input', { type: 'text', inputMode: 'numeric', 'aria-label': '记忆带最近几轮', placeholder: '最近几轮，留空为 200', value: draft, onChange: function (e) { setDraft(e.target.value); setMsg('') } }),
          h('button', { className: 'dw-btn', onClick: save }, '保存')),
        h(Status, { key: 'x', msg: msg }),
      ] : h('div', { className: 'dw-muted' }, '—'))
    }
    function WorkspacePermission(props) {
      var workspace = props.workspace, permission = workspace && workspace.defaultPermission
      var selectionState = useState({ saved: permission, draft: permission }), selection = selectionState[0], setSelection = selectionState[1]
      var msgState = useState(''), msg = msgState[0], setMsg = msgState[1]
      var busyState = useState(false), busy = busyState[0], setBusy = busyState[1]
      useEffect(function () {
        setSelection(function (current) { return current.saved === permission ? current : { saved: permission, draft: current.draft === current.saved ? permission : current.draft } })
      }, [permission])
      if (!workspace) return null
      var draft = selection.draft, selected = workspace.options.find(function (option) { return option.value === draft })
      function save() {
        setBusy(true)
        post('workspace-permission', { permission: draft }).then(function () {
          setSelection({ saved: draft, draft: draft }); setMsg('已保存。新建会话将使用所选权限。')
          if (props.onSaved) props.onSaved()
        }, failedTo(setMsg)).then(function () { setBusy(false) })
      }
      return h(Card, { title: '工作区权限' },
        h('div', { className: 'dw-muted' }, '仅用于此工作区新建的会话；已有会话保留各自的权限。'),
        h('div', { className: 'dw-setting' },
          h('select', { value: draft, disabled: busy, 'aria-label': '新建会话默认权限', onChange: function (e) { setSelection({ saved: selection.saved, draft: e.target.value }); setMsg('') } },
            workspace.options.map(function (option) { return h('option', { key: option.value, value: option.value, title: option.description }, option.name) })),
          h('button', { className: 'dw-btn', disabled: busy || draft === selection.saved || !selected, onClick: save }, busy ? '保存中…' : '保存')),
        selected && selected.description ? h('div', { className: 'dw-muted' }, selected.description) : null,
        h(Status, { msg: msg }))
    }
    /** 回顾之后是否自动应用她改过的“我是谁”：开关即存，不需要再点保存。 */
    function CompactAfterReview(props) {
      var msgState = useState(''), msg = msgState[0], setMsg = msgState[1]
      var busyState = useState(false), busy = busyState[0], setBusy = busyState[1]
      function toggle(on) {
        setBusy(true)
        post('compact-after-review', { on: on }).then(function () {
          setMsg(on ? '已开启。每晚回顾后会自动应用并压缩家会话。' : '已关闭。“我是谁”要等下一次压缩才生效。')
          if (props.onSaved) props.onSaved()
        }, failedTo(setMsg)).then(function () { setBusy(false) })
      }
      return h(Card, { title: '回顾后自动压缩' },
        h('div', { className: 'dw-muted' }, '每晚回顾结束、家空闲后，自动应用并压缩一次家会话，让她刚改写的“我是谁”生效；压缩后最近的聊天会重新放回她眼前。'),
        h('label', { className: 'dw-setting' },
          h('input', { type: 'checkbox', checked: props.on, disabled: busy, 'aria-label': '回顾后自动压缩', onChange: function (e) { toggle(e.target.checked) } }),
          ' ', props.on ? '已开启' : '已关闭'),
        h(Status, { msg: msg }))
    }
    /** 微信：适配器每约 2 秒来问一次，最近一次来问的时间就是连接状态；两个读取参数在它下次来问时同步。 */
    function Wechat(props) {
      var w = props.wechat, zone = props.zone
      var contextState = useState(String(w.contextMessages)), context = contextState[0], setContext = contextState[1]
      var bufferState = useState(String(w.bufferSeconds)), buffer = bufferState[0], setBuffer = bufferState[1]
      var msgState = useState(''), msg = msgState[0], setMsg = msgState[1]
      var age = w.lastContactAt ? Date.now() - new Date(w.lastContactAt).getTime() : null
      var contacted = age != null && age < 30000, offline = contacted && w.account === 'offline'
      var ad = w.adapter
      var blocked = ad && ad.needsHuman
      var stateText = blocked ? '● 有消息待核对，适配器已停' : !contacted ? (ad && ad.running ? '● 适配器启动中' : ad && ad.error ? '● 等待适配器文件' : w.lastContactAt ? '● 适配器已断开' : '● 等待适配器') : offline ? '● 微信离线，等待重新登录' : '● 已连接'
      var adMsgState = useState(''), adMsg = adMsgState[0], setAdMsg = adMsgState[1]
      function restartAdapter() {
        setAdMsg('正在重启…')
        post('wechat-adapter', {}).then(function () { setAdMsg('已重启'); if (props.onSaved) props.onSaved() }, function (e) { setAdMsg('重启失败：' + (e.message || e)) })
      }
      function save() {
        var c = String(context).trim() === '' ? null : Number(context), b = String(buffer).trim() === '' ? null : Number(buffer)
        if (c !== null && !(Number.isInteger(c) && c >= 1 && c <= 20)) { setMsg('请填 1–20 的整数，留空恢复默认 8'); return }
        if (b !== null && !(b >= 0 && b <= 30)) { setMsg('请填 0–30 秒，留空恢复默认 3'); return }
        post('wechat', { contextMessages: c, bufferSeconds: b }).then(function () {
          setMsg('已保存。适配器下次轮询时同步，当前这一批沿用原值。')
          if (c === null) setContext('8'); if (b === null) setBuffer('3')
          if (props.onSaved) props.onSaved()
        }, failedTo(setMsg))
      }
      return h(Card, { title: '微信', delay: 300 },
        h('div', null, h('span', { className: 'dw-big ' + (contacted && !offline ? 'dw-ok' : 'dw-bad') }, stateText)),
        KV([
          ['最近联系', w.lastContactAt ? local(w.lastContactAt, zone) : '—'],
          ['绑定账号', w.accountId || '—'],
          ad ? ['适配器', ad.running ? '由插件管理 · 运行中' + (ad.restarts ? '（已重启 ' + ad.restarts + ' 次）' : '') : '由插件管理 · 已退出' + (ad.error ? '：' + ad.error : ad.lastExit ? '（' + ad.lastExit + '），等待重启' : '')] : null,
          ['聊天', w.accountId ? w.chats + ' 个' : '—'],
          ['待发送', String(w.pending)],
          ['待核对', h('span', { className: w.uncertain ? 'dw-bad' : '' }, String(w.uncertain))],
        ]),
        w.uncertain ? h('div', { className: 'dw-muted' }, '发送结果不明的消息不会自动重发，请在微信里核对后用适配器 acknowledge 确认。') : null,
        blocked ? h('div', { className: 'dw-bad' }, '上次有消息处理到一半、结果不明。先在微信里核对是否真的发出，再用适配器的 acknowledge 确认（见适配器 README），然后点下面的重启。') : null,
        ad ? h('div', { className: 'dw-bar' }, h('button', { className: 'dw-btn', onClick: restartAdapter }, '重启适配器'), adMsg ? h('span', { className: adMsg.indexOf('失败') >= 0 ? 'dw-bad' : 'dw-muted' }, adMsg) : null) : null,
        h('div', { className: 'dw-setting' },
          h('input', { type: 'text', inputMode: 'numeric', 'aria-label': '群聊读取上文条数', placeholder: '上文条数，默认 8', value: context, onChange: function (e) { setContext(e.target.value); setMsg('') } }),
          h('input', { type: 'text', inputMode: 'decimal', 'aria-label': '图片缓冲秒数', placeholder: '缓冲秒数，默认 3', value: buffer, onChange: function (e) { setBuffer(e.target.value); setMsg('') } }),
          h('button', { className: 'dw-btn', onClick: save }, '保存')),
        h('div', { className: 'dw-muted' }, '上文按消息条数算（群聊被 @ 时带上之前几条）；缓冲是私聊图片等待后续图片或文字的秒数。与共享记忆的 200 轮无关。'),
        h(Status, { msg: msg }))
    }
    /** QQ：她自己那条 OneBot 通道（原生），以及 SnowLuma 控制台的入口。 */
    function Qq(props) {
      var busyState = useState(false), busy = busyState[0], setBusy = busyState[1]
      var msgState = useState(''), msg = msgState[0], setMsg = msgState[1]
      // 两个控制台都带 X-Frame-Options: DENY，塞不进 iframe，所以交给系统浏览器开。
      // 地址和令牌由宿主半侧现给（/dsh-world/qq/console），所以打开就是登录态。
      function openDoor(kind) {
        var label = 'SnowLuma'
        setBusy(true); setMsg('')
        qqGet('console').then(function (res) {
          var door = res && res[kind]
          // 还差密码的门也带着地址，先认这件事，别把登录页当成品打开。
          if (door && door.needs === 'password') { if (props.onNeedPassword) props.onNeedPassword(kind); return null }
          if (door && door.url) {
            return qqPost('open', { kind: kind }).then(function (r) {
              setMsg(r && r.opened ? '已在浏览器打开 ' + label + ' 控制台' : '失败：' + ((r && r.error) || '打不开'))
            })
          }
          setMsg('失败：' + ((door && door.error) || '宿主没给地址'))
          return null
        }, function (e) { setMsg('失败：' + ((e && e.message) || e)) }).then(function () { setBusy(false) })
      }
      /** 改通道的开关：一次给的几项一起生效；`done` 拿到通道的新状态，说一句结果。 */
      function change(body, done) {
        setBusy(true); setMsg('')
        qqPost('native', body).then(function (state) {
          setMsg(done ? done(state) : '')
          if (props.onSaved) props.onSaved()
        }, function (e) { setMsg('失败：' + ((e && e.message) || e)) }).then(function () { setBusy(false) })
      }
      // 阳台：拨端口就是开关（0 是关）。
      function flipBridge(port) { change({ bridge: { port: port } }) }
      function flipNative(autoReply) { change({ autoReply: autoReply }) }
      // 静默：给一个时间点，到点前只收不回，到点自己醒；null 立刻恢复。
      var muteState = useState(''), muteAt = muteState[0], setMuteAt = muteState[1]
      function muteUntil(local) {
        var at = new Date(local)
        if (isNaN(at.getTime())) { setMsg('这个时间看不懂，重挑一下'); return }
        change({ mutedUntil: at.toISOString() })
      }
      // 合批窗口：同一个人在这么多秒内连发几句，合成一次问。填 0 就是每句单独回。
      var quietState = useState(''), quiet = quietState[0], setQuiet = quietState[1]
      useEffect(function () {
        var ms = props.native && typeof props.native.batchQuietMs === 'number' ? String(Math.round(props.native.batchQuietMs / 1000)) : ''
        setQuiet(function (cur) { return cur === '' ? ms : cur })
      }, [props.native && props.native.batchQuietMs])
      function saveQuiet() {
        var sec = Number(String(quiet).trim())
        if (!isFinite(sec) || sec < 0 || sec > 120) { setMsg('填 0 到 120 之间的秒数'); return }
        change({ batchQuietMs: Math.round(sec * 1000) })
      }
      // 白名单：谁的话能进来。打开时填上现有的名单，之后不覆盖正在改的字。
      var ids = props.native ? [(props.native.allowPrivateIds || []).join(', '), (props.native.allowGroupsIds || []).join(', ')] : ['', '']
      var allowState = useState({ from: '', people: '', groups: '' }), allow = allowState[0], setAllow = allowState[1]
      useEffect(function () {
        var from = ids.join('|')
        setAllow(function (current) { return current.from === from ? current : { from: from, people: ids[0], groups: ids[1] } })
      }, [ids[0], ids[1]])
      function saveAllow() {
        function split(text) { return String(text).split(/[\s,，、;；]+/).filter(Boolean) }
        var people = split(allow.people), groups = split(allow.groups), wrong = people.concat(groups).find(function (id) { return !/^[0-9]+$/.test(id) })
        if (wrong) { setMsg('请填 QQ 号：「' + wrong + '」不是号码'); return }
        change({ allowPrivate: people, allowGroups: groups }, function () { return people.length || groups.length ? '名单存好了：私聊 ' + people.length + ' 个、群 ' + groups.length + ' 个' : '名单存好了：现在谁的话都不收' })
      }
      function startSnowluma() {
        change({ startSnowluma: true }, function (state) {
          var r = state && state.launch
          if (!r || !r.started) return '没起来：' + ((r && r.error) || '原因不明')
          return '已经让 SnowLuma 起来' + (r.how === 'spawn' ? '（直接起的，这条线只活到 DSH 退出）' : '') + (r.error ? '；' + r.error : '')
        })
      }
      function copyLine(text) {
        if (!text) { setMsg('这条命令还没生出来'); return }
        if (!navigator.clipboard) { setMsg('这个浏览器不给复制，自己选上面那行'); return }
        navigator.clipboard.writeText(text).then(function () { setMsg('命令已复制') }, function () { setMsg('复制失败，自己选上面那行') })
      }
      return h(Card, { title: 'QQ', delay: 240 }, [
        props.native ? (function (n) {
          if (!n) return h('div', { key: 'n', className: 'dw-muted' }, '她自己的通道：没开')
          return h('div', { key: 'n' }, [
            h('span', { key: 'a', className: n.connected ? 'dw-ok' : 'dw-muted' }, n.connected ? '● 她自己连着 ' + n.url : '● 她自己的通道没连上'),
            h('span', { key: 'b', className: 'dw-muted' }, ' · 收 ' + (n.conversations || 0) + ' 个会话 · 发 ' + (n.sent || 0) + ' 条' + (n.failed ? ' · 失败 ' + n.failed : '') + (n.outbox ? ' · 排队待发 ' + n.outbox : '') + (n.blocked ? ' · 挡下 ' + n.blocked : '') + (n.autoReply ? ' · 会自己回' : ' · 只看不回')),
            n.lastError ? h('span', { key: 'c', className: 'dw-bad' }, ' · ' + n.lastError) : null,
          ])
        })(props.native) : h('div', { key: 'n', className: 'dw-muted' }, '她自己的通道：没开（配置里 qqNative.enabled）'),
        (function (n) {
          if (!n) return null
          return h('label', { key: 'nt', className: 'dw-setting', style: { cursor: 'pointer' } }, [
            h('input', { key: 'c', type: 'checkbox', checked: n.autoReply === true, disabled: busy,
              onChange: function (e) { flipNative(e.target.checked) } }),
            h('span', { key: 't' }, n.autoReply === true ? ' 会自己回话' : ' 只看不回'),
          ])
        })(props.native),
        (function (n) {
          if (!n) return null
          var ms = typeof n.batchQuietMs === 'number' ? n.batchQuietMs : 10000
          return h('div', { key: 'quiet', className: 'dw-setting' }, [
            h('span', { key: 's', className: 'dw-muted' }, ms ? '连着发几句：' + (ms / 1000) + ' 秒内合成一次问' : '连着发几句：每句单独回'),
            h('input', { key: 'i', type: 'number', min: 0, max: 120, step: 1, 'aria-label': '合批窗口（秒）', style: { width: 64 }, disabled: busy, value: quiet, onChange: function (e) { setQuiet(e.target.value) } }),
            h('button', { key: 'b', className: 'dw-btn', disabled: busy, onClick: saveQuiet }, '存'),
          ])
        })(props.native),
        (function (n) {
          if (!n) return null
          return h('div', { key: 'mute', className: 'dw-setting' }, [
            h('span', { key: 's', className: n.mutedUntil ? 'dw-bad' : 'dw-muted' }, n.mutedUntil ? '静默到 ' + new Date(n.mutedUntil).toLocaleString() + '（只收不回）' : '现在会出声'),
            h('input', { key: 'i', type: 'datetime-local', 'aria-label': '静默到', disabled: busy, value: muteAt, onChange: function (e) { setMuteAt(e.target.value) } }),
            h('button', { key: 'b', className: 'dw-btn', disabled: busy || !muteAt, onClick: function () { muteUntil(muteAt) } }, '静默到这个点'),
            n.mutedUntil ? h('button', { key: 'r', className: 'dw-btn', disabled: busy, onClick: function () { change({ mutedUntil: null }) } }, '立刻恢复') : null,
          ])
        })(props.native),
        props.native ? h('div', { key: 'allow', className: 'dw-setting' }, [
          h('input', { key: 'p', type: 'text', 'aria-label': '私聊白名单', placeholder: '私聊 QQ 号', disabled: busy, value: allow.people, onChange: function (e) { setAllow({ from: allow.from, people: e.target.value, groups: allow.groups }) } }),
          h('input', { key: 'g', type: 'text', 'aria-label': '群白名单', placeholder: '群号', disabled: busy, value: allow.groups, onChange: function (e) { setAllow({ from: allow.from, people: allow.people, groups: e.target.value }) } }),
          h('button', { key: 'b', className: 'dw-btn', disabled: busy, onClick: saveAllow }, '存名单'),
          h('div', { key: 'h', className: 'dw-muted', style: { width: '100%' } }, '多个用逗号隔开；留空就是谁的话都不收。改完不用重启。'),
        ]) : null,
        (function (n) {
          if (!n) return null
          var b = n.bridge
          if (!b) return h('div', { key: 'nb', className: 'dw-setting' }, [
            h('span', { key: 's', className: 'dw-muted' }, '阳台：关着（要用就在这儿打开）'),
            h('button', { key: 'b', className: 'dw-btn', disabled: busy, onClick: function () { flipBridge(3210) } }, '开这条线（3210）'),
          ])
          return h('div', { key: 'nb' }, [
            h('div', { key: 'l', className: 'dw-muted' },
              h('span', { className: b.serving ? 'dw-ok' : 'dw-muted' }, b.serving ? '● 阳台开着 ' + (b.url || '') : '● 阳台关着'),
              ' · ' + ((b.lines || 0) ? '连着 ' + b.lines + ' 条线' : '还没人敲门')
                + ' · 收了 ' + (b.received || 0) + ' 句、回了 ' + (b.relayed || 0) + ' 句、她开口 ' + (b.spoken || 0) + ' 次'),
            b.lastError ? h('div', { key: 'e', className: 'dw-bad' }, ' · ' + b.lastError) : null,
            h('div', { key: 'c', className: 'dw-muted', style: { wordBreak: 'break-all', fontSize: 12 } }, b.line || ''),
            h('div', { key: 'y', className: 'dw-setting' }, [
              h('button', { key: 'c', className: 'dw-btn', disabled: busy, onClick: function () { copyLine(b.line) } }, '复制这条命令'),
              h('button', { key: 'x', className: 'dw-btn', disabled: busy, onClick: function () { flipBridge(0) } }, '关掉这条线'),
            ]),
          ])
        })(props.native),
        (function (sv) {
          if (!sv) return null
          return h('div', { key: 'sv', className: sv.lastError ? 'dw-bad' : 'dw-muted' },
            (sv.watching ? '● 看门狗盯着' : '○ 看门狗没开') + (sv.lastCheckAt ? ' · SnowLuma ' + (sv.alive ? '通着' : '不通') : '')
              + (sv.restarts ? ' · 已拉起 ' + sv.restarts + ' 次' : '') + (sv.lastError ? ' · ' + sv.lastError : ''))
        })(props.native && props.native.supervisor),
        h('div', { key: 'k', className: 'dw-setting' },
          h('button', { className: 'dw-btn', disabled: busy, onClick: function () { openDoor('snowluma') } }, '打开 SnowLuma 控制台'),
          props.native ? h('button', { className: 'dw-btn', disabled: busy, onClick: startSnowluma }, '拉起 SnowLuma') : null),
        h('div', { key: 'b', className: 'dw-setting' },
          h('button', { className: 'dw-btn', disabled: busy, onClick: function () { if (props.onSaved) props.onSaved() } }, '刷新')),
        h(Status, { key: 'x', msg: msg }),
      ])
    }
    /**
     * 第一次打开 SnowLuma 控制台时，得先用面板密码换一个会话令牌：那令牌只活在那边的进程内存里，重启就没了。
     * 密码不在浏览器里存着，填完就交给宿主半侧，换到令牌后由宿主把系统浏览器拉起来。
     * 两个控制台都发 X-Frame-Options: DENY，塞不进 iframe，所以只能这样开。
     */
    function Panel(props) {
      var passState = useState(''), pass = passState[0], setPass = passState[1]
      var busyState = useState(false), busy = busyState[0], setBusy = busyState[1]
      var errState = useState(''), err = errState[0], setErr = errState[1]
      function signIn() {
        if (!pass) { setErr('先填密码'); return }
        setBusy(true); setErr('')
        qqPost('panel-password', { password: pass }).then(function (body) {
          var next = body && body.snowluma
          if (!next || !next.url) { setErr((next && next.error) || '登录失败'); return null }
          setPass('')
          return qqPost('open', { kind: 'snowluma' }).then(function (r) {
            if (r && r.opened) { if (props.onClose) props.onClose() } else setErr((r && r.error) || '打不开浏览器')
          })
        }, function (e) { setErr(String((e && e.message) || e)) }).then(function () { setBusy(false) })
      }
      return h('div', { style: { position: 'fixed', left: 0, top: 0, width: '100%', height: '100%', zIndex: 60, background: 'rgba(10,14,20,.66)', display: 'flex', alignItems: 'center', justifyContent: 'center' } },
        h('div', { style: { width: 480, maxWidth: '92%', background: '#141b25', border: '1px solid rgba(255,255,255,.1)', borderRadius: 12, padding: 20, boxSizing: 'border-box' } },
          h('h3', { style: { margin: '0 0 8px', color: '#e8edf4' } }, '第一次打开 SnowLuma 控制台'),
          h('div', { className: 'dw-muted', style: { marginBottom: 16, lineHeight: 1.6 } }, '它只认密码、没有账号名这回事；会话令牌只存在进程内存里，过期就没了，所以要用面板密码换一次。密码留在你这台机器上，不会回传浏览器。'),
          h('label', { style: { display: 'block', marginBottom: 16, color: '#c7d2de' } }, '密码 ',
            h('input', { type: 'password', value: pass, onChange: function (e) { setPass(e.target.value) }, onKeyDown: function (e) { if (e.key === 'Enter') signIn() }, style: { width: 220 } })),
          err ? h('div', { className: 'dw-bad', style: { marginBottom: 12 } }, '● ' + err) : null,
          h('button', { className: 'dw-btn', disabled: busy, onClick: signIn }, busy ? '……' : '登录并打开'),
          h('button', { className: 'dw-btn', style: { marginLeft: 10 }, onClick: function () { if (props.onClose) props.onClose() } }, '取消')))
    }
    /** 接入：微信和 QQ 各一个开关，关闭即撤下通道，状态记在 world.json。 */
    function Modules(props) {
      var m = props.modules
      var msgState = useState(''), msg = msgState[0], setMsg = msgState[1]
      var busyState = useState(''), busy = busyState[0], setBusy = busyState[1]
      function flip(name, value) {
        var body = {}; body[name] = value
        setBusy(name); setMsg('')
        post('modules', body).then(function (result) { setBusy(''); if (result.message) setMsg(result.message); if (props.onSaved) props.onSaved() }, function (e) { setBusy(''); setMsg('切换失败：' + (e.message || e)) })
      }
      function row(name, label, info, onText, offText) {
        var state = busy === name ? (name === 'qq' ? '正在检查或安装 SDK…' : '切换中…') : !info.available ? '未配置' : info.restartRequired ? 'SDK 已安装，请重启 DSH' : !info.enabled ? '已关闭' : info.running ? '运行中' : props.running ? '启动中' : '已开启，世界启动后生效'
        return h('div', { key: name, className: 'dw-setting' },
          h('span', null, h('b', null, label), h('span', { className: 'dw-muted' }, ' · ' + state)),
          h('button', { className: 'dw-btn', disabled: !info.available || busy === name, onClick: function () { flip(name, !info.enabled) } }, info.enabled ? '关闭' : '开启'),
          h('div', { className: 'dw-muted', style: { flexBasis: '100%' } }, info.enabled ? onText : offText))
      }
      return h(Card, { title: '接入', delay: 270 },
        row('wechat', '微信', m.wechat, '已注册 wechat_chats、wechat_history、wechat_send、wechat_delivery，可先看群聊再发言，并随之启动适配器。关闭会撤掉它们并停掉适配器。', '工具未注册，适配器已停。开启后立即注册，无需重启。'),
        row('qq', 'QQ', m.qq, '插件自己直连 OneBot：状态和设置在 QQ 页面。关闭就断开这条通道。', '开启时检查 SDK；缺少时按需安装并提示重启 DSH。'),
        msg ? h('div', { className: msg.indexOf('失败') >= 0 ? 'dw-bad' : 'dw-muted', role: 'status' }, msg) : null)
    }
    function Overview(props) {
      var snap = props.snap, zone = snap.timeZone, life = snap.life, alarm = life && life.alarm, mem = snap.memory
      var health = list(snap.health), wakes = life ? list(life.recentWakes) : []
      var welcome = !snap.running && !life
      return h('div', { className: 'dw-pane' },
        welcome ? h(Card, null, h('div', { className: 'dw-welcome' },
          h('h3', null, '她还没有住进来'),
          h('div', { className: 'dw-muted' }, '先写下她是谁，再按右上角的「开始」。'),
          h('ol', { className: 'dw-steps' },
            h('li', null, '在「人设」里写她的名字、性格和你对她的愿景'),
            h('li', null, '需要的话，在「世界提示词」里写你想对她说的话'),
            h('li', null, '按「开始」：插件建好她的房间和家，叫醒她')))) : null,
        life ? h('div', { className: 'dw-grid' },
          h(Card, { title: '此刻', delay: 0 },
            h('div', { className: 'dw-big' }, statusLabel[life.status] || life.status),
            alarm ? h('div', { style: { marginTop: 8 } }, h('span', { className: 'dw-muted' }, (sourceLabel[alarm.source] || '闹钟') + ' · '), local(alarm.at, zone), h('span', { className: 'dw-muted' }, '（还有 ' + remaining(alarm.at) + '）')) : h('div', { className: 'dw-muted' }, '没有待定的闹钟'),
            alarm && alarm.note ? h('blockquote', { className: 'dw-quote' }, alarm.note) : null),
          h(Card, { title: '家', delay: 60 }, KV([
            ['会话', String(life.homeSessionId || '还没有家').replace(/^session-/, '').slice(0, 8)],
            ['下次回顾', life.review ? local(life.review.at, zone) : '—'],
            ['最近', wakes.length ? h('div', { className: 'dw-trail' }, wakes.map(function (w, i) { return h('span', { key: i }, local(w.deliveredAt, zone) + ' ' + (sourceLabel[w.source] || w.source) + (w.lateMs >= 120000 ? ' · 晚 ' + Math.round(w.lateMs / 60000) + ' 分' : '')) })) : '—'],
          ]))) : null,
        h('div', { className: 'dw-grid' },
          h(Card, { title: '健康', delay: 120 }, health.length ? health.map(function (f, i) { return h('div', { key: i, className: 'dw-bad' }, '● ' + f) }) : h('div', { className: 'dw-ok' }, '● 一切正常')),
          h(Memory, { mem: mem, onSaved: props.refresh }),
          h(Budget, { budget: snap.budget, onSaved: props.refresh }),
          snap.workspace ? h(WorkspacePermission, { workspace: snap.workspace, onSaved: props.refresh }) : null,
          typeof snap.compactAfterReview === 'boolean' ? h(CompactAfterReview, { on: snap.compactAfterReview, onSaved: props.refresh }) : null,
          snap.modules && (snap.modules.wechat.available || snap.modules.qq.available) ? h(Modules, { modules: snap.modules, running: snap.running, onSaved: props.refresh }) : null))
    }
    function Records(props) {
      var snap = props.snap, zone = snap.timeZone, life = snap.life, compactions = list(snap.compactions)
      return h('div', { className: 'dw-pane' },
        h(Activity, { days: list(snap.activityDays), zone: zone, tick: props.tick }),
        h(Diary, { dates: list(snap.diaryDates) }),
        h(Card, { title: '压缩' }, compactions.length ? h('table', null, h('tbody', null, compactions.map(function (c, i) {
          return h('tr', { key: i }, h('td', { className: 'dw-muted' }, local(c.time, zone)), h('td', null, life && c.sessionId === life.homeSessionId ? '家' : String(c.sessionId || '').slice(-8)), h('td', { className: c.ok ? 'dw-ok' : 'dw-bad' }, c.ok ? '成功' : '失败：' + (c.error || '')), h('td', { className: 'dw-muted' }, c.shadowedTokens ? '缩掉约 ' + c.shadowedTokens + ' token' : ''))
        }))) : h('div', { className: 'dw-muted' }, '还没有压缩记录')))
    }

    var TABS = [['overview', '概览'], ['persona', '人设'], ['prompt', '世界提示词'], ['records', '记录'], ['photos', '相册'], ['qq', 'QQ'], ['wechat', '微信']]
    /** 一份快照的画面；life 为 null（停着，或生活线没能启动）或缺了哪一块都不会崩。 */
    function View(props) {
      var snap = props.snap, error = props.error
      var tabState = useState('overview'), tab = tabState[0], setTab = tabState[1]
      var panelState = useState(null), panel = panelState[0], setPanel = panelState[1]
      var busyState = useState(false), busy = busyState[0], setBusy = busyState[1]
      var failState = useState(null), fail = failState[0], setFail = failState[1]
      var running = snap.running === true
      var name = snap.name && snap.name !== 'TA' ? snap.name : ''
      function power() {
        if (running && !window.confirm('停止后，她不会再被叫醒，记忆块、人设和世界提示词都会撤下，这段时间的对话也不记。要停止吗？')) return
        setBusy(true); setFail(null)
        post(running ? 'stop' : 'start').then(function () { props.refresh() }, function (e) { setFail(String(e.message || e)) }).then(function () { setBusy(false) })
      }
      return h('div', { className: 'dw' },
        h('header', { className: 'dw-head' + (running ? ' dw-on' : '') },
          h('div', { className: 'dw-title' },
            h('small', null, 'world · ' + snap.worldId),
            h('h2', null, (name || '她') + '的世界'),
            h('div', { className: 'dw-state' }, h('i', { className: 'dw-dot' }), running ? '运行中' : '已停止', ' · ', local(snap.now, snap.timeZone),
              error ? h('span', { className: 'dw-bad' }, ' · 刷新失败：' + error) : null,
              fail ? h('span', { className: 'dw-bad' }, ' · ' + fail) : null)),
          h('button', { className: 'dw-power' + (running ? ' stop' : ''), disabled: busy, onClick: power }, busy ? '……' : running ? '停止' : '开始')),
        h('nav', { className: 'dw-tabs' }, TABS.map(function (t) { return h('button', { key: t[0], className: 'dw-tab' + (tab === t[0] ? ' on' : ''), onClick: function () { setTab(t[0]) } }, t[1]) })),
        tab === 'persona' || tab === 'prompt' ? h('div', { className: 'dw-pane' },
          h(HomeApply, { snap: snap, refresh: props.refresh }),
          tab === 'persona' ? h(PersonaEditor, { onSaved: props.refresh }) : h(PromptEditor)) : null,
        tab === 'overview' ? h(Overview, { snap: snap, refresh: props.refresh }) : null,
        tab === 'records' ? h(Records, { snap: snap, tick: props.tick }) : null,
        tab === 'photos' ? h(PhotoAlbum, { tick: props.tick, zone: snap.timeZone }) : null,
        tab === 'qq' ? h('div', { className: 'dw-pane' }, snap.native
          ? h(Qq, { native: snap.native, onSaved: props.refresh, onNeedPassword: setPanel })
          : h(Card, { title: 'QQ' }, h('div', { className: 'dw-muted' }, 'QQ 通道未开启，请在概览的「接入」中检查配置和开关。'))) : null,
        tab === 'wechat' ? h('div', { className: 'dw-pane' }, snap.wechat
          ? h(Wechat, { wechat: snap.wechat, zone: snap.timeZone, onSaved: props.refresh })
          : h(Card, { title: '微信' }, h('div', { className: 'dw-muted' }, '微信通道未开启，请在概览的「接入」中检查配置和开关。'))) : null,
          panel ? h(Panel, { kind: panel, onClose: function () { setPanel(null) } }) : null)
    }

    function Console() {
      var snapState = useState(null), snap = snapState[0], setSnap = snapState[1]
      var errorState = useState(null), error = errorState[0], setError = errorState[1]
      var offState = useState(false), off = offState[0], setOff = offState[1]
      var tickState = useState(0), tick = tickState[0], setTick = tickState[1]
      var loadRef = useRef(null)
      useEffect(function () {
        ensureStyle()
        var alive = true, pending = false, timer = null
        function load() {
          if (!alive || pending) return
          pending = true
          loadSnapshot().then(function (s) {
            pending = false
            if (!alive) return
            if (s === null) { setOff(true); if (timer) { clearInterval(timer); timer = null } return }
            setSnap(s); setError(null); setTick(function (t) { return t + 1 })
          }, function (e) {
            pending = false
            if (alive) setError(String((e && e.message) || e))
          })
        }
        function onVisible() { if (document.visibilityState === 'visible') load() }
        loadRef.current = load
        load()
        timer = setInterval(onVisible, 10000)
        document.addEventListener('visibilitychange', onVisible)
        return function () { alive = false; loadRef.current = null; if (timer) clearInterval(timer); document.removeEventListener('visibilitychange', onVisible) }
      }, [])
      if (off) return h('div', { className: 'dw' }, h('div', { className: 'dw-muted' }, '世界控制台需要桌面版宿主'))
      if (!snap) return h('div', { className: 'dw' }, error ? h('div', { className: 'dw-bad' }, '读取失败：' + error) : h('div', { className: 'dw-muted' }, '读取中…'))
      return h(View, { snap: snap, error: error, tick: tick, refresh: function () { if (loadRef.current) loadRef.current() } })
    }

    var exports = { inject: ['slots'] }
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    exports.apply = function (ctx) {
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({ name: 'settings.section', id: 'world-console', order: 28, label: '世界控制台' }, function () { return h(Console) })
      })
    }
    Object.defineProperty(exports, '__test', { value: { WorkspacePermission: WorkspacePermission, CompactAfterReview: CompactAfterReview, Modules: Modules, HomeApply: HomeApply, PhotoAlbum: PhotoAlbum, Wechat: Wechat, Activity: Activity, Diary: Diary, Qq: Qq, Panel: Panel, View: View, Overview: Overview, PersonaEditor: PersonaEditor, PromptEditor: PromptEditor, loadSnapshot: loadSnapshot, renderPersona: renderPersona }, enumerable: false })
    return exports
  },
})
