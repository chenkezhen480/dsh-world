/**
 * dsh-world — 浏览器半侧：设置里的「世界控制台」。
 * 模块 id 必须等于 bundle 行名 dsh-world；数据来自当前世界的路由。
 * 读取是 GET；会改变东西的（开始、停止、人设、世界提示词、额度、记忆轮数）是带 x-dsh-world 头的 JSON POST。
 */
;(function () {
  var worldsPath = '/dsh-world/worlds'

  function worldConsole(react, worldId) {
    var prefix = worldsPath + '/' + encodeURIComponent(worldId)
    var h = react.createElement
    var useState = react.useState
    var useEffect = react.useEffect
    var useRef = react.useRef

    function settle(r) {
      return r.json().then(function (body) { return { body: body } }, function () { return null }).then(function (parsed) {
        var body = parsed && parsed.body
        if (!r.ok) { var err = new Error((body && body.error) || ('HTTP ' + r.status)); err.status = r.status; if (body && body.code) err.code = body.code; throw err }
        if (!parsed) { var bad = new Error('回复不是 JSON'); bad.notJson = true; throw bad }
        return body
      })
    }
    function getFrom(base, path) { return fetch(base + path, { cache: 'no-store' }).then(settle) }
    function postTo(base, path, body) {
      return fetch(base + path, { method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json', 'x-dsh-world': '1' }, body: JSON.stringify(body || {}) }).then(settle)
    }
    function api(path) { return getFrom(prefix + '/console/', path) }
    function post(path, body) { return postTo(prefix + '/console/', path, body) }
    /** QQ 那几扇门在自己的前缀下（…/qq/*），不和 console 混在一起。 */
    function qqGet(path) { return getFrom(prefix + '/qq/', path) }
    function qqPost(path, body) { return postTo(prefix + '/qq/', path, body) }
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
      '.dw-turns{margin-top:10px;font-size:12px;font-variant-numeric:tabular-nums}.dw-turns-head{font-size:11px;letter-spacing:.04em;margin-bottom:2px}',
      '.dw-turn{padding:6px 0;border-top:1px solid var(--line)}.dw-turn-top{display:flex;flex-wrap:wrap;gap:4px 10px;align-items:baseline}.dw-turn-top b{font-weight:600}',
      '.dw-turn-what{margin-top:2px;overflow-wrap:anywhere}.dw-turn-tools{font-size:11px;overflow-wrap:anywhere}.dw-turns .dw-miss{color:var(--warn)}',
      '.dw-head{flex-wrap:wrap}.dw-acts{display:flex;align-items:center;gap:10px}',
      '.dw-ghost{font:500 12px var(--serif);letter-spacing:.14em;padding:8px 16px;border-radius:999px;cursor:pointer;border:1px solid var(--line);background:transparent;color:var(--soft);transition:border-color .2s,color .2s}',
      '.dw-ghost:hover,.dw-ghost.on{border-color:var(--gold);color:var(--ink)}',
      '.dw-seg{display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden}.dw-seg button{font:inherit;border:0;border-left:1px solid var(--line);background:transparent;color:inherit;padding:6px 14px;cursor:pointer;transition:background .2s}',
      '.dw-seg button:first-child{border-left:0}.dw-seg button:hover{background:var(--glow)}.dw-seg button.on{background:var(--gold);color:#fffaf0}.dw-seg button:disabled{opacity:.45;cursor:default}',
      '.dw-newworld{flex-basis:100%;display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:2px;padding-top:14px;border-top:1px dashed var(--line);animation:dw-rise .3s both}',
      '.dw-newworld input[type=text]{flex:1 1 160px;max-width:230px;min-width:0}.dw-newworld .dw-hint{flex-basis:100%;font-size:12px;color:var(--soft)}.dw-newworld .dw-btn{padding-top:9px;padding-bottom:9px}',
      '.dw-tabs{display:flex;flex-wrap:wrap;gap:4px;border-bottom:1px solid var(--line);padding:0 6px}',
      '.dw-tab{position:relative;font:500 13px var(--serif);letter-spacing:.12em;padding:8px 14px 10px;background:none;border:0;color:var(--soft);cursor:pointer}',
      '.dw-tab:after{content:"";position:absolute;left:50%;right:50%;bottom:-1px;height:2px;background:var(--gold);transition:left .25s,right .25s}',
      '.dw-tab.on{color:var(--ink)}.dw-tab.on:after{left:12px;right:12px}',
      '.dw-pane{display:flex;flex-direction:column;gap:14px}',
      '.dw-room{width:100%;aspect-ratio:3/2;border:1px solid var(--line);border-radius:10px;background:#F7EEE2}',
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
      '.dw-hit{padding:10px 0;border-top:1px solid var(--line);min-width:0}.dw-hit .dw-diary{max-height:320px;overflow:auto}',
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
              open === photo.id ? h('img', { src: prefix + '/console/photo?id=' + encodeURIComponent(photo.id), alt: photo.description || '收藏的照片', style: { display: 'block', width: '100%', maxHeight: 480, objectFit: 'contain' }, onError: function () { setError('照片读取失败，请刷新后重试。') } }) : null)
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
    /** 她自己的模板和插件自带的差在哪：只提醒，不往她读到的东西里加；每条附上自带那一段的原文，想要就自己贴过去。 */
    function TemplateGaps(props) {
      var gaps = list(props.gaps)
      return h(Card, { title: props.title, delay: 60 },
        props.error ? h('div', { className: 'dw-bad' }, props.error)
          : !gaps.length ? h('div', { className: 'dw-muted' }, '和插件自带的没有差距。')
            : [h('div', { key: 'note', className: 'dw-muted' }, props.note)].concat(gaps.map(function (gap) {
              var id = props.kind + ':' + gap.heading
              return h('div', { key: gap.heading, style: { marginTop: 10 } },
                props.onPick ? h('input', { type: 'checkbox', 'aria-label': '交给她融「' + gap.heading + '」', checked: props.picked(id), onChange: function (e) { props.onPick(id, e.target.checked) } }) : null,
                h('b', null, '「' + gap.heading + '」'),
                h('span', { className: 'dw-muted' }, gap.missing ? ' 自带的用到了 ' + gap.missing.map(function (name) { return '{{' + name + '}}' }).join('、') + '，你的没有'
                  : gap.renamed ? ' 改了名，你的还叫「' + gap.renamed.from + '」：' + gap.renamed.note : ' 自带有这一段，你的没有'),
                h('pre', { className: 'dw-diary' }, gap.text))
            })))
    }
    var MERGE_STATUS = { waiting: '等她手上这一轮做完就交给她…', merging: '她在融…' }
    var CHANGE_KIND = { added: '新加', changed: '改了', removed: '删了' }
    /**
     * 交给她融：勾上的差距发到家里，她按你的写法融进模板；插件事先留底稿，事后只查格式，读不通就换回去。
     * 融完列出她改了哪几处，可以一键撤销（换回底稿）。
     */
    function PromptMerge(props) {
      var m = props.merge || { status: 'idle' }, ids = props.ids, chosen = ids.filter(props.picked)
      var busy = m.status === 'waiting' || m.status === 'merging'
      var msgState = useState(''), msg = msgState[0], setMsg = msgState[1]
      function ask() {
        setMsg('')
        post('prompt-merge', { items: chosen }).then(function () { if (props.onSent) props.onSent() }, failedTo(setMsg))
      }
      function undo() {
        if (!window.confirm('把两份模板和她的「我」换回融合之前的样子？融合之后再改过的也会一起没了。')) return
        post('prompt-merge/undo', {}).then(function () { if (props.onSent) props.onSent() }, failedTo(setMsg))
      }
      return h(Card, { title: '交给她融', delay: 90 },
        h('div', { className: 'dw-muted' }, '把上面勾上的几处交给她：她读你的模板，按你的写法融进去，然后自动压缩家会话。改之前插件把两份模板和她的「我」各留一份底稿（她要是跟着改名去改「我」里的小标题，也在底稿里）；改完只检查模板的格式（开关成对、没有不认识的变量），读不通就都换回去。内容由她来写，「大事先问」这类规矩她也能改到，改完请看一眼下面列出的改动。'),
        h('div', { className: 'dw-bar' },
          h('button', { className: 'dw-btn primary', disabled: busy || !chosen.length || !props.running, onClick: ask }, '交给她融进去（' + chosen.length + ' 处）'),
          m.undoable && !busy ? h('button', { className: 'dw-btn', onClick: undo }, '撤销这次融合') : null,
          h('span', { className: m.status === 'failed' || msg ? 'dw-bad' : 'dw-muted' }, msg || (!props.running ? '世界开始后才能交给她。' : MERGE_STATUS[m.status] || m.message || ''))),
        list(m.changes).map(function (file) {
          return h('div', { key: file.file, style: { marginTop: 8 } }, h('b', null, file.file),
            list(file.sections).map(function (change, i) {
              return h('details', { key: i }, h('summary', null, (CHANGE_KIND[change.kind] || change.kind) + '「' + change.heading + '」'),
                change.before != null ? h('pre', { className: 'dw-diary' }, '原来：\n' + change.before) : null,
                change.after != null ? h('pre', { className: 'dw-diary' }, '现在：\n' + change.after) : null)
            }))
        }))
    }
    /** 世界提示词模板：自己的一份，或插件自带的；自己的那份和 alarm.md 各和自带的对照一下，差的可以交给她融。 */
    function PromptEditor(props) {
      var state = useState(null), prompt = state[0], setPrompt = state[1]
      var alarmState = useState(null), alarm = alarmState[0], setAlarm = alarmState[1]
      var textState = useState(''), text = textState[0], setText = textState[1]
      var msgState = useState(''), msg = msgState[0], setMsg = msgState[1]
      // 没勾掉的都算勾上：默认把差的都交给她，故意删掉的那段自己去掉勾。
      var offState = useState({}), off = offState[0], setOff = offState[1]
      function load() { api('prompts').then(function (b) { setPrompt(b.worldPrompt); setAlarm(b.alarm || null); setText(b.worldPrompt.text) }, function (e) { setMsg('读取失败：' + (e.message || e)) }) }
      useEffect(load, [])
      // 她融完、撤销完，模板变了，对照要重新算。
      var mergeStatus = props.merge && props.merge.status, seenStatus = useRef(mergeStatus)
      useEffect(function () {
        if (seenStatus.current === mergeStatus) return
        seenStatus.current = mergeStatus
        if (mergeStatus === 'done' || mergeStatus === 'idle' || mergeStatus === 'failed') load()
      }, [mergeStatus])
      if (!prompt) return h('div', { className: 'dw-muted' }, msg || '读取中…')
      function save(value, done) {
        post('world-prompt', { text: value }).then(function () { setMsg(done); load() }, failedTo(setMsg))
      }
      var picked = function (id) { return !off[id] }
      var pick = function (id, on) { var next = Object.assign({}, off); next[id] = !on; setOff(next) }
      var ids = (prompt.custom ? list(prompt.gaps).map(function (gap) { return 'world:' + gap.heading }) : [])
        .concat(alarm && alarm.custom ? list(alarm.gaps).map(function (gap) { return 'alarm:' + gap.heading }) : [])
      var merge = props.merge || {}
      return h('div', { className: 'dw-pane' },
        h(Card, { title: '世界提示词' },
          h('div', { style: { marginBottom: 8 } }, h('span', { className: 'dw-chip' }, prompt.custom ? '你自己的一份' : '插件自带'), ' ',
            h('span', { className: 'dw-muted' }, '可用 {{name}} {{partner}} {{homeTitle}} {{roomDir}} {{diaryDir}} {{wikiDir}} {{selfFile}} {{self}} 和 {{#home}}…{{/home}} 等，见 README')),
          h('textarea', { className: 'dw-code', value: text, onChange: function (e) { setText(e.target.value); setMsg('') } })),
        prompt.custom ? h(TemplateGaps, { title: '和插件自带的世界提示词对照', kind: 'world', gaps: prompt.gaps, picked: picked, onPick: pick, note: '按标题对照：下面这几段自带的有、你的这份没有（改过标题的也算在这里）。她读不到这几段，工具照样能用。插件不会自己改你的模板：可以自己贴进去，也可以勾上交给她融。' }) : null,
        alarm && alarm.custom ? h(TemplateGaps, { title: '你的 alarm.md 和自带的对照', kind: 'alarm', gaps: alarm.gaps, error: alarm.error, picked: picked, onPick: pick, note: '你自己写过的这几段，没用到自带那段里的变量，多半是写完以后插件才加的能力。没写的段落本来就用自带的，不算差距。插件不会自己改你的 alarm.md：可以照自带的那段自己改，也可以勾上交给她融。' }) : null,
        ids.length || list(merge.changes).length || merge.undoable ? h(PromptMerge, { merge: props.merge, running: props.running, ids: ids, picked: picked, onSent: props.refresh }) : null,
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
        h('div', { className: 'dw-muted' }, '先保存人设和世界提示词，再提交。等家空闲后压缩一次，换上保存的内容；压缩会调用模型并重建上下文缓存。'),
        h('div', { className: 'dw-setting' },
          h('button', { className: 'dw-btn', disabled: sending || waiting || compacting || !snap.running || !snap.life || !snap.homeApply, onClick: apply }, waiting ? '等待家空闲…' : compacting ? '正在压缩家会话…' : sending ? '提交中…' : '应用并压缩家会话'),
          h('span', { role: 'status', 'aria-live': 'polite', className: error || state.status === 'failed' ? 'dw-bad' : 'dw-muted' }, error || (waiting ? '已排队，不打断当前对话。' : compacting ? '正在执行，请稍候。' : state.message) || (!snap.running || !snap.life ? '请先启动世界生活线。' : ''))))
    }

    function CompactionPreset(props) {
      var info = props.info
      var sendingState = useState(false), sending = sendingState[0], setSending = sendingState[1]
      var resultState = useState(null), result = resultState[0], setResult = resultState[1]
      function restore() {
        if (!window.confirm('还原预设「' + info.preset + '」？这会移除该预设在当前 profile 中的整份覆盖（包括你自己改过的设置），操作前会备份。')) return
        setSending(true); setResult(null)
        post('restore-compaction-preset').then(function () {
          setResult({ text: '已移除覆盖并备份。请重启 DSH，让已有会话使用还原后的预设。' })
          props.refresh()
        }, function (e) { setResult({ text: e.message || String(e), error: true }) }).then(function () { setSending(false) })
      }
      if (!info && !result) return null
      return h(Card, { title: '会话预设' },
        info ? h('div', { className: 'dw-muted' }, '预设「' + info.preset + '」正在使用 profile 中的压缩配置副本。DSH 升级时，自带预设的更新不会合入这份副本。') : null,
        info && info.canRestore ? h('div', { className: 'dw-setting' }, h('button', { className: 'dw-btn', disabled: sending, onClick: restore }, sending ? '还原中…' : '还原 DSH 预设')) : null,
        result ? h('div', { role: 'status', className: result.error ? 'dw-bad' : 'dw-muted' }, result.text) : null)
    }

    /** 今日花费里一页列几次对话：卡片不被拉得太长。 */
    var TURNS_PER_PAGE = 3
    /** 今天家里花了多少，和每天的额度（留空不限）。 */
    function Budget(props) {
      var budget = props.budget || {}, daily = budget.daily, today = budget.today
      var spent = today ? today.yuan : 0
      var draftState = useState(daily == null ? '' : String(daily)), draft = draftState[0], setDraft = draftState[1]
      var msgState = useState(''), msg = msgState[0], setMsg = msgState[1]
      var pageState = useState(0), page = pageState[0], setPage = pageState[1]
      function save() {
        var text = String(draft).trim(), value = text === '' ? null : Number(text)
        if (value !== null && !(value >= 0)) { setMsg('请填一个不小于 0 的数，或留空表示不限'); return }
        post('budget', { daily: value }).then(function () { setMsg(value === null ? '已改为不限' : '已保存'); if (props.onSaved) props.onSaved() }, failedTo(setMsg))
      }
      var over = daily != null && spent >= daily
      var turns = list(today && today.turns).slice().reverse()
      // 新的一次对话排在最前；翻到后面时列表变短（换了一天），就停在最后一页。
      var pages = Math.max(1, Math.ceil(turns.length / TURNS_PER_PAGE)), at = Math.min(page, pages - 1)
      /** token 数：上百万写成 M，上千写成 k。 */
      function k(n) { return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(n) }
      function seconds(iso, zone) { try { return new Date(iso).toLocaleTimeString('zh-CN', { timeZone: zone, hourCycle: 'h23' }) } catch (e) { return iso } }
      /** 这一轮用了哪些工具，按次数从多到少。 */
      function tools(counts) {
        var names = Object.keys(counts || {}).sort(function (a, b) { return counts[b] - counts[a] })
        return names.length ? names.map(function (name) { return counts[name] > 1 ? name + '×' + counts[name] : name }).join('、') : '只回话'
      }
      return h(Card, { title: '今日花费', delay: 240 },
        h('div', null, h('span', { className: 'dw-big' + (over ? ' dw-bad' : '') }, '¥' + spent.toFixed(2)), h('span', { className: 'dw-muted' }, daily == null ? ' · 不限额' : ' / ¥' + Number(daily).toFixed(2) + ' 每天')),
        daily != null ? h('div', { className: 'dw-meter' }, h('i', { style: { width: Math.min(100, daily > 0 ? Math.round(spent / daily * 100) : 100) + '%' } })) : null,
        h('div', { className: 'dw-muted', style: { marginTop: 4 } }, '只算家里；按 DeepSeek 官方价与峰谷时段估算。超过后提醒她一次。'),
        turns.length ? h('div', { className: 'dw-turns' },
          h('div', { className: 'dw-muted dw-turns-head' }, '最近 ' + turns.length + ' 次对话（每次从开始到结束）· token：命中缓存 / 未命中 / 输出'),
          turns.slice(at * TURNS_PER_PAGE, (at + 1) * TURNS_PER_PAGE).map(function (turn, i) {
            // 一次对话里没命中缓存的多，就是它贵的原因：标红。
            return h('div', { key: turn.at + i, className: 'dw-turn' },
              h('div', { className: 'dw-turn-top' },
                h('span', { className: 'dw-muted' }, seconds(turn.at, props.zone)),
                h('b', null, '¥' + turn.yuan.toFixed(2)),
                h('span', { className: 'dw-muted' }, turn.steps + ' 步'),
                h('span', { className: 'dw-muted', title: '命中缓存 / 未命中 / 输出（这一次对话所有步加起来）' }, k(turn.hit), ' / ', h('span', { className: turn.miss >= 50000 ? 'dw-miss' : '' }, k(turn.miss)), ' / ', k(turn.out)),
                turn.ended ? null : h('span', { className: 'dw-ok' }, '进行中')),
              h('div', { className: 'dw-turn-what' }, turn.trigger || '（看不出是什么开始的）'),
              h('div', { className: 'dw-muted dw-turn-tools' }, tools(turn.tools)))
          }),
          pages > 1 ? h('div', { className: 'dw-setting' },
            h('button', { className: 'dw-btn', disabled: at === 0, onClick: function () { setPage(at - 1) } }, '上一页'),
            h('span', { className: 'dw-muted' }, '第 ' + (at + 1) + ' / ' + pages + ' 页'),
            h('button', { className: 'dw-btn', disabled: at === pages - 1, onClick: function () { setPage(at + 1) } }, '下一页')) : null) : null,
        h('div', { className: 'dw-setting' },
          h('input', { type: 'text', inputMode: 'decimal', placeholder: '每天额度（元），留空不限', value: draft, onChange: function (e) { setDraft(e.target.value); setMsg('') } }),
          h('button', { className: 'dw-btn', onClick: save }, '保存')),
        h(Status, { msg: msg }))
    }
    /** 记忆块带最近几轮：默认 100，下次开始对话或压缩之后生效；隔多少小时没开口就重新读：默认 24，下一轮生效。 */
    function Memory(props) {
      var mem = props.mem, window_ = mem && mem.windowTurns || 100
      var activeScope = mem && mem.archiveScope || 'workspace'
      var scopeNames = { home: '仅家会话', workspace: '家所在工作区' }
      var scopeState = useState(mem && mem.selectedArchiveScope || activeScope), scope = scopeState[0], setScope = scopeState[1]
      var draftState = useState(String(window_)), draft = draftState[0], setDraft = draftState[1]
      var coldState = useState(String(mem && mem.coldHours || 24)), cold = coldState[0], setCold = coldState[1]
      var msgState = useState(''), msg = msgState[0], setMsg = msgState[1]
      function save() {
        var text = String(draft).trim(), value = text === '' ? null : Number(text)
        if (value !== null && !(Number.isInteger(value) && value >= 1)) { setMsg('请填一个不小于 1 的整数，留空恢复默认 100'); return }
        post('memory', { turns: value }).then(function () { setMsg('已保存。下次开始对话或压缩之后生效。'); if (value === null) setDraft('100'); if (props.onSaved) props.onSaved() }, failedTo(setMsg))
      }
      function saveCold() {
        var text = String(cold).trim(), value = text === '' ? null : Number(text)
        if (value !== null && !(Number.isInteger(value) && value >= 1 && value <= 720)) { setMsg('请填 1 到 720 之间的整数小时，留空恢复默认 24'); return }
        post('memory', { coldHours: value }).then(function () { setMsg('已保存。各窗口从下一轮开始按新时长判断。'); if (value === null) setCold('24'); if (props.onSaved) props.onSaved() }, failedTo(setMsg))
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
        h('div', { key: 'cd', className: 'dw-muted' }, '一个窗口隔这么久再开口，就重新读一遍记忆块、人设和「我」；正在聊的窗口不受影响。'),
        h('div', { key: 'c', className: 'dw-setting' },
          h('input', { type: 'text', inputMode: 'numeric', 'aria-label': '久未开口后重新读取（小时）', placeholder: '小时，留空为 24', value: cold, onChange: function (e) { setCold(e.target.value); setMsg('') } }),
          h('button', { className: 'dw-btn', onClick: saveCold }, '保存')),
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
    /** 回顾之后是否自动应用她改过的「我」：开关即存，不需要再点保存。 */
    function CompactAfterReview(props) {
      var msgState = useState(''), msg = msgState[0], setMsg = msgState[1]
      var busyState = useState(false), busy = busyState[0], setBusy = busyState[1]
      function toggle(on) {
        setBusy(true)
        post('compact-after-review', { on: on }).then(function () {
          setMsg(on ? '已开启。每晚回顾后会自动压缩家会话。' : '已关闭。她改过的「我」要等下一次压缩才生效。')
          if (props.onSaved) props.onSaved()
        }, failedTo(setMsg)).then(function () { setBusy(false) })
      }
      return h(Card, { title: '回顾后自动压缩' },
        h('div', { className: 'dw-muted' }, '每晚回顾结束、家空闲后，自动压缩一次家会话，换上她刚改写的「我」，并重读近期聊天。'),
        h('label', { className: 'dw-setting' },
          h('input', { type: 'checkbox', checked: props.on, disabled: busy, 'aria-label': '回顾后自动压缩', onChange: function (e) { toggle(e.target.checked) } }),
          ' ', props.on ? '已开启' : '已关闭'),
        h(Status, { msg: msg }))
    }
    /** 每日回顾和早上兜底的时间：留空恢复默认；保存后已排好的回顾和早上闹钟立刻改到新时间。 */
    /** Shown whether or not the life line runs; with `life: false` in the config there is nothing to schedule, so nothing to press. */
    function Schedule(props) {
      var s = props.schedule, off = s.life === false
      var reviewState = useState(s.review), review = reviewState[0], setReview = reviewState[1]
      var wakeState = useState(s.wake), wake = wakeState[0], setWake = wakeState[1]
      var msgState = useState(''), msg = msgState[0], setMsg = msgState[1]
      function save() {
        var values = [String(review).trim(), String(wake).trim()]
        if (values.some(function (v) { return v !== '' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(v) })) { setMsg('请填 HH:MM 格式的时间（00:00–23:59），留空恢复默认'); return }
        post('schedule', { review: values[0] || null, wake: values[1] || null }).then(function () {
          if (!values[0]) setReview(s.defaults.review); if (!values[1]) setWake(s.defaults.wake)
          setMsg('已保存。已排好的回顾和早上闹钟已改到新时间，她自己定的闹钟不变。')
          if (props.onSaved) props.onSaved()
        }, failedTo(setMsg))
      }
      return h(Card, { title: '作息' },
        h('div', { className: 'dw-muted' }, '每日回顾：她回头看一天、写日记的时间，定在中午以前就回顾前一天。早上：她没定闹钟时醒来的时间。留空恢复默认（回顾 ' + s.defaults.review + '，早上 ' + s.defaults.wake + '）。'),
        h('div', { className: 'dw-setting' },
          h('label', null, '每日回顾 ', h('input', { type: 'time', 'aria-label': '每日回顾时间', value: review, disabled: off, onChange: function (e) { setReview(e.target.value); setMsg('') } })),
          h('label', null, '早上 ', h('input', { type: 'time', 'aria-label': '早上醒来时间', value: wake, disabled: off, onChange: function (e) { setWake(e.target.value); setMsg('') } })),
          h('button', { className: 'dw-btn', disabled: off, onClick: save }, '保存')),
        h('div', { className: 'dw-muted' }, off ? '配置里写了 life: false，生活线没开：不会回顾，也不会叫醒她。在 cordis.patch.yml 里删掉这一行或改成 true，重启 DSH 后这里就能改。' : '她看到的工具说明里写的早上时间，要等新开的会话或重启 DSH 后才更新。'),
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
      var stateText = blocked ? '● 有消息待核对，适配器已停' : !contacted ? (ad && ad.building ? '● 正在重新构建原生桥' : ad && ad.running ? '● 适配器启动中' : ad && ad.error ? '● 适配器没能启动' : w.lastContactAt ? '● 适配器已断开' : '● 等待适配器') : offline ? '● 微信离线，等待重新登录' : '● 已连接'
      var adMsgState = useState(''), adMsg = adMsgState[0], setAdMsg = adMsgState[1]
      function restartAdapter() {
        setAdMsg('正在重启…')
        post('wechat-adapter', {}).then(function () { setAdMsg('已重启'); if (props.onSaved) props.onSaved() }, function (e) { setAdMsg('重启失败：' + (e.message || e)) })
      }
      function save() {
        var c = String(context).trim() === '' ? null : Number(context), b = String(buffer).trim() === '' ? null : Number(buffer)
        if (c !== null && !(Number.isInteger(c) && c >= 1 && c <= 20)) { setMsg('请填 1–20 的整数，留空恢复默认 5'); return }
        if (b !== null && !(b >= 0 && b <= 30)) { setMsg('请填 0–30 秒，留空恢复默认 3'); return }
        post('wechat', { contextMessages: c, bufferSeconds: b }).then(function () {
          setMsg('已保存。适配器下次轮询时同步，当前这一批沿用原值。')
          if (c === null) setContext('5'); if (b === null) setBuffer('3')
          if (props.onSaved) props.onSaved()
        }, failedTo(setMsg))
      }
      // 选的是哪个私聊是伙伴自己的微信；适配器没连上时名单是空的，已选的那个照样列着。
      var partnerMsgState = useState(''), partnerMsg = partnerMsgState[0], setPartnerMsg = partnerMsgState[1]
      var chats = (w.privateChats || []).slice()
      if (w.partner && !chats.some(function (c) { return c.id === w.partner })) chats.unshift({ id: w.partner, name: w.partner })
      function choosePartner(e) {
        var id = e.target.value
        setPartnerMsg('正在保存…')
        post('wechat', { partner: id || null }).then(function () {
          setPartnerMsg(id ? '已保存。她下次重读记忆时（新会话、压缩后），你在微信上说的话就写成你说的。' : '已取消。')
          if (props.onSaved) props.onSaved()
        }, failedTo(setPartnerMsg))
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
          h('input', { type: 'text', inputMode: 'numeric', 'aria-label': '群聊读取上文条数', placeholder: '上文条数，默认 5', value: context, onChange: function (e) { setContext(e.target.value); setMsg('') } }),
          h('input', { type: 'text', inputMode: 'decimal', 'aria-label': '消息缓冲秒数', placeholder: '缓冲秒数，默认 3', value: buffer, onChange: function (e) { setBuffer(e.target.value); setMsg('') } }),
          h('button', { className: 'dw-btn', onClick: save }, '保存')),
        h('div', { className: 'dw-muted' }, '上文按消息条数算（群聊被 @ 时带上之前几条）；缓冲是收到消息后等对方说完的秒数：同一个人在这段时间里又发来消息就重新计时，安静下来再合成一条交给她（最长等 30 秒），0 = 不等。与共享记忆的 200 轮无关。'),
        h(Status, { msg: msg }),
        h('div', { className: 'dw-setting' },
          h('label', null, '你的微信 ', h('select', { value: w.partner || '', 'aria-label': '伙伴的微信', onChange: choosePartner },
            h('option', { value: '' }, '不设'),
            chats.map(function (c) { return h('option', { key: c.id, value: c.id }, c.name || c.id) })))),
        h('div', { className: 'dw-muted' }, '选你自己和她的那个私聊：她的记忆里，你在微信上说的话就写成你说的。不选的话，写的是这个私聊里对方的微信昵称。'),
        h(Status, { msg: partnerMsg }))
    }
    /** QQ：她自己那条 OneBot 通道（原生），以及 SnowLuma 控制台的入口。 */
    function Qq(props) {
      var busyState = useState(false), busy = busyState[0], setBusy = busyState[1]
      var msgState = useState(''), msg = msgState[0], setMsg = msgState[1]
      // 两个控制台都带 X-Frame-Options: DENY，塞不进 iframe，所以交给系统浏览器开。
      // 地址和令牌由宿主半侧现给（…/qq/console），所以打开就是登录态。
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
        if (!isFinite(sec) || sec < 0 || sec > 30) { setMsg('填 0 到 30 之间的秒数（一批最多等 30 秒）'); return }
        change({ batchQuietMs: Math.round(sec * 1000) })
      }
      // 白名单：谁的话能进来。一行一个号（私聊或群）加备注，存的时候仍是 allowPrivate/allowGroups 两个数组；
      // 备注走 aliases，只影响显示。每行有自己的 key：号码是正在改的字，拿它当 key 的话每敲一个字输入框都会重建。
      var savedAliases = (props.native && props.native.aliases) || {}
      var savedPrivate = props.native ? props.native.allowPrivateIds || [] : []
      var allowIds = props.native ? savedPrivate.concat(props.native.allowGroupsIds || []) : []
      var allowRowsFrom = allowIds.join('|') + '|' + JSON.stringify(savedAliases)
      var allowRowsState = useState({ from: '', rows: [], next: 0 }), allowRows = allowRowsState[0], setAllowRows = allowRowsState[1]
      useEffect(function () {
        setAllowRows(function (current) {
          if (current.from === allowRowsFrom) return current
          var rows = allowIds.map(function (id, index) {
            return { key: current.next + index, id: id, kind: index < savedPrivate.length ? 'private' : 'group', note: savedAliases[id] || '' }
          })
          return { from: allowRowsFrom, rows: rows, next: current.next + rows.length }
        })
      }, [allowRowsFrom])
      function patchRow(key, patch) {
        setAllowRows(function (current) {
          var rows = current.rows.map(function (row) { return row.key === key ? Object.assign({}, row, patch) : row })
          return { from: current.from, rows: rows, next: current.next }
        })
      }
      function addAllowRow() {
        setAllowRows(function (current) {
          return { from: current.from, rows: current.rows.concat([{ key: current.next, id: '', kind: 'private', note: '' }]), next: current.next + 1 }
        })
      }
      function dropAllowRow(key) {
        setAllowRows(function (current) {
          return { from: current.from, rows: current.rows.filter(function (row) { return row.key !== key }), next: current.next }
        })
      }
      function saveAllow() {
        var aliasesOut = {}, people = [], groups = [], wrong = ''
        allowRows.rows.forEach(function (row) {
          var id = String(row.id).trim()
          if (!/^[0-9]+$/.test(id)) { if (!wrong) wrong = id || '(空)'; return }
          if (row.note.trim()) aliasesOut[id] = row.note.trim().slice(0, 100)
          var list = row.kind === 'group' ? groups : people
          if (list.indexOf(id) < 0) list.push(id)
        })
        if (wrong) { setMsg('请填 QQ 号：「' + wrong + '」不是号码'); return }
        change({ allowPrivate: people, allowGroups: groups, aliases: aliasesOut }, function () {
          return people.length || groups.length ? '名单存好了：私聊 ' + people.length + ' 个、群 ' + groups.length + ' 个' : '名单存好了：现在谁的话都不收'
        })
      }
      // 每个群自己的接话规矩。map 里没有这个群 = 跟着全局 groupTrigger 走；
      // 只交 mention/all 上去，选「跟着默认」就把这个键从 map 里删掉。
      var groups = (function (n) {
        var list = []
        if (!n) return list
        ;(n.allowGroupsIds || []).forEach(function (id) { if (list.indexOf(id) < 0) list.push(id) })
        Object.keys(n.groupTriggers || {}).forEach(function (id) { if (list.indexOf(id) < 0) list.push(id) })
        return list
      })(props.native)
      var savedTriggers = (props.native && props.native.groupTriggers) || {}
      var triggersFrom = groups.join('|') + '|' + JSON.stringify(savedTriggers)
      var triggerState = useState({ from: '', map: {} }), triggerMap = triggerState[0].map, setTrigger = triggerState[1]
      // 唤醒词：打开时填上已存的词，之后只在存下的词变了时重填，不覆盖正在加的那个。
      var kwState = useState({ from: '', words: null, draft: '' }), kw = kwState[0], setKw = kwState[1]
      var kwFrom = props.native ? JSON.stringify(props.native.groupKeywords || []) : ''
      useEffect(function () {
        setKw(function (old) { return old.from === kwFrom ? old : { from: kwFrom, words: kwFrom ? JSON.parse(kwFrom) : null, draft: '' } })
      }, [kwFrom])
      useEffect(function () {
        setTrigger(function (current) {
          if (current.from === triggersFrom) return current
          var map = {}
          Object.keys(savedTriggers).forEach(function (id) { map[id] = savedTriggers[id] })
          return { from: triggersFrom, map: map }
        })
      }, [triggersFrom])
      function pickTrigger(id, value) {
        setTrigger(function (current) {
          var map = {}
          Object.keys(current.map).forEach(function (key) { map[key] = current.map[key] })
          if (value === 'mention' || value === 'all') map[id] = value
          else delete map[id]
          return { from: current.from, map: map }
        })
      }
      function saveTriggers() {
        var map = {}, wrong = ''
        Object.keys(triggerMap).forEach(function (id) {
          if (!/^[0-9]+$/.test(id)) { if (!wrong) wrong = id; return }
          if (triggerMap[id] === 'mention' || triggerMap[id] === 'all') map[id] = triggerMap[id]
        })
        if (wrong) { setMsg('群号只能是数字：「' + wrong + '」不是号码'); return }
        change({ groupTriggers: map }, function () {
          var count = Object.keys(map).length
          return count ? '存好了：' + count + ' 个群有自己的规矩，其余跟着默认' : '存好了：现在每个群都跟着默认走'
        })
      }
      function saveKeywords() {
        var words = (kw.words || []).filter(function (w) { return w && w.trim() })
        var draft = kw.draft.trim()
        if (draft) words.push(draft)
        var bad = words.find(function (w) { return w.length > 32 })
        if (bad) { setMsg('唤醒词最长 32 个字：「' + bad.slice(0, 12) + '…」太长了'); return }
        change({ groupKeywords: words }, function () {
          return words.length ? '存好了：' + words.length + ' 个唤醒词，mention 的群里带其中一个就算在叫她' : '存好了：现在唤醒词清空，mention 只认 @ 和引用她的消息'
        })
      }
      function dropKeyword(i) {
        setKw(function (old) { var words = (old.words || []).slice(); words.splice(i, 1); return { from: old.from, words: words, draft: old.draft } })
      }
      function startSnowluma() {
        change({ startSnowluma: true }, function (state) {
          var r = state && state.launch
          if (r && r.alreadyRunning) return 'SnowLuma 已在运行或启动中，无需重复拉起'
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
            h('span', { key: 'b', className: 'dw-muted' }, ' · 收 ' + (n.conversations || 0) + ' 个会话 · 发 ' + (n.sent || 0) + ' 条' + (n.failed ? ' · 失败 ' + n.failed : '') + (n.rejected ? ' · 排满被拒 ' + n.rejected : '') + (n.dropped ? ' · 放弃 ' + n.dropped + (n.lastDroppedReason === 'stop' ? '（通道关掉）' : n.lastDroppedReason === 'ttl' ? '（等太久）' : '') : '') + (n.outbox ? ' · 排队待发 ' + n.outbox : '') + (n.blocked ? ' · 挡下 ' + n.blocked : '') + (n.autoReply ? ' · 会自己回' : ' · 只看不回')),
            n.lastError ? h('span', { key: 'c', className: 'dw-bad' }, ' · ' + n.lastError) : null,
          ])
        })(props.native) : h('div', { key: 'n', className: 'dw-muted' }, '她自己的通道：没开（配置里 qqNative.enabled）'),
        (function (n) {
          if (!n) return null
          // 自动回复是个闸门，不是状态展示：文案固定，动作是明确的按钮。
          // 关掉会让后来的人白说一顿（他们的话只记上下文、不回、不落会话），所以关之前问一次。
          function closeGate() {
            if (!window.confirm('关掉后，收到的消息只记上下文、不回也不落会话，对方不知道你关了。确定先不回话吗？')) return
            change({ autoReply: false }, function () { return '自动回复已关：只收不回，需要时再开' })
          }
          function openGate() { change({ autoReply: true }, function () { return '自动回复已开：来话就回' }) }
          return h('div', { key: 'nt', className: 'dw-setting' }, [
            h('span', { key: 's', className: n.autoReply === true ? 'dw-ok' : 'dw-bad' }, n.autoReply === true ? '● 自动回复开着' : '○ 自动回复关着（只收不回）'),
            n.autoReply === true
              ? h('button', { key: 'x', className: 'dw-btn', disabled: busy, onClick: closeGate }, '先不回')
              : h('button', { key: 'o', className: 'dw-btn', disabled: busy, onClick: openGate }, '开始回话'),
          ])
        })(props.native),
        // 她自己在「自己的时间」里开的那轮（闹钟、世界线）说完，要不要把那段话推到你 QQ。
        // 关掉之后她歇着、收工这种话就不吵你了；有事的轮次她自己会找你。
        props.native ? (function (n) {
          return h('div', { key: 'fo', className: 'dw-setting' }, [
            h('span', { key: 's', className: 'dw-muted' }, n.forwardOwn === false ? '她自己时间说的话：不推到你 QQ' : '她自己时间说的话：也推到你 QQ'),
            n.forwardOwn === false
              ? h('button', { key: 'on', className: 'dw-btn', disabled: busy, onClick: function () { change({ forwardOwn: true }, function () { return '已开：她那段话说完会推给你' }) } }, '要推')
              : h('button', { key: 'off', className: 'dw-btn', disabled: busy, onClick: function () { change({ forwardOwn: false }, function () { return '已关：她歇着、收工这类话不再吵你' }) } }, '不推'),
          ])
        })(props.native) : null,
        (function (n) {
          if (!n) return null
          var ms = typeof n.batchQuietMs === 'number' ? n.batchQuietMs : 10000
          return h('div', { key: 'quiet', className: 'dw-setting' }, [
            h('span', { key: 's', className: 'dw-muted' }, ms ? '连着发几句：' + (ms / 1000) + ' 秒内合成一次问' : '连着发几句：每句单独回'),
            h('input', { key: 'i', type: 'number', min: 0, max: 30, step: 1, 'aria-label': '合批窗口（秒）', style: { width: 64 }, disabled: busy, value: quiet, onChange: function (e) { setQuiet(e.target.value) } }),
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
        props.native ? h('div', { key: 'allow', className: 'dw-setting', style: { flexWrap: 'wrap' } }, [
          h('div', { key: 'h', className: 'dw-muted', style: { width: '100%' } }, '谁的话能进来：一行一个人或一个群，备注只给你自己看。表里没有的号谁都进不来。改完不用重启。'),
          allowRows.rows.map(function (row, index) {
            return h('div', { key: 'r' + row.key, className: 'dw-setting', style: { width: '100%', gap: 8 } }, [
              h('select', { key: 'k', 'aria-label': '第 ' + (index + 1) + ' 行是私聊还是群', disabled: busy, value: row.kind, onChange: function (e) { patchRow(row.key, { kind: e.target.value }) } }, [
                h('option', { key: 'p', value: 'private' }, '私聊'),
                h('option', { key: 'g', value: 'group' }, '群'),
              ]),
              h('input', { key: 'i', type: 'text', inputMode: 'numeric', 'aria-label': '第 ' + (index + 1) + ' 行的号码', placeholder: 'QQ 号', disabled: busy, value: row.id, style: { width: 140, fontVariantNumeric: 'tabular-nums' }, onChange: function (e) { patchRow(row.key, { id: e.target.value }) } }),
              h('input', { key: 'n', type: 'text', 'aria-label': '第 ' + (index + 1) + ' 行的备注', placeholder: '备注（只是给自己看）', disabled: busy, value: row.note, onChange: function (e) { patchRow(row.key, { note: e.target.value }) } }),
              h('button', { key: 'x', className: 'dw-btn', disabled: busy, onClick: function () { dropAllowRow(row.key) }, title: '从表里删掉这一行（存了才会生效）' }, '删'),
            ])
          }),
          h('button', { key: 'a', className: 'dw-btn', disabled: busy, onClick: addAllowRow }, '加一行'),
          h('button', { key: 'b', className: 'dw-btn', disabled: busy, onClick: saveAllow }, '存名单'),
        ]) : null,
        // 每个群单独一行：谁在列表里就都有自己的一格，选「跟着默认」就不写进 groupTriggers。
        // 群号来源 = 群白名单 + 已经存过规矩的群（后者可能已经不在白名单里，也要能改回来）。
        groups.length ? h('div', { key: 'triggers', className: 'dw-setting', style: { flexWrap: 'wrap' } }, [
          h('div', { key: 'h', className: 'dw-muted', style: { width: '100%' } },
            '每个群自己定：默认是' + ((props.native && props.native.groupTrigger) === 'all' ? '每句都接' : '只接被叫到的') + '。改完不用重启。'),
          groups.map(function (id) {
            return h('div', { key: 'g' + id, className: 'dw-setting', style: { width: '100%', gap: 8 } }, [
              h('span', { key: 'i', style: { minWidth: 110, fontVariantNumeric: 'tabular-nums' } }, id),
              h('select', {
                key: 's', 'aria-label': '群 ' + id + ' 的接话规矩', disabled: busy, value: triggerMap[id] || '',
                onChange: function (e) { pickTrigger(id, e.target.value) },
              }, [
                h('option', { key: 'd', value: '' }, '跟着默认'),
                h('option', { key: 'm', value: 'mention' }, '只接被叫到的'),
                h('option', { key: 'a', value: 'all' }, '每句都接'),
              ]),
            ])
          }),
          h('button', { key: 'b', className: 'dw-btn', disabled: busy, onClick: saveTriggers }, '存群的规矩'),
        ]) : null,
        kw.words ? h('div', { key: 'keywords', className: 'dw-setting', style: { flexWrap: 'wrap' } }, [
          h('div', { key: 'note', style: { flexBasis: '100%' } }, '唤醒词（mention 的群里，消息带其中一个就算在叫她；清空后只认 @ 和引用）：'),
          kw.words.length ? kw.words.map(function (w, i) {
            return h('span', { key: w + '.' + i }, [
              h('span', { key: 'w' }, w),
              h('button', { key: 'x', onClick: function () { dropKeyword(i) }, title: '删掉这个词', disabled: busy }, '×'),
            ])
          }) : h('span', { key: 'none', className: 'dw-muted' }, '（还没有）'),
          h('input', { key: 'add', value: kw.draft, placeholder: '加一个唤醒词', 'aria-label': '加一个唤醒词', disabled: busy,
            onChange: function (e) { var v = e.target.value; setKw(function (old) { return { from: old.from, words: old.words, draft: v } }) } }),
          h('button', { key: 'save', className: 'dw-btn', disabled: busy, onClick: saveKeywords }, '存唤醒词'),
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
    /**
     * 信箱不理会的程序：每点一下就存，信箱下一次看任务栏就照新的来，所以不留一份会过期的草稿名单。
     * 「最近报过」是她这次启动以来听到的名字，点一下就不再报。她用电脑关着时名单照样能改，打开后照它来。
     */
    function Inbox(props) {
      var inbox = props.inbox, names = inbox.ignore
      var msgState = useState(''), msg = msgState[0], setMsg = msgState[1]
      var busyState = useState(false), busy = busyState[0], setBusy = busyState[1]
      var draftState = useState(''), draft = draftState[0], setDraft = draftState[1]
      var has = function (name) { return names.some(function (each) { return each.toLowerCase() === name.toLowerCase() }) }
      var told = inbox.told.filter(function (name) { return !has(name) })
      function save(next, done) {
        setBusy(true); setMsg('')
        post('inbox-ignore', { names: next }).then(function () { setBusy(false); setMsg(done); if (props.onSaved) props.onSaved() },
          function (e) { setBusy(false); setMsg('保存失败：' + (e.message || e)) })
      }
      function add(name) {
        name = name.trim()
        if (!name) return
        if (has(name)) { setMsg('「' + name + '」已经在名单里'); return }
        save(names.concat([name]), '存好了：信箱不再报「' + name + '」')
        setDraft('')
      }
      return h(Card, { title: '信箱', delay: 60 },
        h('div', { className: 'dw-muted', style: { marginBottom: 8 } }, props.listening
          ? '她用电脑开着时，信箱替她看任务栏：有程序在闪或弹通知，等安静 10 秒告诉她一句。微信、QQ 有自己的通道，不算。'
          : '她用电脑关着，信箱现在没在听。名单先存着，在概览的「接入」里打开她用电脑后照它来。'),
        h('div', { className: 'dw-setting', style: { flexWrap: 'wrap' } }, [
          h('div', { key: 'note', style: { flexBasis: '100%' } }, '信箱不理会这些程序（写她听到的名字，或程序的 exe 名）：'),
          names.length ? names.map(function (name) {
            return h('span', { key: name }, [
              h('span', { key: 'w' }, name),
              h('button', { key: 'x', onClick: function () { save(names.filter(function (each) { return each !== name }), '存好了：信箱又会报「' + name + '」') }, title: '让信箱再报它', disabled: busy }, '×'),
            ])
          }) : h('span', { key: 'none', className: 'dw-muted' }, '（一个都没有，什么都报）'),
          h('input', { key: 'add', value: draft, placeholder: '加一个程序', 'aria-label': '信箱不理会的程序', disabled: busy,
            onChange: function (e) { setDraft(e.target.value) }, onKeyDown: function (e) { if (e.key === 'Enter') add(draft) } }),
          h('button', { key: 'save', className: 'dw-btn', disabled: busy || !draft.trim(), onClick: function () { add(draft) } }, '加上'),
          inbox.custom ? h('button', { key: 'reset', className: 'dw-btn', disabled: busy, onClick: function () { save(null, '存好了：回到默认名单') } }, '恢复默认') : null,
          told.length ? h('div', { key: 'told', style: { flexBasis: '100%' } }, ['最近报过：'].concat(told.map(function (name) {
            return h('button', { key: name, className: 'dw-btn', disabled: busy, onClick: function () { add(name) } }, '不再报「' + name + '」')
          }))) : null,
          h('div', { key: 'about', className: 'dw-muted', style: { flexBasis: '100%' } }, '默认的是 Windows 自己的程序，它们不会是有人在叫她：控制台窗口（conhost、OpenConsole）、远程桌面（msrdc、mstsc）、资源管理器（explorer），以及 Windows 自己的通知（Windows.SystemToast、Microsoft.Windows）。不分大小写；写「Microsoft.Windows」也算上以「Microsoft.Windows.」开头的。DSH 自己（DeepSeek Harness，她的家）不在名单里，也永远不报：那是她自己的话。'),
        ]),
        msg ? h('div', { className: msg.indexOf('失败') >= 0 ? 'dw-bad' : 'dw-muted', role: 'status' }, msg) : null)
    }
    /** 接入：微信、QQ、她的浏览器、她用电脑、她住进小屋各一个开关，关闭即撤下，状态记在 world.json。 */
    function Modules(props) {
      var m = props.modules
      var msgState = useState(''), msg = msgState[0], setMsg = msgState[1]
      var busyState = useState(''), busy = busyState[0], setBusy = busyState[1]
      function flip(name, value) {
        var body = {}; body[name] = value
        steps(name, [body])
      }
      /** 按顺序发几次切换，前一次成了才发下一次；busy 是这次切换的名字，用来显示「切换中」。 */
      function steps(name, bodies) {
        setBusy(name); setMsg('')
        var chain = Promise.resolve({})
        bodies.forEach(function (body) { chain = chain.then(function () { return post('modules', body) }) })
        chain.then(function (result) { setBusy(''); if (result && result.message) setMsg(result.message); if (props.onSaved) props.onSaved() }, function (e) { setBusy(''); setMsg('切换失败：' + (e.message || e)); if (props.onSaved) props.onSaved() })
      }
      /**
       * 她用电脑：关闭、后台、前台三选一。后台是默认的那种（只看一个窗口、不动你的鼠标）；前台是把电脑交给她（看整个屏幕、
       * 用真的鼠标键盘），每次开都要确认一次管理员权限，所以不记住。
       */
      function desktopRow() {
        var d = m.desktop, f = m.foreground || {}
        // Not Windows: still listed, so nobody wonders where it went.
        if (!d.available) return h('div', { key: 'desktop', className: 'dw-setting' },
          h('span', null, h('b', null, '她用电脑'), h('span', { className: 'dw-muted' }, ' · 这台电脑用不了')),
          h('div', { className: 'dw-muted', style: { flexBasis: '100%' } }, d.reason))
        var mode = !d.enabled ? 'off' : f.enabled ? 'front' : 'back'
        function choose(next) {
          if (next === mode) return
          if (next === 'off') return steps('desktop', [{ desktop: false }])
          if (next === 'back') return steps('desktop', mode === 'off' ? [{ desktop: true }] : [{ foreground: false }])
          steps('front', mode === 'off' ? [{ desktop: true }, { foreground: true }] : [{ foreground: true }])
        }
        var state = busy === 'front' ? '等你在弹出的 Windows 窗口里点「是」，确认管理员权限…' : busy === 'desktop' ? '切换中…'
          : mode === 'off' ? '已关闭' : !d.running ? (props.running ? '启动中' : '已开启，世界启动后生效') : mode === 'front' ? '前台模式' : '后台模式'
        var about = {
          off: '她用不了你的电脑。',
          back: '后台模式：她每次只看一个窗口的截图，点击和输入直接交给那个窗口，不动你的鼠标、不抢你的焦点，你用着电脑她也能用。以管理员权限运行的程序（很多游戏和它们的启动器）后台够不着，要用就切到前台。',
          front: '前台模式：你把电脑交给她。她看整个屏幕，用真的鼠标和键盘操作，游戏和管理员程序也能用；你的鼠标会被她挪动，最前面的窗口会变。开前台要在弹出的 Windows 窗口里确认一次管理员权限；关掉、换回后台或重启 DSH 后就失效，下次再确认。',
        }[mode]
        return h('div', { key: 'desktop', className: 'dw-setting' },
          h('span', null, h('b', null, '她用电脑'), h('span', { className: 'dw-muted' }, ' · ' + state)),
          h('span', { className: 'dw-seg', role: 'group', 'aria-label': '她用电脑的模式' }, [['off', '关闭'], ['back', '后台'], ['front', '前台']].map(function (option) {
            return h('button', { key: option[0], className: mode === option[0] ? 'on' : '', disabled: !!busy, 'aria-pressed': mode === option[0], onClick: function () { choose(option[0]) } }, option[1])
          })),
          h('div', { className: 'dw-muted', style: { flexBasis: '100%' } }, about + (mode === 'off' ? '' : '她操作时屏幕顶上有提示，连按两下 Esc 或点「停下」就能叫停。开着时她的信箱也在听：任务栏上有程序在闪或弹通知，等安静 10 秒告诉她一句（微信、QQ 有自己的通道，不算；不理会哪些程序在「她的电脑」页里改）。')))
      }
      /**
       * Every row is always listed; only its button follows what the config and this machine allow. `setup` says what is
       * missing and how to get it, `missing` names that state (the config, by default).
       */
      function row(name, label, info, onText, offText, setup, missing) {
        // Unavailable for a reason this machine gives (no browser) or because the config does not have it.
        var state = busy === name ? (name === 'qq' ? '正在检查或安装 SDK…' : '切换中…') : !info.available ? (info.reason ? '这台电脑用不了' : missing || '未配置') : info.restartRequired ? 'SDK 已安装，请重启 DSH' : !info.enabled ? '已关闭' : info.running ? '运行中' : props.running ? '启动中' : '已开启，世界启动后生效'
        return h('div', { key: name, className: 'dw-setting' },
          h('span', null, h('b', null, label), h('span', { className: 'dw-muted' }, ' · ' + state)),
          h('button', { className: 'dw-btn', disabled: !info.available || busy === name, onClick: function () { flip(name, !info.enabled) } }, info.enabled ? '关闭' : '开启'),
          h('div', { className: 'dw-muted', style: { flexBasis: '100%' } }, !info.available ? info.reason || setup : info.enabled ? onText : offText))
      }
      return h(Card, { title: '接入', delay: 270 },
        row('wechat', '微信', m.wechat, '已注册 wechat_chats、wechat_history、wechat_send、wechat_delivery，可先看群聊再发言，并随之启动适配器。关闭会撤掉它们并停掉适配器。', '工具未注册，适配器已停。开启后立即注册，无需重启。',
          '配置里还没允许微信：在 profile 的 cordis.patch.yml 里，dsh-world 的 config 下写 wechat: true，重启 DSH 后这里就能开。微信还要另外准备 Windows 适配器，见 README 的微信一节。'),
        row('qq', 'QQ', m.qq, '插件自己直连 OneBot：状态和设置在 QQ 页面。关闭就断开这条通道。', '开启时检查 SDK；缺少时按需安装并提示重启 DSH。',
          '配置里还没允许 QQ：在 profile 的 cordis.patch.yml 里，dsh-world 的 config 下写 qqNative（enabled: true，再填 OneBot 的 wsUrl 和 accessToken，见 INSTALL.md），重启 DSH 后这里就能开。'),
        m.computer ? row('computer', '她的浏览器', m.computer, '她有一个自己的 Edge 浏览器，是单独的窗口，登录的是她自己的账号，不用你的鼠标键盘；她学会的操作也存在这里，可以直接再跑。只在她的家里能用。', '她没有自己的浏览器。开启后她下一步就能用；她用电脑也要先开这一项。') : null,
        m.desktop ? desktopRow() : null,
        m.cottage ? row('cottage', '她住进小屋', m.cottage, '她有一个 cottage 工具：在小屋和院子里走动、做饭、晾衣服、种菜种花；锅里的好了、衣服干了、菜熟了或缺水了，她下一次醒着时会在「别处的动静」里看到（不会叫醒她）。她在哪、在忙什么，小屋里看得到。只在她的家里能用。', '小屋只是画面，她自己看不到也用不了。开启后她才住进去，她的小屋记在这个世界的 cottage.json 里，关掉也留着。', '小屋还没装：先在顶部「小屋」标签里安装，装好这里就能开。', '未安装') : null,
        msg ? h('div', { className: msg.indexOf('失败') >= 0 ? 'dw-bad' : 'dw-muted', role: 'status' }, msg) : null)
    }
    /** 她的浏览器：Edge 在不在、她按分类学会了哪些操作、各自最近一次结果；按钮把窗口拿到前面来扫码。 */
    function Computer(props) {
      var c = props.computer, categories = list(c.categories)
      var msgState = useState(''), msg = msgState[0], setMsg = msgState[1]
      var stateLabel = { missing: '找不到 Edge', stopped: '未打开', running: '运行中' }
      function open() { setMsg(''); post('computer/open', {}).then(function () { setMsg('窗口已拿到前面') }, function (e) { setMsg('打不开：' + (e.message || e)) }) }
      return h(Card, { title: '她的浏览器', delay: 300 },
        KV([['浏览器', stateLabel[c.browser.state] || c.browser.state], ['操作目录', c.dir]]),
        categories.length ? categories.map(ComputerCategory) : h('div', { className: 'dw-muted' }, '她还没有学会的操作'),
        c.desktop ? ComputerDesktop(c.desktop, props.zone) : null,
        h('button', { className: 'dw-btn', disabled: c.browser.state === 'missing', onClick: open }, '打开她的浏览器'),
        msg ? h('div', { className: msg.indexOf('打不开') >= 0 ? 'dw-bad' : 'dw-muted', role: 'status' }, msg) : null)
    }
    /** 她用电脑：驱动在不在跑，和她最近做的几个动作（不含她输入的文字）。 */
    function ComputerDesktop(desktop, zone) {
      var recent = list(desktop.recent)
      return h('div', { key: 'desktop', style: { marginTop: 8 } },
        h('div', null, h('b', null, '她用电脑'), h('span', { className: 'dw-muted' }, desktop.running ? ' · 驱动运行中' : ' · 还没开始用')),
        recent.map(function (a, i) { return h('div', { key: i, className: a.ok ? 'dw-muted' : 'dw-bad' }, clock(a.at, zone) + ' ' + a.action + (a.app ? ' · ' + a.app : '') + (a.ok ? '' : ' · 没做成')) }))
    }
    function ComputerCategory(category) {
      var operations = list(category.operations)
      return h('div', { key: category.name, style: { marginTop: 8 } },
        h('div', null, h('b', null, category.name), h('span', { className: 'dw-muted' }, category.guide ? ' · 她写了说明' : ' · 还没写说明')),
        operations.length ? operations.map(function (p) { return h('div', { key: p.name, className: p.last && !p.last.ok ? 'dw-bad' : 'dw-muted' }, p.name + ' · ' + p.description + (p.onAlarm ? '（闹钟前）' : '') + (p.last ? (p.last.ok ? ' · 最近成功' : ' · 最近失败：' + (p.last.detail || '')) : '')) }) : h('div', { className: 'dw-muted' }, '这一类还没有操作'))
    }
    function Health(props) {
      var faults = list(props.faults)
      return h(Card, { title: '健康', delay: 120 },
        faults.length ? faults.map(function (f, i) { return h('div', { key: i, className: 'dw-bad' }, '● ' + f) }) : h('div', { className: 'dw-ok' }, '● 一切正常'))
    }
    /** 有新版本时最上面的一行：只提示，升级要先退出 DSH，按升级说明做。没查到就说没查到，不冒充「已是最新」。 */
    function UpdateNotice(props) {
      var u = props.update
      var msgState = useState(''), msg = msgState[0], setMsg = msgState[1]
      if (!u) return null
      /** 剪贴板在 DSH 的窗口里不一定能用：复制不了就说一声，命令在下面展开，可以自己选中复制。 */
      function copy() {
        var clipboard = typeof navigator !== 'undefined' && navigator.clipboard
        if (!clipboard) { setMsg('这里复制不了，展开下面的命令自己复制。'); return }
        clipboard.writeText(u.command).then(function () { setMsg('已复制。先正常退出 DSH，再粘贴到 ' + u.shell + ' 里运行；升级前会先备份，失败会自动恢复。') }, function () { setMsg('这里复制不了，展开下面的命令自己复制。') })
      }
      if (u.newer) return h(Card, { title: '有新版本' },
        h('div', null, 'dsh-world ' + u.latest + ' 已经发布，现在用的是 ' + u.current + '。'),
        h('div', { className: 'dw-muted', style: { marginTop: 6 } }, '升级要先正常退出 DSH，再用更新脚本装上；她的归档、日记和设置都会保留。'),
        u.command ? h('div', { style: { marginTop: 8 } },
          h('button', { className: 'dw-btn', onClick: copy }, '更新'),
          msg ? h('span', { className: 'dw-muted', role: 'status', style: { marginLeft: 10 } }, msg) : null,
          h('details', { style: { marginTop: 8 } }, h('summary', { className: 'dw-muted' }, '看看要运行的命令'), h('pre', { style: { whiteSpace: 'pre-wrap', userSelect: 'all' } }, u.command))) : null,
        h('div', { style: { marginTop: 8 } }, h('a', { href: u.changelog, target: '_blank', rel: 'noreferrer' }, '更新日志'), ' · ', h('a', { href: u.upgrade, target: '_blank', rel: 'noreferrer' }, '怎么升级')))
      // The last look failed: said even when an earlier one found nothing newer, so it never passes for being up to date.
      if (u.error) return h('div', { className: 'dw-muted', style: { margin: '0 0 12px' } }, '没查到有没有新版本：' + u.error + '（明天再查）')
      return null
    }
    function Overview(props) {
      var snap = props.snap, zone = snap.timeZone, life = snap.life, alarm = life && life.alarm, mem = snap.memory
      var wakes = life ? list(life.recentWakes) : []
      var welcome = !snap.running && !life
      return h('div', { className: 'dw-pane' },
        h(UpdateNotice, { update: snap.update }),
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
          h(Health, { faults: snap.health }),
          h(Budget, { budget: snap.budget, zone: zone, onSaved: props.refresh }),
          h(Memory, { mem: mem, onSaved: props.refresh }),
          h(CompactionPreset, { info: snap.compactionPreset, refresh: props.refresh }),
          snap.workspace ? h(WorkspacePermission, { workspace: snap.workspace, onSaved: props.refresh }) : null,
          typeof snap.compactAfterReview === 'boolean' ? h(CompactAfterReview, { on: snap.compactAfterReview, onSaved: props.refresh }) : null,
          snap.schedule ? h(Schedule, { schedule: snap.schedule, onSaved: props.refresh }) : null,
          // Always listed, even with nothing allowed yet: a missing card leaves a new user nowhere to start.
          snap.modules ? h(Modules, { modules: snap.modules, running: snap.running, onSaved: props.refresh }) : null))
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

    /** 只认最后一次发出的请求：条件变了，迟到的旧回复不能盖掉新结果。 */
    function latest() {
      var n = 0
      return { next: function () { return ++n }, current: function (id) { return id === n } }
    }
    function searchMemory(guard, path, query, done, fail) {
      var id = guard.next()
      return api(path + '?' + query).then(function (b) { if (guard.current(id)) done(b) }, function (e) { if (guard.current(id)) fail(e) })
    }
    function zoneOffsetMs(at, zone) {
      var parts = {}
      new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(at)).forEach(function (p) { parts[p.type] = p.value })
      return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - Math.floor(at / 1000) * 1000
    }
    /** 配置时区里某一天的零点，写成 UTC 的 ISO 时间；date 是 YYYY-MM-DD，plusDays 取后面的日子。 */
    function dayStartIso(date, zone, plusDays) {
      var guess = Date.parse(date + 'T00:00:00Z') + (plusDays || 0) * 86400000
      var ms = guess - zoneOffsetMs(guess, zone)
      ms = guess - zoneOffsetMs(ms, zone)
      return new Date(ms).toISOString()
    }
    var KINDS = [['conversation', '聊天'], ['diary', '日记']]
    var basisLabel = { message: '发言时间', diaryDate: '日记日期', fileObserved: '看到文件的时间' }
    /** 筛选条件变成 memory/find 的查询串；结束日期含当天。 */
    function memoryQuery(f, zone, cursor) {
      var q = []
      function add(k, v) { q.push(k + '=' + encodeURIComponent(v)) }
      if (f.query) add('query', f.query)
      if (f.kinds && f.kinds.length) add('kinds', f.kinds.join(','))
      if (f.from) add('from', dayStartIso(f.from, zone))
      if (f.to) add('to', dayStartIso(f.to, zone, 1))
      if (f.sourceId) add('sourceId', f.sourceId)
      if (f.turnId) add('turnId', f.turnId)
      if (f.linkedTo) add('linkedTo', f.linkedTo)
      if (f.order === 'oldest') add('order', 'oldest')
      add('limit', '20')
      if (cursor) add('cursor', cursor)
      return q.join('&')
    }
    function MemorySearch(props) {
      var zone = props.zone
      var formState = useState({ query: '', kinds: [], from: '', to: '', sourceId: '', turnId: '', linkedTo: '', order: 'newest' }), form = formState[0], setForm = formState[1]
      var resultState = useState(null), result = resultState[0], setResult = resultState[1]
      var busyState = useState(false), busy = busyState[0], setBusy = busyState[1]
      var errState = useState(''), err = errState[0], setErr = errState[1]
      var openState = useState(null), open = openState[0], setOpen = openState[1]
      var guards = useRef(null)
      if (!guards.current) guards.current = { find: latest(), read: latest() }
      function change(patch) { setForm(Object.assign({}, form, patch)); setResult(null); setErr(''); guards.current.find.next() }
      function run(next, cursor) {
        setBusy(true); setErr('')
        searchMemory(guards.current.find, 'memory/find', memoryQuery(next, zone, cursor), function (b) {
          setBusy(false); setResult(cursor && result ? { items: result.items.concat(b.items), nextCursor: b.nextCursor, coverage: b.coverage, search: b.search } : b)
        }, function (e) {
          setBusy(false)
          if (e && e.code === 'cursorExpired') { setResult(null); setErr('资料或范围有变化，请重新查询。') } else setErr('查找失败：' + (e.message || e))
        })
      }
      function show(item, offset) {
        setOpen({ ref: item.ref, title: item.title, loading: true, content: '' })
        searchMemory(guards.current.read, 'memory/read', 'ref=' + encodeURIComponent(item.ref) + (offset ? '&offset=' + offset : ''), function (b) {
          setOpen({ ref: item.ref, title: item.title, loading: false, content: (offset && open && open.ref === item.ref ? open.content : '') + b.content, nextOffset: b.nextOffset, total: b.totalChars, version: b.version, turnId: b.turnId, current: b.current, item: item })
        }, function (e) {
          setOpen({ ref: item.ref, title: item.title, loading: false, content: '', error: e.code === 'sourceChanged' ? '这条聊天后来被修订过，旧版正文没有保留。' : String(e.message || e) })
        })
      }
      function kindsToggle(kind) { change({ kinds: form.kinds.indexOf(kind) >= 0 ? form.kinds.filter(function (k) { return k !== kind }) : form.kinds.concat([kind]) }) }
      var cov = result && result.coverage
      return h('div', { className: 'dw-pane' },
        h(Card, { title: '总归档查找' },
          h('div', { className: 'dw-muted' }, '查她的聊天原文和日记。关键词按原文字面匹配、区分大小写；这里只读。'),
          h('form', { className: 'dw-setting', onSubmit: function (e) { if (e && e.preventDefault) e.preventDefault(); run(form) } },
            h('input', { type: 'text', 'aria-label': '关键词', placeholder: '关键词（可留空，按时间翻）', value: form.query, style: { maxWidth: 'none' }, onChange: function (e) { change({ query: e.target.value }) } }),
            h('button', { className: 'dw-btn primary', type: 'submit', disabled: busy }, busy ? '查找中…' : '查找')),
          h('div', { className: 'dw-setting' }, KINDS.map(function (k) {
            return h('label', { key: k[0], className: 'dw-muted' }, h('input', { type: 'checkbox', checked: form.kinds.indexOf(k[0]) >= 0, onChange: function () { kindsToggle(k[0]) } }), ' ' + k[1])
          })),
          h('div', { className: 'dw-setting' },
            h('label', { className: 'dw-muted' }, '从 ', h('input', { type: 'date', value: form.from, onChange: function (e) { change({ from: e.target.value }) } })),
            h('label', { className: 'dw-muted' }, '到 ', h('input', { type: 'date', value: form.to, onChange: function (e) { change({ to: e.target.value }) } })),
            h('select', { value: form.order, 'aria-label': '排序', onChange: function (e) { change({ order: e.target.value }) } }, h('option', { value: 'newest' }, '新的在前'), h('option', { value: 'oldest' }, '旧的在前'))),
          form.sourceId || form.turnId || form.linkedTo ? h('div', { className: 'dw-setting' },
            form.sourceId ? h('button', { className: 'dw-btn', onClick: function () { change({ sourceId: '' }) } }, '来源：' + form.sourceId + ' ×') : null,
            form.turnId ? h('button', { className: 'dw-btn', onClick: function () { change({ turnId: '', order: 'oldest' }) } }, '同一轮：' + form.turnId + ' ×') : null,
            form.linkedTo ? h('button', { className: 'dw-btn', onClick: function () { change({ linkedTo: '' }) } }, '只看关联的内容 ×') : null) : null,
          err ? h('div', { className: 'dw-bad', role: 'alert' }, err) : null,
          cov && cov.state !== 'ready' ? h('div', { className: 'dw-muted', role: 'status' }, '有来源没能读到，零结果不代表没发生过：', list(cov.failures).map(function (f) { return ' ' + f.sourceId + '：' + f.message }).join('；')) : null,
          result ? h('div', { className: 'dw-muted' }, result.items.length ? '已显示 ' + result.items.length + ' 条' : '没有找到。' + (cov && cov.state === 'ready' ? '（范围内完整查过了）' : '')) : null,
          result ? result.items.map(function (item) {
            return h('div', { className: 'dw-hit', key: item.ref },
              h('div', { className: 'dw-muted' }, [(KINDS.filter(function (k) { return k[0] === item.kind })[0] || [0, item.kind])[1], item.title, item.time + '（' + (basisLabel[item.timeBasis] || item.timeBasis) + '）', item.current ? '' : '旧版本'].filter(Boolean).join(' · ')),
              h('div', { style: { overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' } }, item.excerpt),
              h('div', { className: 'dw-setting' },
                h('button', { className: 'dw-btn', onClick: function () { show(item, 0) } }, '读原文'),
                h('button', { className: 'dw-btn', onClick: function () { change({ linkedTo: item.ref }); run(Object.assign({}, form, { linkedTo: item.ref })) } }, '看关联'),
                item.turnId ? h('button', { className: 'dw-btn', onClick: function () { var next = Object.assign({}, form, { turnId: item.turnId, order: 'oldest' }); change({ turnId: item.turnId, order: 'oldest' }); run(next) } }, '同一轮') : null,
                h('button', { className: 'dw-btn', onClick: function () { var next = Object.assign({}, form, { sourceId: item.sourceId }); change({ sourceId: item.sourceId }); run(next) } }, '只看这个来源')),
              open && open.ref === item.ref ? h('div', null,
                open.loading ? h('div', { className: 'dw-muted' }, '读取中…') : null,
                open.error ? h('div', { className: 'dw-bad', role: 'alert' }, open.error) : null,
                open.content ? h('pre', { className: 'dw-diary' }, open.content) : null,
                open.nextOffset ? h('button', { className: 'dw-btn', onClick: function () { show(item, open.nextOffset) } }, '继续读（共 ' + open.total + ' 字）') : null) : null)
          }) : null,
          result && result.nextCursor ? h('button', { className: 'dw-btn', disabled: busy, onClick: function () { run(form, result.nextCursor) } }, '更多') : null))
    }

    /**
     * 小屋的天气由你来定，她 look 时看得到，刚变的那几个小时会在「别处的动静」里说一次。下雨时菜圃不用浇，晾着的衣服
     * 会淋湿，雨停了才开始干。
     */
    function Weather(props) {
      var busyState = useState(false), busy = busyState[0], setBusy = busyState[1]
      var msgState = useState(''), msg = msgState[0], setMsg = msgState[1]
      var now = props.now || 'sunny'
      function choose(next) {
        if (next === now) return
        setBusy(true); setMsg('')
        post('cottage/weather', { weather: next }).then(function () { props.refresh() }, function (e) { setMsg(String(e.message || e)) }).then(function () { setBusy(false) })
      }
      return h('div', { className: 'dw-setting' },
        h('span', null, h('b', null, '天气'), h('span', { className: 'dw-muted' }, ' · 你来定，她看得到')),
        h('span', { className: 'dw-seg', role: 'group', 'aria-label': '小屋的天气' }, [['sunny', '晴'], ['cloudy', '阴'], ['rain', '雨']].map(function (option) {
          return h('button', { key: option[0], className: now === option[0] ? 'on' : '', disabled: busy, 'aria-pressed': now === option[0], onClick: function () { choose(option[0]) } }, option[1])
        })),
        h('div', { className: 'dw-muted', style: { flexBasis: '100%' } }, '下雨时菜圃不用浇，晾着的衣服会淋湿，雨停了才开始干。'),
        h(Status, { msg: msg }))
    }
    /**
     * 她的小屋：另装的一个包（dsh-world-room），装进 profile 后在这个世界自己的前缀下打开，只读快照，可以全屏看。
     * 没装、或装的版本和这一版插件对不上时，这里只给说明和安装按钮；room 为 null 是旧快照，按没装算。
     */
    function Room(props) {
      var room = props.room
      var frame = useRef(null)
      var busyState = useState(false), busy = busyState[0], setBusy = busyState[1]
      var msgState = useState(''), msg = msgState[0], setMsg = msgState[1]
      function full() { var el = frame.current; if (el && el.requestFullscreen) el.requestFullscreen() }
      function install() {
        setBusy(true); setMsg('')
        post('room/install', {}).then(function () { props.refresh() }, function (e) { setMsg(String(e.message || e)) }).then(function () { setBusy(false) })
      }
      if (!room || !room.current) {
        var update = room && room.installed
        return h('div', { className: 'dw-pane' },
          h('div', null, update
            ? '装着的小屋是 ' + room.version + '，这一版插件要 ' + room.wanted + '，更新后才能打开。'
            : '小屋是另装的一部分：她的房间画成一间三渲二的小屋，她做事、休息、闲逛都在里面。约 10 MB，装进当前 profile，装一次所有世界都能用；不装也不影响别的功能。'),
          room && room.error ? h('div', { className: 'dw-bad' }, room.error) : null,
          h('div', null, h('button', { className: 'dw-btn primary', disabled: busy, onClick: install }, busy ? '正在安装…' : update ? '更新小屋' : '安装小屋')),
          h(Status, { msg: msg }))
      }
      return h('div', { className: 'dw-pane' },
        h('iframe', { ref: frame, className: 'dw-room', src: prefix + '/room/', title: (props.name || '她') + '的小屋', allow: 'fullscreen' }),
        h('div', null, h('button', { className: 'dw-btn', onClick: full }, '全屏'), h('span', { className: 'dw-muted' }, ' 拖动转一转，滚轮缩放，点家具凑近看。')),
        h('div', { className: 'dw-muted' }, room.life ? (props.name || '她') + '住在这里：她走到哪、锅里煮着什么、晾着的衣服和菜圃，都是她自己做的。' : '现在只是画面：在概览的「接入」里打开「她住进小屋」，她就会自己住进来。'),
        room.life ? h(Weather, { now: room.life.weather && room.life.weather.kind, refresh: props.refresh }) : null)
    }

    var TABS = [['overview', '概览'], ['room', '小屋'], ['persona', '人设'], ['prompt', '世界提示词'], ['records', '记录'], ['archive', '档案'], ['photos', '相册'], ['qq', 'QQ'], ['wechat', '微信'], ['computer', '她的电脑']]
    /** 一份快照的画面；life 为 null（停着，或生活线没能启动）或缺了哪一块都不会崩。 */
    function View(props) {
      var snap = props.snap, error = props.error
      var tabState = useState('overview'), tab = tabState[0], setTab = tabState[1]
      var panelState = useState(null), panel = panelState[0], setPanel = panelState[1]
      var busyState = useState(false), busy = busyState[0], setBusy = busyState[1]
      var failState = useState(null), fail = failState[0], setFail = failState[1]
      var running = snap.running === true, desktop = snap.modules && snap.modules.desktop
      var name = snap.name && snap.name !== 'TA' ? snap.name : ''
      var addingState = useState(false), adding = addingState[0], setAdding = addingState[1]
      var newIdState = useState(''), newId = newIdState[0], setNewId = newIdState[1]
      var newNameState = useState(''), newName = newNameState[0], setNewName = newNameState[1]
      var addMsgState = useState(''), addMsg = addMsgState[0], setAddMsg = addMsgState[1]
      var addBusyState = useState(false), addBusy = addBusyState[0], setAddBusy = addBusyState[1]
      /** 新增的世界写进 profile 配置；宿主启动时才读配置，所以要重启 DSH 后才出现。 */
      function add() {
        if (!newId.trim()) { setAddMsg('请填世界的名字'); return }
        setAddBusy(true); setAddMsg('')
        addWorld(newId.trim(), newName.trim()).then(function (added) {
          setAddBusy(false); setNewId(''); setNewName('')
          setAddMsg('已添加「' + added.worldId + '」。重启 DSH 后在最上面选它，再按「开始」。')
        }, function (e) { setAddBusy(false); setAddMsg('添加失败：' + (e.message || e)) })
      }
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
          h('div', { className: 'dw-acts' },
            h('button', { className: 'dw-ghost' + (adding ? ' on' : ''), onClick: function () { setAdding(!adding); setAddMsg('') } }, '＋ 新增世界'),
            h('button', { className: 'dw-power' + (running ? ' stop' : ''), disabled: busy, onClick: power }, busy ? '……' : running ? '停止' : '开始')),
          adding ? h('div', { className: 'dw-newworld' },
            h('input', { type: 'text', 'aria-label': '世界的名字', placeholder: '世界的名字：字母、数字、- _', value: newId, onChange: function (e) { setNewId(e.target.value) } }),
            h('input', { type: 'text', 'aria-label': '她叫什么', placeholder: '她叫什么（可以以后再填）', value: newName, onChange: function (e) { setNewName(e.target.value) } }),
            h('button', { className: 'dw-btn primary', disabled: addBusy, onClick: add }, addBusy ? '添加中…' : '添加'),
            h('button', { className: 'dw-btn', onClick: function () { setAdding(false); setAddMsg('') } }, '取消'),
            h('div', { className: 'dw-hint' }, addMsg ? h(Status, { msg: addMsg }) : '每个世界有自己的家、记忆和人设。添加后重启 DSH，在最上面选它，再按「开始」。')) : null),
        h('nav', { className: 'dw-tabs' }, TABS.map(function (t) { return h('button', { key: t[0], className: 'dw-tab' + (tab === t[0] ? ' on' : ''), onClick: function () { setTab(t[0]) } }, t[1]) })),
        tab === 'persona' || tab === 'prompt' ? h('div', { className: 'dw-pane' },
          h(HomeApply, { snap: snap, refresh: props.refresh }),
          tab === 'persona' ? h(PersonaEditor, { onSaved: props.refresh }) : h(PromptEditor, { merge: snap.promptMerge, running: running, refresh: props.refresh })) : null,
        tab === 'overview' ? h(Overview, { snap: snap, refresh: props.refresh }) : null,
        tab === 'room' ? h(Room, { name: name, room: snap.room, refresh: props.refresh }) : null,
        tab === 'records' ? h(Records, { snap: snap, tick: props.tick }) : null,
        tab === 'archive' ? h(MemorySearch, { zone: snap.timeZone }) : null,
        tab === 'photos' ? h(PhotoAlbum, { tick: props.tick, zone: snap.timeZone }) : null,
        tab === 'qq' ? h('div', { className: 'dw-pane' }, snap.native
          ? h(Qq, { native: snap.native, onSaved: props.refresh, onNeedPassword: setPanel })
          : h(Card, { title: 'QQ' }, h('div', { className: 'dw-muted' }, 'QQ 通道未开启，请在概览的「接入」中检查配置和开关。'))) : null,
        tab === 'wechat' ? h('div', { className: 'dw-pane' }, snap.wechat
          ? h(Wechat, { wechat: snap.wechat, zone: snap.timeZone, onSaved: props.refresh })
          : h(Card, { title: '微信' }, h('div', { className: 'dw-muted' }, '微信通道未开启，请在概览的「接入」中检查配置和开关。'))) : null,
        tab === 'computer' ? h('div', { className: 'dw-pane' }, snap.computer
          ? h(Computer, { computer: snap.computer, zone: snap.timeZone })
          : h(Card, { title: '她的浏览器' }, h('div', { className: 'dw-muted' }, '她的浏览器没有开启，请在概览的「接入」中检查配置和开关。')),
          // The inbox exists only where she can use the computer (Windows); its list can be set before that is on.
          desktop && desktop.available && desktop.inbox ? h(Inbox, { inbox: desktop.inbox, listening: desktop.running === true, onSaved: props.refresh }) : null) : null,
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

    return { Console: Console, test: { UpdateNotice: UpdateNotice, Inbox: Inbox, TemplateGaps: TemplateGaps, PromptMerge: PromptMerge, Room: Room, Budget: Budget, Health: Health, Memory: Memory, MemorySearch: MemorySearch, latest: latest, searchMemory: searchMemory, memoryQuery: memoryQuery, dayStartIso: dayStartIso, WorkspacePermission: WorkspacePermission, CompactAfterReview: CompactAfterReview, Schedule: Schedule, Modules: Modules, Computer: Computer, HomeApply: HomeApply, PhotoAlbum: PhotoAlbum, Wechat: Wechat, Activity: Activity, Diary: Diary, Qq: Qq, Panel: Panel, View: View, Overview: Overview, PersonaEditor: PersonaEditor, PromptEditor: PromptEditor, loadSnapshot: loadSnapshot, renderPersona: renderPersona } }
  }

  async function loadWorldIds() {
    var ids = [], offset = 0
    do {
      var response = await fetch(worldsPath + '?limit=100&offset=' + offset, { cache: 'no-store' })
      if (!response.ok) throw new Error('HTTP ' + response.status)
      var page = await response.json()
      ids.push.apply(ids, page.worldIds)
      offset = page.nextOffset
    } while (offset !== null)
    return ids
  }
  /** 往 profile 的配置里加一个世界；宿主启动时才读配置，所以要重启后才出现。 */
  async function addWorld(worldId, companionName) {
    var response = await fetch(worldsPath, { method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json', 'x-dsh-world': '1' }, body: JSON.stringify({ worldId: worldId, companionName: companionName }) })
    var body = await response.json().catch(function () { return {} })
    if (!response.ok) throw new Error(body.error || 'HTTP ' + response.status)
    return body
  }

  window.__ModuleLoader__.load({
    id: 'dsh-world',
    factory: function (require) {
      var react = require('react')
      var h = react.createElement
      function SelectedWorld(props) {
        var components = react.useState(function () { return worldConsole(react, props.worldId) })[0]
        return h(components.Console)
      }
      function WorldSettings() {
        var idsState = react.useState(null), ids = idsState[0], setIds = idsState[1]
        var selectedState = react.useState(''), selected = selectedState[0], select = selectedState[1]
        var errorState = react.useState(''), error = errorState[0], setError = errorState[1]
        react.useEffect(function () {
          var alive = true
          loadWorldIds().then(function (items) {
            if (alive) { setIds(items); select(items[0] || '') }
          }, function (e) { if (alive) setError(String(e.message || e)) })
          return function () { alive = false }
        }, [])
        if (error) return h('p', { role: 'alert' }, '读取世界列表失败：' + error)
        if (!ids) return h('p', null, '读取中…')
        if (!selected) return h('p', null, '没有已加载的世界')
        return h('div', null,
          ids.length > 1 ? h('label', null, '世界 ', h('select', { value: selected, onChange: function (event) { select(event.target.value) } },
            ids.map(function (id) { return h('option', { key: id, value: id }, id) }))) : null,
          h(SelectedWorld, { key: selected, worldId: selected }))
      }

      var exports = { inject: ['slots'] }
      Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
      exports.apply = function (ctx) {
        ctx.slots.inject('settings.section', function () {
          return ctx.slots.register({ name: 'settings.section', id: 'world-console', order: 28, label: '世界控制台' }, function () { return h(WorldSettings) })
        })
      }
      Object.defineProperty(exports, '__test', { value: function (worldId) { return worldConsole(react, worldId).test } })
      return exports
    }
  })
})()
