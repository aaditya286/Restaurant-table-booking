(function () {
  const R = window.Reserve;
  const { $, esc, api, fmtTime, fmtDate } = R;
  R.header('manager');

  const st = { rid: null, tables: [], cols: 5, selected: null };
  const say = (t, ok) => { const m = $('#mmsg'); m.textContent = t || ''; m.className = 'msg' + (ok ? ' ok' : ''); };
  const seatOptions = (sel) => [1, 2, 3, 4, 5, 6, 8, 10, 12].map(n => `<option value="${n}" ${n === sel ? 'selected' : ''}>${n} seats</option>`).join('');

  /* ---- passcode gate ---- */
  function showPanel() {
    $('#gate').classList.add('hidden');
    $('#panel').classList.remove('hidden');
    start();
  }
  function lock() {
    sessionStorage.removeItem('reserve_mgr');
    $('#panel').classList.add('hidden');
    $('#gate').classList.remove('hidden');
  }
  $('#gateForm').addEventListener('submit', async e => {
    e.preventDefault();
    $('#gateMsg').textContent = '';
    try {
      const { token } = await api('/api/manager/login', { method: 'POST', body: { passcode: $('#pass').value } });
      sessionStorage.setItem('reserve_mgr', token);
      $('#pass').value = '';
      showPanel();
    } catch (err) { $('#gateMsg').textContent = err.message; }
  });
  $('#mgrOut').onclick = lock;
  if (sessionStorage.getItem('reserve_mgr')) showPanel();

  /* ---- manager workspace ---- */
  let started = false;
  async function start() {
    if (!started) {
      started = true;
      const slot = R.defaultSlot();
      $('#mdate').value = slot.date;
      R.fillTimes($('#mtime'), slot.time);
      $('#addSeats').innerHTML = seatOptions(4);
      ['mdate', 'mtime'].forEach(id => $('#' + id).addEventListener('change', refresh));
      $('#mrest').addEventListener('change', () => { st.rid = Number($('#mrest').value); st.selected = null; refresh(); });
      $('#addForm').addEventListener('submit', addTable);
      R.live(() => refresh(true));
    }
    const rs = await api('/api/restaurants');
    $('#mrest').innerHTML = rs.map(r => `<option value="${r.id}">${esc(r.name)}, ${esc(r.area)}</option>`).join('');
    st.rid = st.rid || (rs[0] && rs[0].id);
    $('#mrest').value = st.rid;
    refresh();
  }

  async function guard(fn) {
    try { return await fn(); }
    catch (e) {
      if (e.status === 401) { lock(); $('#gateMsg').textContent = 'Your session ended. Enter the passcode again.'; return; }
      say(e.message);
    }
  }

  const slotQuery = () => new URLSearchParams({ date: $('#mdate').value, time: $('#mtime').value });
  const selectedTable = () => st.tables.find(t => t.id === st.selected);

  async function refresh(fromLive) {
    if (!st.rid) return;
    await guard(async () => {
      const d = await api(`/api/manager/restaurants/${st.rid}/floor?${slotQuery()}`);
      st.tables = d.tables; st.cols = d.cols;
      if (!selectedTable()) st.selected = null;
      drawFloor();
      if (!(fromLive === true && $('#edit').contains(document.activeElement))) drawEdit();
      const t = await api(`/api/manager/bookings/today?restaurant_id=${st.rid}`);
      drawToday(t);
    });
  }

  function drawFloor() {
    R.renderFloor($('#mfloor'), st.tables, { manager: true, selectedId: st.selected, cols: st.cols, onPick: id => { st.selected = id; say(''); drawFloor(); drawEdit(); } });
  }

  function drawEdit() {
    const t = selectedTable();
    const box = $('#edit');
    if (!t) { box.innerHTML = '<p class="muted small" style="margin:0">Select a table on the plan to edit it.</p>'; return; }
    const when = `${fmtDate($('#mdate').value)}, ${fmtTime($('#mtime').value)}`;
    let slotBlock;
    if (t.state === 'booked') {
      slotBlock = `<p class="small" style="margin:0">Booked at ${when} by ${esc(t.booking.guest_name)}, party of ${t.booking.party_size} (${esc(t.booking.ref)}).</p>
        <button class="btn danger small" id="cancelBooking" type="button">Cancel this booking</button>`;
    } else if (t.state === 'blocked') {
      slotBlock = `<p class="small" style="margin:0">Blocked at ${when}. Guests cannot book it.</p>
        <button class="btn ghost small" id="freeBtn" type="button">Free for this time</button>`;
    } else {
      slotBlock = `<p class="small" style="margin:0">Vacant at ${when}.</p>
        <button class="btn ghost small" id="blockBtn" type="button">Block for this time</button>`;
    }
    box.innerHTML = `
      <h2>Table ${esc(t.label)}</h2>
      <form id="editForm" class="stack" novalidate>
        <div><label for="eLabel">Name</label><input id="eLabel" maxlength="12" value="${esc(t.label)}"></div>
        <div><label for="eSeats">Seats</label><select id="eSeats">${seatOptions(t.seats)}</select></div>
        <button class="btn small" type="submit">Save changes</button>
      </form>
      <div class="stack" style="border-top:1px solid var(--line);padding-top:16px">${slotBlock}</div>
      <div style="border-top:1px solid var(--line);padding-top:16px"><button class="btn danger small" id="removeBtn" type="button">Remove table</button></div>`;

    $('#editForm').onsubmit = e => {
      e.preventDefault();
      guard(async () => {
        await api(`/api/manager/tables/${t.id}`, { method: 'PATCH', body: { label: $('#eLabel').value, seats: Number($('#eSeats').value) } });
        say('Table updated.', true); await refresh();
      });
    };
    const slotBody = { date: $('#mdate').value, time: $('#mtime').value };
    const on = (id, fn) => { const b = $('#' + id); if (b) b.onclick = () => guard(async () => { await fn(); await refresh(); }); };
    on('blockBtn', async () => { await api(`/api/manager/tables/${t.id}/block`, { method: 'POST', body: slotBody }); say('Table blocked for this time.', true); });
    on('freeBtn', async () => { await api(`/api/manager/tables/${t.id}/free`, { method: 'POST', body: slotBody }); say('Table is free for this time.', true); });
    on('cancelBooking', async () => {
      if (!confirm('Cancel this booking? The guest will see it as cancelled.')) return;
      await api(`/api/manager/bookings/${t.booking.ref}/cancel`, { method: 'POST' }); say('Booking cancelled.', true);
    });
    on('removeBtn', async () => {
      if (!confirm(`Remove table ${t.label}? Upcoming bookings on it will be cancelled.`)) return;
      await api(`/api/manager/tables/${t.id}`, { method: 'DELETE' }); st.selected = null; say('Table removed.', true);
    });
  }

  function addTable(e) {
    e.preventDefault();
    guard(async () => {
      await api(`/api/manager/restaurants/${st.rid}/tables`, { method: 'POST', body: { label: $('#addLabel').value, seats: Number($('#addSeats').value) } });
      $('#addLabel').value = ''; say('Table added.', true); await refresh();
    });
  }

  function drawToday(d) {
    $('#todayNote').textContent = `${fmtDate(d.date)}, confirmed bookings at this restaurant.`;
    if (!d.bookings.length) { $('#today').innerHTML = '<p class="muted">No bookings today.</p>'; return; }
    $('#today').innerHTML = `<table class="list"><thead><tr><th>Time</th><th>Table</th><th>Guest</th><th>Guests</th><th>Ref</th><th></th></tr></thead><tbody>
      ${d.bookings.map(b => `<tr><td>${fmtTime(b.start)}</td><td>${esc(b.table_label)}</td><td>${esc(b.guest_name)}${b.source === 'claude' ? ' <span class="muted small">via Claude</span>' : ''}</td><td>${b.party_size}</td><td>${esc(b.ref)}</td>
      <td><button class="btn danger small" data-ref="${esc(b.ref)}" type="button">Cancel</button></td></tr>`).join('')}</tbody></table>`;
    $('#today').querySelectorAll('button[data-ref]').forEach(b => {
      b.onclick = () => guard(async () => {
        if (!confirm('Cancel this booking?')) return;
        await api(`/api/manager/bookings/${b.dataset.ref}/cancel`, { method: 'POST' }); say('Booking cancelled.', true); await refresh();
      });
    });
  }
})();
