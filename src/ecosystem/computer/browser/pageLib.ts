// src/ecosystem/computer/browser/pageLib.ts
/**
 * Installed into her page on every call; a no-op while the same version is already there, which is what keeps an
 * element's number the same across reads until the page navigates. Roles and names are computed here once, so a read
 * and an anchor in one of her tools mean the same thing. The registry, roles, names and visibility rules are ported
 * from dsh-inner-browser-use's read.js (MIT, see ../NOTICE.md).
 */
export const PAGE_LIB = String.raw`(() => {
  const VERSION = 1;
  if (window.__dshWorld && window.__dshWorld.version === VERSION) return;
  const SELECTOR = 'a[href],button,input:not([type="hidden"]),select,textarea,summary,label[for],[contenteditable="true"],[tabindex]:not([tabindex="-1"]),[role="button"],[role="link"],[role="tab"],[role="checkbox"],[role="radio"],[role="switch"],[role="combobox"],[role="menuitem"],[role="option"],[role="textbox"],[role="searchbox"]';
  const refs = new Map(); const ids = new WeakMap(); let seq = Number(window.__dshBase) || 0;
  const clean = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const id = el => { const known = ids.get(el); if (known !== undefined && refs.get(known) === el) return known; seq += 1; ids.set(el, seq); refs.set(seq, el); return seq; };
  const roots = () => { const out = [document]; for (let i = 0; i < out.length; i++) for (const el of out[i].querySelectorAll('*')) if (el.shadowRoot) out.push(el.shadowRoot); return out; };
  // Walking the shadow roots is the costly part, so each exported call does it once and passes the list down.
  const all = (selector, scope, rs) => scope ? Array.from(scope.querySelectorAll(selector)) : rs.flatMap(root => Array.from(root.querySelectorAll(selector)));
  const role = el => {
    const explicit = el.getAttribute('role'); if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link'; if (tag === 'summary') return 'button'; if (tag === 'li') return 'listitem';
    if (tag === 'textarea' || el.isContentEditable) return 'textbox';
    if (tag === 'input') { const type = String(el.type || 'text'); return type === 'submit' || type === 'button' ? 'button' : type === 'checkbox' || type === 'radio' ? type : 'textbox'; }
    return tag;
  };
  const name = el => {
    const labelled = clean(String(el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).map(x => { const o = el.ownerDocument.getElementById(x); return o ? (o.innerText || o.textContent) : ''; }).join(' '));
    const label = el.labels && el.labels[0] ? clean(el.labels[0].innerText) : '';
    const value = el.tagName === 'INPUT' && el.type !== 'password' ? el.value : '';
    return clean(labelled || el.getAttribute('aria-label') || label || el.getAttribute('title') || el.getAttribute('placeholder') || el.innerText || value || el.getAttribute('alt') || '').slice(0, 140);
  };
  const shown = el => { const b = el.getBoundingClientRect(); if (b.width < 2 || b.height < 2) return false; const s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05; };
  const inView = el => { const b = el.getBoundingClientRect(); return b.bottom > 0 && b.right > 0 && b.top < innerHeight && b.left < innerWidth; };
  const matches = (el, a) => (!a.role || role(el) === a.role) && (!a.name || name(el).includes(a.name)) && (!a.text || (clean(el.textContent).includes(a.text) && clean(el.innerText).includes(a.text)));
  const visibleMatches = (a, scope, rs) => all(a.css || '*', scope, rs).filter(el => matches(el, a) && shown(el));
  // The innermost of nested matches: a page wraps the same words in several boxes.
  const innermost = hits => hits.filter(el => !hits.some(other => other !== el && el.contains(other)));
  const locate = (a, scope, rs) => innermost(visibleMatches(a, scope, rs))[a.nth || 0] || null;
  const find = ref => { const el = refs.get(ref); if (!el || !el.isConnected) { refs.delete(ref); return null; } return el; };
  const target = (t, rs) => t.ref !== undefined ? find(t.ref) : locate(t.anchor, null, rs);
  const reaches = (el, hit) => { for (let n = el; n; n = n.getRootNode().host) if (n === hit || n.contains(hit)) return true; return false; };
  const controls = (scope, rs) => {
    const out = [];
    for (const el of all(SELECTOR, scope, rs)) {
      if (!shown(el)) continue;
      const label = name(el);
      if (!label && !['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) continue;
      out.push({ ref: id(el), role: role(el), name: label, view: inView(el), value: el.tagName === 'INPUT' && el.type !== 'password' ? clean(el.value).slice(0, 80) : '' });
    }
    return out.sort((a, b) => Number(b.view) - Number(a.view));
  };
  const visibleText = (scope, budget) => {
    const parts = []; let used = 0;
    const walker = document.createTreeWalker(scope || document.querySelector('main, article, [role="main"]') || document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node && used < budget; node = walker.nextNode()) {
      const words = clean(node.nodeValue); const parent = node.parentElement;
      if (!words || !parent || !shown(parent) || !inView(parent)) continue;
      parts.push(words); used += words.length + 1;
    }
    return parts.join('\n');
  };
  window.__dshWorld = {
    version: VERSION,
    snapshot(ref, budget) {
      const scope = ref == null ? null : find(ref);
      if (ref != null && !scope) return { missing: true };
      return { url: location.href, title: document.title, controls: controls(scope, scope ? null : roots()), text: visibleText(scope, budget + 1) };
    },
    point(t) {
      const el = target(t, roots()); if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const b = el.getClientRects()[0] || el.getBoundingClientRect();
      const x = b.left + b.width / 2, y = b.top + b.height / 2;
      const hit = document.elementFromPoint(x, y);
      if (!(hit && reaches(el, hit))) return { covered: true, by: hit ? hit.tagName.toLowerCase() + ' ' + name(hit).slice(0, 30) : '页面之外' };
      return { x, y };
    },
    focus(t) {
      const el = target(t, roots()); if (!el) return 'missing';
      el.scrollIntoView({ block: 'center', behavior: 'instant' }); el.focus();
      if (!(document.activeElement === el || el.contains(document.activeElement))) return 'unfocusable';
      // Typing replaces what is there, as a person would after selecting it.
      try {
        if (el.select) el.select();
        else if (el.isContentEditable) { const range = document.createRange(); range.selectNodeContents(el); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range); }
      } catch (e) { /* an input type that cannot select: typing then adds */ }
      return 'ok';
    },
    has(c) {
      return (!c.text || (!!document.body && clean(document.body.innerText).includes(c.text))) && (!c.url || location.href.includes(c.url)) && (!c.anchor || !!locate(c.anchor, null, roots()));
    },
    extract(spec) {
      const rs = roots();
      // Every visible item in document order; nested items keep their parents.
      return visibleMatches(spec.list, null, rs).slice(0, spec.limit || 8).map(item => {
        const row = {};
        for (const key of Object.keys(spec.fields)) {
          const field = spec.fields[key];
          const el = !field.role && !field.name && !field.text && !field.css ? item : locate(field, item, null);
          row[key] = !el ? '' : field.attr ? clean(el.getAttribute(field.attr)).slice(0, 200) : clean(el.innerText || el.textContent).slice(0, 200);
        }
        return row;
      });
    },
  };
})()`;
