(function () {
  const R = window.Reserve;
  const { $, esc, api, fmtTime, fmtDate } = R;
  if (!R.requireGuest()) return;
  R.header('book');

  const slot = R.defaultSlot();
  const today = R.nowIST().date;
  const st = { restaurants: [], rid: null, tables: [], cols: 5, end: '', selected: null };

  $('#date').min = today; $('#date').value = slot.date;
  R.fillTimes($('#time'), slot.time);
  $('#party').innerHTML = Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}">${i + 1} ${i ? 'guests' : 'guest'}</option>`).join('');
  $('#party').value = '2';

  const party = () => Number($('#party').value);
  const say = (t, ok) => { const m = $('#msg'); m.textContent = t || ''; m.className = 'msg' + (ok ? ' ok' : ''); };

  function renderRests() {
    $('#rests').innerHTML = st.restaurants.map(r => `
      <button type="button" class="rest" data-id="${r.id}" aria-pressed="${r.id === st.rid}">
        <b>${esc(r.name)}</b><span>${esc(r.area)}, ${esc(r.cuisine)}</span><span>Rated ${r.rating.toFixed(1)}</span>
      </button>`).join('');
    document.querySelectorAll('.rest').forEach(b => { b.onclick = () => { st.rid = Number(b.dataset.id); st.selected = null; renderRests(); refresh(); }; });
  }

  function renderSummary() {
    const t = st.tables.find(x => x.id === st.selected);
    const btn = $('#bookBtn');
    if (!t || t.state !== 'vacant' || t.seats < party()) {
      st.selected = null; btn.disabled = true;
      $('#pick').textContent = 'Choose a vacant table on the plan.';
      return;
    }
    btn.disabled = false;
    $('#pick').textContent = `Table ${t.label}, ${t.seats} seats. ${fmtDate($('#date').value)}, ${fmtTime($('#time').value)} to ${fmtTime(st.end)}.`;
  }

  async function refresh() {
    if (!st.rid) return;
    try {
      const q = new URLSearchParams({ date: $('#date').value, time: $('#time').value });
      const d = await api(`/api/restaurants/${st.rid}/floor?${q}`);
      st.tables = d.tables; st.cols = d.cols; st.end = d.end;
      $('#where').textContent = d.restaurant.address;
      say('');
    } catch (e) {
      st.tables = []; say(e.message);
    }
    renderFloor();
    renderSummary();
  }
  function renderFloor() {
    R.renderFloor($('#floor'), st.tables, { party: party(), selectedId: st.selected, cols: st.cols, onPick: id => { st.selected = id; renderFloor(); renderSummary(); } });
  }

  ['date', 'time', 'party'].forEach(id => $('#' + id).addEventListener('change', () => { st.selected = null; refresh(); }));

  $('#bookBtn').onclick = async () => {
    const btn = $('#bookBtn'); btn.disabled = true; say('');
    try {
      const b = await api('/api/bookings', { method: 'POST', body: { restaurant_id: st.rid, table_id: st.selected, date: $('#date').value, time: $('#time').value, party_size: party() } });
      location.href = `/confirmation?ref=${b.ref}`;
    } catch (e) {
      say(e.message); st.selected = null; refresh();
    }
  };

  R.live(refresh);
  api('/api/restaurants').then(rs => { st.restaurants = rs; st.rid = rs[0] && rs[0].id; renderRests(); refresh(); });
})();
