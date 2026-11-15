/* ===================== self-hosted extras =====================
   Sign-in, household invites, bank connection (Plaid), notifications, starting balances, home-screen app. */
const SV = { bank:null, members:null, invites:null, pushOn:null, busy:false };
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const C_ = window.BUDGET_CONFIG || {};

/* ---------- sign-in ---------- */
function showSignIn(step, email){
  $('#tabs').hidden = true; $('#fab').hidden = true;
  const app = $('#app');
  if (step !== 'code') {
    app.innerHTML = `<div style="max-width:420px;margin:8vh auto 0">
      <img src="icons/icon-192.png" alt="" width="64" height="64" style="border-radius:15px;margin-bottom:14px;box-shadow:0 6px 18px rgba(37,99,235,.25)">
      <h1>${esc(C_.appName || 'Budget')}</h1><p class="sub">Sign in with your email. We'll send you a 6-digit code — no password.</p>
      <div class="card stack" style="margin-top:16px"><div class="field"><label>Email</label><input id="si_email" type="email" autocomplete="email" inputmode="email" placeholder="you@example.com" value="${esc(email||'')}"></div>
      <button class="btn primary full" id="si_send">Email me a code</button></div>
      <p class="note" style="text-align:center;margin-top:14px">Invited by someone? Use the email they invited.</p></div>`;
    const go = async () => {
      const em = $('#si_email').value.trim().toLowerCase(); if (!/^\S+@\S+\.\S+$/.test(em)) return toast('Enter your email');
      $('#si_send').disabled = true; $('#si_send').textContent = 'Sending…';
      const sb = await Store.client();
      const { error } = await sb.auth.signInWithOtp({ email: em, options: { shouldCreateUser: true, emailRedirectTo: location.origin + location.pathname } });
      if (error) { toast(error.message); $('#si_send').disabled = false; $('#si_send').textContent = 'Email me a code'; return; }
      showSignIn('code', em);
    };
    $('#si_send').onclick = go; $('#si_email').onkeydown = e => { if (e.key === 'Enter') go(); };
    return;
  }
  app.innerHTML = `<div style="max-width:420px;margin:8vh auto 0"><h1>Check your email</h1><p class="sub">We sent a code to <b>${esc(email)}</b>. It can take a minute; check spam too.</p>
    <div class="card stack" style="margin-top:16px"><div class="field"><label>6-digit code</label><input id="si_code" inputmode="numeric" autocomplete="one-time-code" maxlength="8" style="font-size:26px;letter-spacing:.3em;text-align:center"></div>
    <button class="btn primary full" id="si_verify">Sign in</button><button class="btn ghost full" id="si_back">Use a different email</button></div></div>`;
  const verify = async () => {
    const code = $('#si_code').value.replace(/\D/g,''); if (code.length < 6) return toast('Enter the code from the email');
    $('#si_verify').disabled = true; $('#si_verify').textContent = 'Checking…';
    const sb = await Store.client();
    const { error } = await sb.auth.verifyOtp({ email, token: code, type: 'email' });
    if (error) { toast(error.message.includes('expired') ? 'That code expired. Send a new one.' : 'That code didn\'t work. Try again.'); $('#si_verify').disabled = false; $('#si_verify').textContent = 'Sign in'; return; }
    location.reload();
  };
  $('#si_verify').onclick = verify; $('#si_code').oninput = e => { if (e.target.value.replace(/\D/g,'').length === 6) verify(); };
  $('#si_back').onclick = () => showSignIn('email', email);
  setTimeout(() => $('#si_code') && $('#si_code').focus(), 50);
}

/* ---------- Household screen cards ---------- */
async function loadServerInfo(){
  if (SV.busy || !Store.sb || !Store.hid) return; SV.busy = true;
  try {
    const sb = Store.sb, hid = Store.hid;
    const [b, m, i, pc] = await Promise.all([
      sb.rpc('bank_status', { hid }), sb.from('members').select('user_id,email').eq('household_id', hid),
      sb.from('invites').select('email').eq('household_id', hid), sb.rpc('my_push_count', { hid })
    ]);
    SV.bank = b.data || []; SV.members = m.data || []; SV.invites = i.data || [];
    SV.pushOn = (pc.data || 0) > 0 && typeof Notification !== 'undefined' && Notification.permission === 'granted';
  } catch(e){} finally { SV.busy = false; }
  if (S.tab === 'settings') render();
}
function viewServerCards(){
  if (SV.bank === null) { loadServerInfo(); return `<h2>Bank & notifications</h2><div class="card empty">Loading…</div>`; }
  let h = `<h2>Who's in this budget</h2><div class="card">`;
  h += SV.members.map(m => `<div class="txn"><div class="dot">${esc((m.email||'?')[0].toUpperCase())}</div><div class="grow"><div class="d">${esc(m.email||'')}</div><div class="small muted">${m.user_id===S.me?'You':'Member'}</div></div></div>`).join('');
  h += SV.invites.map(v => `<div class="txn"><div class="dot">✉️</div><div class="grow"><div class="d">${esc(v.email)}</div><div class="small muted">Invited · joins when they sign in</div></div><button class="btn ghost" data-uninv="${esc(v.email)}" style="color:var(--warn)">Cancel</button></div>`).join('');
  h += `<div class="row" style="margin-top:10px"><input id="inv_email" type="email" inputmode="email" placeholder="Their email"><button class="btn" id="inv_go">Invite</button></div>
    <p class="note" style="margin-bottom:0">Then send them this link: <b>${esc(location.origin + location.pathname)}</b> and have them sign in with that email.</p></div>`;

  // bank
  h += `<h2>Bank connection</h2><div class="card">`;
  if (SV.bank.length) {
    h += SV.bank.map(b => `<div class="row"><div class="ticon" style="--c:#2563eb">🏦</div><div class="grow"><b>${esc(b.institution||'Your bank')}</b><div class="small ${b.last_error?'neg':'muted'}">${b.last_error ? 'Needs attention: '+esc(b.last_error) : b.last_sync ? 'Last checked '+new Date(b.last_sync).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}) : 'Connected'}</div><div class="small muted">Purchases from ${nice(b.start_date)} on</div></div></div>`).join('');
    h += `<div class="two" style="margin-top:12px"><button class="btn" id="bank_sync">Check for new purchases</button><button class="btn" id="bank_fix">${SV.bank.some(b=>b.last_error)?'Reconnect':'Connect another'}</button></div>
      <button class="btn ghost full danger" id="bank_unlink" style="margin-top:6px">Disconnect bank</button>`;
  } else {
    h += `<p class="note" style="margin-top:0">Connect your checking account so card purchases show up here on their own. The app only reads purchases; it can't move money, and it ignores your bank balance and deposits.</p>
      <button class="btn primary full" id="bank_link">Connect bank</button>`;
  }
  h += `</div>`;

  // notifications
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && typeof Notification !== 'undefined';
  h += `<h2>Notifications on this phone</h2><div class="card">`;
  if (isIOS && !isStandalone()) h += `<p class="note" style="margin-top:0">On iPhone, notifications only work from the home-screen app. In Safari tap <b>Share</b> → <b>Add to Home Screen</b>, open <b>Budget</b> from the home screen, sign in, and come back here.</p>`;
  else if (!supported) h += `<p class="note" style="margin-top:0">This browser can't show notifications. Try Chrome or Samsung Internet on Android, or the home-screen app on iPhone.</p>`;
  else if (SV.pushOn) h += `<div class="row"><span class="tag green">On ✓</span><span class="grow small muted">${myPerson()?`For purchases on ${esc(myPerson().name)}'s card`:'Tap “This is me” above so you only get your card\'s purchases'}</span></div>
      <div class="two" style="margin-top:12px"><button class="btn" id="push_test">Send a test</button><button class="btn" id="push_off">Turn off</button></div>`;
  else if (Notification.permission === 'denied') h += `<p class="note" style="margin-top:0">Notifications are blocked for this site. Allow them in your phone's settings for this app, then come back.</p>`;
  else h += `<p class="note" style="margin-top:0">Get a notification each time ${myPerson()?'your':'a'} card is used, asking which bucket it was for.</p><button class="btn primary full" id="push_on">Turn on notifications</button>`;
  h += `</div>`;
  return h;
}

function bindServer(){
  const on = (sel, ev, fn) => document.querySelectorAll(sel).forEach(el => el.addEventListener(ev, fn));
  const ig = $('#inv_go'); if (ig) ig.onclick = async () => {
    const em = $('#inv_email').value.trim().toLowerCase(); if (!/^\S+@\S+\.\S+$/.test(em)) return toast('Enter their email');
    const { error } = await Store.sb.from('invites').insert({ household_id: Store.hid, email: em });
    if (error && !/duplicate/.test(error.message)) return toast(error.message);
    toast('Invited ' + em); SV.bank = null; render();
  };
  on('[data-uninv]', 'click', async e => { await Store.sb.from('invites').delete().eq('household_id', Store.hid).eq('email', e.currentTarget.dataset.uninv); SV.bank = null; render(); });
  const bl = $('#bank_link'); if (bl) bl.onclick = () => connectBank();
  const bf = $('#bank_fix'); if (bf) bf.onclick = () => connectBank();
  const bs = $('#bank_sync'); if (bs) bs.onclick = async () => {
    bs.disabled = true; bs.textContent = 'Checking…';
    const { data, error } = await Store.fn('plaid', { action:'sync' });
    const n = (data && data.results || []).reduce((s,r)=>s+(r.added||0),0);
    toast(error ? 'Check failed: ' + (error.message||'error') : n ? `${n} purchase${n>1?'s':''} updated` : 'No new purchases yet');
    SV.bank = null; render();
  };
  const bu = $('#bank_unlink'); if (bu) bu.onclick = () => sheet(`<h3>Disconnect your bank?</h3><p class="note">Purchases already here stay. New ones won't come in until you connect again.</p><div class="two" style="margin-top:14px"><button class="btn" data-close>Cancel</button><button class="btn primary" id="ul_go" style="background:var(--warn);border-color:var(--warn)">Disconnect</button></div>`,
    el => el.querySelector('#ul_go').onclick = async () => { await Store.fn('plaid', { action:'unlink' }); closeSheet(); SV.bank = null; render(); toast('Bank disconnected'); });
  const po = $('#push_on'); if (po) po.onclick = () => enablePush(po);
  const pt = $('#push_test'); if (pt) pt.onclick = async () => { const { data, error } = await Store.fn('plaid', { action:'test_push', person:(myPerson()||{}).key||'' }); toast(error ? 'Test failed' : data && data.sent ? 'Test sent' : 'No phones signed up yet'); };
  const pf = $('#push_off'); if (pf) pf.onclick = async () => {
    try { const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.getSubscription(); if (sub) { await Store.sb.rpc('delete_push_sub', { ep: sub.endpoint }); await sub.unsubscribe(); } } catch(e){}
    SV.bank = null; render(); toast('Notifications off on this phone');
  };
  const so = $('#s_signout'); if (so) so.onclick = async () => { await Store.sb.auth.signOut(); location.reload(); };
  const ss = $('#s_start'); if (ss) ss.onclick = openStartSheet;
  const sbn = $('#startBanner'); if (sbn) sbn.onclick = openStartSheet;
}
// The Buckets screen banner is bound here too (bindView runs bindServer on every screen).

/* ---------- notifications ---------- */
function b64ToBytes(s){ const p = '='.repeat((4 - s.length % 4) % 4); const b = atob((s + p).replace(/-/g,'+').replace(/_/g,'/')); return Uint8Array.from([...b].map(c => c.charCodeAt(0))); }
async function enablePush(btn){
  try {
    btn.disabled = true; btn.textContent = 'Turning on…';
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('Notifications weren\'t allowed'); btn.disabled = false; btn.textContent = 'Turn on notifications'; return; }
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(C_.vapidPublicKey) });
    const j = sub.toJSON();
    const { error } = await Store.sb.rpc('save_push_sub', { hid: Store.hid, ep: j.endpoint, k_p256dh: j.keys.p256dh, k_auth: j.keys.auth, pkey: (myPerson()||{}).key || '' });
    if (error) throw error;
    toast('Notifications on'); SV.bank = null; render();
  } catch(e) { toast('Couldn\'t turn on notifications: ' + (e.message||e)); btn.disabled = false; btn.textContent = 'Turn on notifications'; }
}
// Keep this phone's notifications pointed at the right person after "This is me".
async function refreshPushPerson(){
  try {
    if (!('serviceWorker' in navigator) || Notification.permission !== 'granted') return;
    const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.getSubscription(); if (!sub) return;
    const j = sub.toJSON(); await Store.sb.rpc('save_push_sub', { hid: Store.hid, ep: j.endpoint, k_p256dh: j.keys.p256dh, k_auth: j.keys.auth, pkey: (myPerson()||{}).key || '' });
  } catch(e){}
}

/* ---------- bank connection (Plaid Link) ---------- */
function loadScript(src){ return new Promise((ok, bad) => { if (document.querySelector(`script[src="${src}"]`)) return ok(); const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = bad; document.head.appendChild(s); }); }
async function connectBank(resumeUri){
  try {
    let token = null;
    if (resumeUri) { try { token = localStorage.getItem('plaid_link_token'); } catch(e){} }
    if (!token) {
      toast('Opening secure bank login…');
      const { data, error } = await Store.fn('plaid', { action:'link_token' });
      if (error || !data || !data.link_token) { const msg = data && data.error || (error && (await error.context?.json?.().catch(()=>null))?.error) || (error && error.message) || 'error'; return toast('Couldn\'t start bank login: ' + msg); }
      token = data.link_token; try { localStorage.setItem('plaid_link_token', token); } catch(e){}
    }
    await loadScript('https://cdn.plaid.com/link/v2/stable/link-initialize.js');
    const handler = Plaid.create({
      token, receivedRedirectUri: resumeUri || undefined,
      onSuccess: async (public_token, md) => {
        toast('Saving your bank…');
        const { data, error } = await Store.fn('plaid', { action:'exchange', public_token, institution: md && md.institution && md.institution.name, start_date: today() });
        if (error || (data && data.error)) return toast('Couldn\'t save the bank: ' + ((data && data.error) || error.message));
        try { localStorage.removeItem('plaid_link_token'); } catch(e){}
        toast('Bank connected ✓'); SV.bank = null; if (resumeUri) history.replaceState(null, '', location.pathname + '#settings'); setTab('settings');
      },
      onExit: (err) => { if (err) toast(err.display_message || err.error_message || 'Bank login closed'); }
    });
    handler.open();
  } catch(e) { toast('Bank login failed: ' + (e.message||e)); }
}

/* ---------- starting balances ---------- */
function openStartSheet(){
  const cats = activeCats(); const b = balances().b;
  const cur = k => { const m = S.moves['start-'+k]; return m && !m.void ? m.amount : 0; };
  sheet(`<h3>Starting balances</h3><p class="note" style="margin-top:-6px">How much is already set aside in each bucket today. Leave blank for $0. Your weekly paydays add on top of this.</p>
    <div class="stack">${cats.map(([k,c]) => `<div class="row"><span class="ticon" style="--c:${catColor(k)};margin:0">${catIcon(c)}</span><span class="grow" style="font-weight:600">${esc(c.name)}</span><input data-start="${k}" inputmode="decimal" placeholder="0.00" value="${fmtIn(cur(k))}" style="width:120px;text-align:right"></div>`).join('')}
    <div class="row"><span class="ticon" style="--c:#64748b;margin:0">📥</span><span class="grow" style="font-weight:600">Not in a bucket yet</span><input data-start="${UN}" inputmode="decimal" placeholder="0.00" value="${fmtIn(cur(UN))}" style="width:120px;text-align:right"></div></div>
    <div class="row" style="margin-top:16px"><span class="grow small muted" id="st_total"></span><button class="btn" data-close>Cancel</button><button class="btn primary" id="st_save">Save</button></div>`,
  el => {
    const tot = () => { let s = 0; el.querySelectorAll('[data-start]').forEach(i => s += toCents(i.value)); el.querySelector('#st_total').textContent = 'Total ' + fmt(s); };
    el.querySelectorAll('[data-start]').forEach(i => i.oninput = tot); tot();
    el.querySelector('#st_save').onclick = async () => {
      const btn = el.querySelector('#st_save'); btn.disabled = true; btn.textContent = 'Saving…';
      for (const i of el.querySelectorAll('[data-start]')) {
        const k = i.dataset.start, v = toCents(i.value), id = 'start-'+k, had = S.moves[id];
        if (v > 0) { if (!had || had.amount !== v || had.void) await write('moves/'+id, { date: today(), from:'outside', to:k, amount:v, note:'Starting balance', at:Date.now() }); }
        else if (had) await Store.del('moves/'+id);
      }
      if (S.cfg && S.cfg.startDone !== true) await write('config/main', { startDone:true }, 'update');
      closeSheet(); toast('Starting balances saved');
    };
  });
}

/* ---------- home-screen app, notification taps, bank login return ---------- */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(()=>{});
  navigator.serviceWorker.addEventListener('message', ev => { if (ev.data && ev.data.open) openFromNotification(ev.data.open); });
}
function openFromNotification(id){
  const tryOpen = (n=0) => { if (allReady() && S.txns[id]) { setTab('activity'); openTxnSheet(id); } else if (n < 40) setTimeout(() => tryOpen(n+1), 250); };
  tryOpen();
}
(function(){
  const q = new URLSearchParams(location.search);
  const t = q.get('t'), oauth = q.get('oauth_state_id');
  if (t || oauth) history.replaceState(null, '', location.pathname + (oauth ? '#settings' : '#activity'));
  if (t) openFromNotification(t);
  if (oauth) { const wait = (n=0) => { if (Store.hid && allReady()) connectBank(location.origin + location.pathname + '?' + q.toString()); else if (n < 60) setTimeout(() => wait(n+1), 250); }; wait(); }
})();
// re-save who this phone belongs to whenever "This is me" changes
document.addEventListener('click', e => { if (e.target.closest && e.target.closest('[data-claim]')) setTimeout(refreshPushPerson, 1500); });
