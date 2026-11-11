(function () {
  const { $, api, getGuest, setGuest, header } = window.Reserve;
  header();

  function showConnect(g) {
    $('#signin').classList.add('hidden');
    $('#connect').classList.remove('hidden');
    $('#mcpUrl').value = `${location.origin}/mcp?key=${g.key}`;
    header();
  }
  const existing = getGuest();
  if (existing) {
    // Make sure the saved key is still valid on this server.
    api('/api/me').then(showConnect).catch(() => setGuest(null));
  }

  $('#signinForm').addEventListener('submit', async e => {
    e.preventDefault();
    const msg = $('#signinMsg');
    msg.textContent = '';
    try {
      const g = await api('/api/guest', { method: 'POST', body: { name: $('#name').value, email: $('#email').value } });
      setGuest(g);
      showConnect(g);
    } catch (err) { msg.textContent = err.message; }
  });

  $('#copyBtn').onclick = async () => {
    const input = $('#mcpUrl');
    try { await navigator.clipboard.writeText(input.value); }
    catch { input.select(); document.execCommand('copy'); }
    $('#copyBtn').textContent = 'Copied';
    setTimeout(() => { $('#copyBtn').textContent = 'Copy link'; }, 1800);
  };
  $('#notYou').onclick = () => { setGuest(null); location.reload(); };
})();
