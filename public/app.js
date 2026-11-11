(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function nowIST() {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date()).map(x => [x.type, x.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, min: +p.hour * 60 + +p.minute };
  }
  const pad = n => String(n).padStart(2, '0');
  const fmtMin = m => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
  function fmtTime(t) {
    const [h, m] = t.split(':').map(Number);
    return `${h % 12 || 12}:${pad(m)} ${h >= 12 ? 'pm' : 'am'}`;
  }
  const fmtDate = d => new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
  function addDays(date, n) {
    const d = new Date(date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  // Sensible default slot: the next half hour today, or 7 pm tomorrow if the day is over.
  function defaultSlot() {
    const n = nowIST();
    let m = Math.ceil((n.min + 1) / 30) * 30;
    if (m > 22 * 60) return { date: addDays(n.date, 1), time: '19:00' };
    if (m < 12 * 60) m = 13 * 60;
    return { date: n.date, time: fmtMin(m) };
  }
  function fillTimes(sel, selected) {
    let h = '';
    for (let m = 12 * 60; m <= 22 * 60; m += 30) h += `<option value="${fmtMin(m)}">${fmtTime(fmtMin(m))}</option>`;
    sel.innerHTML = h;
    sel.value = selected;
  }

  const getGuest = () => { try { return JSON.parse(localStorage.getItem('reserve_guest')); } catch { return null; } };
  const setGuest = g => (g ? localStorage.setItem('reserve_guest', JSON.stringify(g)) : localStorage.removeItem('reserve_guest'));

  async function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json' };
    const g = getGuest(); if (g) headers['x-guest-key'] = g.key;
    const mt = sessionStorage.getItem('reserve_mgr'); if (mt) headers['x-manager-token'] = mt;
    const res = await fetch(path, { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
    let data = null; try { data = await res.json(); } catch { /* no body */ }
    if (!res.ok) { const e = new Error((data && data.error) || 'Something went wrong. Try again.'); e.status = res.status; throw e; }
    return data;
  }

  function requireGuest() {
    const g = getGuest();
    if (!g) { location.replace('/'); return null; }
    return g;
  }

  function header(active) {
    const g = getGuest();
    $('#top').innerHTML = `<div class="wrap bar"><a class="brand" href="/">Reserve</a><nav aria-label="Main">
      ${g ? `<a href="/book" ${active === 'book' ? 'aria-current="page"' : ''}>Book</a>` : ''}
      <a href="/manager" ${active === 'manager' ? 'aria-current="page"' : ''}>Manager</a>
      ${g ? `<span class="who">${esc(g.name)}</span><button class="link" id="signout" type="button">Sign out</button>` : ''}
    </nav></div>`;
    const so = $('#signout');
    if (so) so.onclick = () => { setGuest(null); location.href = '/'; };
  }

  // Live updates: call fn whenever the server reports a change.
  function live(fn) {
    let t;
    const run = () => { clearTimeout(t); t = setTimeout(fn, 150); };
    try {
      const es = new EventSource('/api/events');
      es.onmessage = run;
    } catch { /* fall back to polling below */ }
    setInterval(fn, 30000);
  }

  function renderFloor(el, tables, o = {}) {
    const { party = 1, selectedId = null, manager = false, cols = 5, onPick } = o;
    el.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    if (!tables.length) { el.innerHTML = '<p class="muted small" style="grid-column:1/-1;margin:0">No tables on this floor plan yet.</p>'; return; }
    el.innerHTML = tables.map(t => {
      const small = !manager && t.seats < party;
      let cls = 'tbl', meta = `${t.seats} seats`, disabled = false;
      if (t.state === 'booked') {
        cls += ' is-booked';
        meta = manager && t.booking ? `${t.booking.guest_name}, ${t.booking.party_size}` : 'Booked';
        disabled = !manager;
      } else if (t.state === 'blocked') {
        cls += ' is-blocked'; meta = manager ? 'Blocked' : 'Unavailable'; disabled = !manager;
      } else if (small) {
        cls += ' is-small'; disabled = true;
      }
      const pressed = selectedId === t.id;
      const status = t.state === 'vacant' ? (small ? 'too small for the party' : 'vacant') : t.state;
      return `<button type="button" class="${cls}" data-id="${t.id}" style="grid-column:${t.x};grid-row:${t.y}"
        aria-pressed="${pressed}" aria-label="Table ${esc(t.label)}, ${t.seats} seats, ${status}" ${disabled ? 'disabled' : ''}>
        <span class="n">${esc(t.label)}</span><span class="m">${esc(meta)}</span></button>`;
    }).join('');
    el.querySelectorAll('.tbl:not(:disabled)').forEach(b => { b.onclick = () => onPick && onPick(Number(b.dataset.id)); });
  }

  window.Reserve = { $, esc, api, nowIST, fmtTime, fmtDate, fmtMin, defaultSlot, fillTimes, getGuest, setGuest, requireGuest, header, live, renderFloor };
})();
