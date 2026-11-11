(function () {
  const R = window.Reserve;
  const { $, esc, api, fmtTime, fmtDate } = R;
  R.header();
  const ref = new URLSearchParams(location.search).get('ref');
  const view = $('#view');

  async function load() {
    if (!ref) { view.innerHTML = '<h1>No booking selected</h1><p><a class="btn" href="/book">Find a table</a></p>'; return; }
    let b;
    try { b = await api(`/api/bookings/${encodeURIComponent(ref)}`); }
    catch (e) { view.innerHTML = `<h1>Booking not found</h1><p class="muted">${esc(e.message)}</p><p><a class="btn" href="/book">Find a table</a></p>`; return; }
    const cancelled = b.status === 'cancelled';
    const signedIn = !!R.getGuest();
    view.innerHTML = `
      <h1>${cancelled ? 'Booking cancelled' : 'Booking confirmed'}</h1>
      <p class="lead">${cancelled ? 'This table is free again for other guests.' : `Your table at ${esc(b.restaurant)} is held for 90 minutes.`}</p>
      <div class="panel">
        <div class="ref" aria-label="Booking reference">${esc(b.ref)}</div>
        <dl class="facts">
          <dt>Restaurant</dt><dd>${esc(b.restaurant)}<br><span class="muted small">${esc(b.address)}</span></dd>
          <dt>Table</dt><dd>${esc(b.table_label)}, seats ${b.table_seats}</dd>
          <dt>Date</dt><dd>${fmtDate(b.date)}</dd>
          <dt>Time</dt><dd>${fmtTime(b.start)} to ${fmtTime(b.end)}</dd>
          <dt>Guests</dt><dd>${b.party_size}</dd>
          <dt>Booked for</dt><dd>${esc(b.guest_name)}${b.source === 'claude' ? ' <span class="muted small">(booked by Claude)</span>' : ''}</dd>
          <dt>Status</dt><dd class="${cancelled ? 'status-cancelled' : ''}">${cancelled ? 'Cancelled' : 'Confirmed'}</dd>
        </dl>
        <div class="msg" id="cmsg" role="alert"></div>
        <div class="actions">
          <a class="btn" href="/book">Book another</a>
          ${!cancelled && signedIn ? '<button class="btn danger" id="cancelBtn" type="button">Cancel booking</button>' : ''}
        </div>
        ${!cancelled && !signedIn ? '<p class="muted small" style="margin:16px 0 0"><a href="/">Sign in</a> as the guest who booked to cancel this booking.</p>' : ''}
      </div>`;
    const c = $('#cancelBtn');
    if (c) c.onclick = async () => {
      if (!confirm('Cancel this booking?')) return;
      try { await api(`/api/bookings/${encodeURIComponent(ref)}/cancel`, { method: 'POST' }); load(); }
      catch (e) { $('#cmsg').textContent = e.message; }
    };
  }
  load();
})();
