(() => {
  'use strict';
  const L = window.Ledger;
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };
  // Cookies survive some storage clears that localStorage does not, so identity is kept in both.
  const ck = {
    get(k) { const m = document.cookie.split('; ').find((c) => c.startsWith(k + '=')); return m ? decodeURIComponent(m.slice(k.length + 1)) : null; },
    set(k, v) { document.cookie = `${k}=${encodeURIComponent(v)}; max-age=${400 * 24 * 3600}; path=/; SameSite=Lax`; },
  };

  const PALETTE = [['#A9C2AE', '#24362E'], ['#F0CDB4', '#24362E'], ['#B4543A', '#FFFFFF'], ['#9CC3B5', '#24362E'], ['#E8B093', '#24362E'], ['#C9B79B', '#24362E']];
  const svg = (d, extra) => `<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ${extra || ''}>${d}</svg>`;
  const ICON = {
    home: svg('<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>'),
    plus: svg('<path d="M12 5v14M5 12h14"/>'),
    card: svg('<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 10h18"/>'),
    check: svg('<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.7 2.7L16 9.5"/>'),
    user: svg('<circle cx="12" cy="8" r="3.5"/><path d="M5 20c1-4 4-6 7-6s6 2 7 6"/>'),
    gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
    chev: svg('<path d="M9 6l6 6-6 6"/>', 'width="22" height="22"'),
  };

  let S = null; // server state
  let R = null; // exchange rates for the base currency
  let online = true;
  let needsPin = false;
  let route = 'trip';
  let draft = null;
  let pendingEdit = false;
  let me = ls.get('me') || ck.get('trip_me');
  let pin = ls.get('pin') || '';
  let toastTimer = null;

  /* ---------- helpers ---------- */
  const base = () => S.settings.baseCurrency;
  const fmt = (m, cur) => L.formatMinor(m, cur || base());
  const person = (id) => S.people.find((p) => p.id === id);
  const pname = (id) => (person(id) || { name: id }).name;
  const unitName = (ms) => ms.map(pname).join(' + ');
  const cardOf = (id) => S.cards.find((c) => c.id === id);
  function avatar(id, cls) {
    const i = Math.max(0, S.people.findIndex((p) => p.id === id));
    const c = PALETTE[i % PALETTE.length];
    return `<span class="avatar ${cls || ''}" style="background:${c[0]};color:${c[1]}" aria-hidden="true">${esc((pname(id)[0] || '?').toUpperCase())}</span>`;
  }
  const shortDate = (d) => {
    const t = new Date(d + 'T12:00:00');
    return isNaN(t) ? d : t.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  };
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  async function api(method, url, body) {
    const res = await fetch(url, {
      method, cache: 'no-store',
      headers: { 'content-type': 'application/json', 'x-trip-pin': pin },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401) { needsPin = true; renderApp(); throw new Error('pin'); }
    let data = null;
    try { data = await res.json(); } catch (e) { /* no body */ }
    if (!res.ok) throw new Error((data && data.message) || res.statusText || 'Request failed');
    return data;
  }

  /* ---------- data loading ---------- */
  async function refresh(force) {
    try {
      const headers = { 'x-trip-pin': pin };
      if (S && !force) headers['if-none-match'] = `"${S.version}"`;
      const res = await fetch('/api/state', { headers, cache: 'no-store' });
      if (res.status === 304) { setOnline(true); return; }
      if (res.status === 401) { needsPin = true; setOnline(true); renderApp(); return; }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      S = await res.json();
      ls.set('cache', JSON.stringify(S));
      needsPin = false;
      setOnline(true);
      onState();
    } catch (e) {
      setOnline(false);
    }
  }
  function setOnline(v) {
    if (online === v) return;
    online = v;
    if (S) renderApp(true);
  }
  async function loadRates(refreshNow) {
    try {
      R = await api('GET', '/api/rates' + (refreshNow ? '?refresh=1' : ''));
      if (draft && draft.currency !== base() && !(Number(draft.rate) > 0) && !draft.id) {
        setCurrency(draft.currency);
        if (route === 'add') renderView();
      }
      if (route === 'add') updatePreview();
    } catch (e) { /* offline: the add form falls back to manual rates */ }
  }
  function onState() {
    if (!me || !person(me)) { renderApp(); openIdentity(); return; }
    if (route === 'add') {
      if (!draft) { draft = newDraft(); renderApp(true); return; } // first load straight onto the Add tab
      renderHeaderOnly(); return; // never wipe a form that is being typed into
    }
    renderApp(true);
  }

  /* ---------- drafts (add / edit expense) ---------- */
  function newDraft(e) {
    const b = base();
    if (e) {
      const eq = Object.values(e.split.weights).every((w) => w === 1);
      return {
        id: e.id, title: e.title, amount: L.minorToInput(e.amountMinor, e.currency), currency: e.currency,
        rate: e.rate, rateSource: e.rateSource, actualBase: e.rateSource === 'actual' ? L.minorToInput(e.baseMinor, b) : '',
        cardId: e.cardId, splitMode: eq ? 'equal' : 'shares', weights: { ...e.split.weights },
        date: e.date, note: e.note || '', showRate: e.currency !== b && e.rateSource !== 'auto',
      };
    }
    const last = ls.get('lastCard');
    const card = S.cards.find((c) => c.id === last) || S.cards.find((c) => c.holders.includes(me)) || S.cards[0];
    return {
      title: '', amount: '', currency: b, rate: 1, rateSource: 'base', actualBase: '', cardId: card.id,
      splitMode: 'equal', weights: Object.fromEntries(S.people.map((p) => [p.id, 1])), date: L.today(), note: '', showRate: false,
    };
  }
  function setCurrency(cur) {
    const d = draft;
    d.currency = cur;
    d.actualBase = '';
    if (cur === base()) { d.rate = 1; d.rateSource = 'base'; d.showRate = false; return; }
    const r = R && R.rates ? L.rateToBase(R, cur) : null;
    if (r) { d.rate = Number(r.toPrecision(6)); d.rateSource = 'auto'; d.showRate = false; }
    else { d.rate = ''; d.rateSource = 'manual'; d.showRate = true; }
  }
  function convertDraft() {
    const d = draft;
    const b = base();
    const amt = L.parseAmount(d.amount, d.currency);
    if (!amt) return { amt: null, baseMinor: null };
    if (d.currency === b) return { amt, baseMinor: amt, rate: 1 };
    if (d.actualBase) {
      const x = L.parseAmount(d.actualBase, b);
      if (x) return { amt, baseMinor: x, rate: L.effectiveRate(amt, d.currency, x, b) };
    }
    const rate = Number(String(d.rate).replace(',', '.'));
    if (rate > 0) return { amt, baseMinor: L.convertMinor(amt, d.currency, b, rate), rate };
    return { amt, baseMinor: null };
  }

  /* ---------- views ---------- */
  function viewTrip() {
    const exps = [...S.expenses].sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || '').localeCompare(a.createdAt || ''));
    const plan = L.settlementPlan(S);
    const t = plan.transfers[0];
    const tile = t
      ? { k: `${unitName(t.from)} pay ${unitName(t.to)}`, v: fmt(t.baseMinor), s: plan.transfers.length > 1 ? `+${plan.transfers.length - 1} more` : 'to settle up' }
      : { k: 'Balance', v: fmt(0), s: exps.length ? 'All square' : 'Nothing yet' };
    const rows = exps.map((e) => {
      const c = cardOf(e.cardId) || { name: 'Unknown card', holders: [] };
      const joint = c.holders.length > 1;
      const foreign = e.currency !== base();
      return `<button class="row" data-act="edit" data-id="${esc(e.id)}">
        <span class="bubble ${joint ? 'sage' : 'peach'}">${joint ? ICON.card : ICON.user}</span>
        <span class="grow"><div class="t">${esc(e.title)}</div><div class="s">${esc(c.name)} · ${esc(shortDate(e.date))}</div></span>
        <span class="amt">${esc(fmt(e.baseMinor))}${foreign ? `<span class="o">${esc(fmt(e.amountMinor, e.currency))}</span>` : ''}</span>
      </button>`;
    }).join('');
    return `<div class="stack">
      <div class="hero">
        <div class="tile sunset"><span class="sun" aria-hidden="true"></span><div class="panelbox"><div class="k">Trip total</div><div class="v">${esc(fmt(L.totalSpent(S)))}</div><div class="k">${exps.length} expense${exps.length === 1 ? '' : 's'}</div></div></div>
        <div class="tile water"><span class="cliff" aria-hidden="true"></span><div class="panelbox"><div class="k">${esc(tile.k)}</div><div class="v">${esc(tile.v)}</div><div class="k">${esc(tile.s)}</div></div></div>
      </div>
      <a class="pilllink" href="#settle"><span>Settle up</span>${ICON.chev}</a>
      <div class="sec"><h2>Expenses</h2><span class="small muted">${esc(base())} base</span></div>
      ${exps.length ? rows : `<div class="surface empty"><h2>No expenses yet</h2><p>Add the first one after you pay for something.</p><a class="btn primary" href="#add">Add expense</a></div>`}
    </div>`;
  }

  function convLine() {
    const d = draft;
    const b = base();
    if (d.currency === b) return '';
    const cv = convertDraft();
    if (cv.baseMinor == null) return `<span class="neg">Enter an exchange rate, or the amount your card actually charged in ${esc(b)}.</span>`;
    const src = d.actualBase ? 'actual charge' : d.rateSource === 'auto' && R && R.date ? `ECB rate, ${shortDate(R.date)}${R.stale ? ' (offline copy)' : ''}` : 'your rate';
    return `<b>${esc(fmt(cv.baseMinor))}</b> <span class="muted small">1 ${esc(d.currency)} = ${esc(Number(cv.rate).toPrecision(5))} ${esc(b)} · ${esc(src)}</span>`;
  }
  function splitPreview() {
    const cv = convertDraft();
    if (cv.baseMinor == null || cv.baseMinor <= 0) return '';
    const ids = S.people.map((p) => p.id).filter((id) => draft.weights[id] > 0);
    if (!ids.length) return '';
    const a = L.allocate(cv.baseMinor, ids.map((id) => draft.weights[id]));
    return ids.map((id, i) => `${esc(pname(id))} ${esc(fmt(a[i]))}`).join(' · ');
  }
  function updatePreview() {
    if (route !== 'add' || !draft) return;
    const a = $('#convline');
    const b = $('#splitprev');
    if (a) a.innerHTML = convLine();
    if (b) b.innerHTML = splitPreview();
  }

  function viewAdd() {
    const d = draft;
    const b = base();
    const quick = [...new Set([b, 'USD', 'PAB', 'EUR'])];
    if (!quick.includes(d.currency)) quick.push(d.currency);
    const more = R && R.rates ? Object.keys(R.rates).filter((c) => !quick.includes(c)).sort() : [];
    const chips = quick.map((c) => `<button type="button" class="chip" data-act="cur" data-v="${c}" aria-pressed="${d.currency === c}"><span class="n">${esc(c)}</span></button>`).join('');
    const cards = S.cards.map((c) => `<button type="button" class="chip" data-act="card" data-id="${esc(c.id)}" aria-pressed="${d.cardId === c.id}"><span class="n">${esc(c.name)}</span><span class="d">${esc(unitName(c.holders))}</span></button>`).join('');
    const who = S.people.map((p) => `<button type="button" class="chip" data-act="who" data-id="${esc(p.id)}" aria-pressed="${d.weights[p.id] > 0}"><span class="n">${esc(p.name)}</span></button>`).join('');
    const steppers = d.splitMode === 'shares' ? S.people.filter((p) => d.weights[p.id] > 0).map((p) => `<div class="personrow">${avatar(p.id)}<span class="grow">${esc(p.name)}</span><span class="stepper"><button type="button" data-act="wstep" data-id="${esc(p.id)}" data-d="-1" aria-label="Fewer shares for ${esc(p.name)}">−</button><b>${d.weights[p.id]}</b><button type="button" data-act="wstep" data-id="${esc(p.id)}" data-d="1" aria-label="More shares for ${esc(p.name)}">+</button></span></div>`).join('') : '';
    const rateFields = d.currency !== b && d.showRate ? `
      <div class="split">
        <label class="field"><span>Rate (${esc(b)} per 1 ${esc(d.currency)})</span><input data-bind="rate" inputmode="decimal" value="${esc(d.rate)}" autocomplete="off"></label>
        <label class="field"><span>Actual ${esc(b)} charged</span><input data-bind="actualBase" inputmode="decimal" placeholder="optional" value="${esc(d.actualBase)}" autocomplete="off"></label>
      </div>
      <p class="small muted" style="margin:-6px 4px 12px">Use the actual amount from your card statement if you have it. It beats any rate.</p>` : '';
    return `<div class="stack">
      <div class="surface">
        <label class="field" style="margin:0"><span>Amount (${esc(d.currency)})</span><input class="big" data-bind="amount" inputmode="decimal" placeholder="0.00" value="${esc(d.amount)}" autocomplete="off"></label>
        <div id="conv" style="margin-top:6px">
          <div id="convline">${convLine()}</div>
          ${d.currency !== b ? `<button type="button" class="btn secondary inline" style="margin-top:8px" data-act="toggleRate">${d.showRate ? 'Hide rate options' : 'Edit rate or actual charge'}</button>` : ''}
        </div>
      </div>
      ${rateFields}
      <div><div class="label">Currency</div><div class="chips">${chips}<select data-bind="curMore" aria-label="More currencies" style="width:auto;min-height:44px;border-radius:22px"><option value="">More…</option>${more.map((c) => `<option value="${c}">${c}</option>`).join('')}</select></div></div>
      <label class="field" style="margin:0"><span>What was it for?</span><input data-bind="title" maxlength="80" placeholder="Dinner, taxi, hotel…" value="${esc(d.title)}" autocomplete="off"></label>
      <div><div class="label">Paid with</div><div class="chips">${cards}</div></div>
      <div><div class="label">Shared between</div><div class="chips">${who}</div>
        <div class="chips" style="margin-top:8px"><button type="button" class="chip" data-act="mode" data-v="equal" aria-pressed="${d.splitMode === 'equal'}"><span class="n">Equal</span></button><button type="button" class="chip" data-act="mode" data-v="shares" aria-pressed="${d.splitMode === 'shares'}"><span class="n">By shares</span></button></div>
        ${steppers ? `<div class="surface" style="margin-top:10px;padding:8px 16px">${steppers}</div>` : ''}
        <div id="splitprev" class="small muted" style="margin:8px 4px 0">${splitPreview()}</div>
      </div>
      <div class="split">
        <label class="field" style="margin:0"><span>Date</span><input type="date" data-bind="date" value="${esc(d.date)}"></label>
        <label class="field" style="margin:0"><span>Note</span><input data-bind="note" maxlength="200" placeholder="optional" value="${esc(d.note)}"></label>
      </div>
      <button type="button" class="btn primary" data-act="save">${d.id ? 'Save changes' : 'Save expense'}</button>
      ${d.id ? '<button type="button" class="btn ghost" data-act="del">Delete expense</button>' : ''}
    </div>`;
  }

  function balanceLedger() {
    const plan = L.settlementPlan(S);
    const ppl = S.people;
    const cols = `grid-template-columns: 1.2fr repeat(${ppl.length}, minmax(0, 1fr))`;
    const cell = (v, cls) => `<div class="r ${cls || ''}">${v}</div>`;
    const net = (id) => { const n = plan.balances[id].net; return `<span class="${n < 0 ? 'neg' : n > 0 ? 'pos' : ''}">${n > 0 ? '+' : n < 0 ? '−' : ''}${esc(fmt(Math.abs(n)))}</span>`; };
    return `<div class="ledger" style="${cols}">
      <div class="h"></div>${ppl.map((p) => `<div class="h r">${esc(p.name)}</div>`).join('')}
      <div>Paid</div>${ppl.map((p) => cell(esc(fmt(plan.balances[p.id].paid)))).join('')}
      <div>Fair share</div>${ppl.map((p) => cell(esc(fmt(plan.balances[p.id].owed)))).join('')}
      <div class="tot">Net</div>${ppl.map((p) => cell(net(p.id), 'tot')).join('')}
    </div>`;
  }

  function viewCards() {
    const spend = L.spendByCard(S);
    const list = S.cards.map((c) => {
      const joint = c.holders.length > 1;
      return `<button type="button" class="cardface ${joint ? 'joint' : 'solo'}" data-act="editCard" data-id="${esc(c.id)}" aria-label="Edit ${esc(c.name)}">
        <span class="top2"><span class="tag">${joint ? 'Shared card' : 'Own card'}</span><span class="badge">${joint ? 'One wallet' : 'One person'}</span></span>
        <span class="name">${esc(c.name)}</span>
        <span class="bot"><span>Spent ${esc(fmt(spend[c.id] || 0))}</span><span class="avatars">${c.holders.map((h) => avatar(h)).join('')}</span></span>
      </button>`;
    }).join('');
    const hh = S.settings.householdsOn && S.households[0] ? unitName(S.households[0]) : null;
    return `<div class="stack">${list}
      <button type="button" class="btn secondary" data-act="addCard">Add a card</button>
      <div class="surface"><h2 style="font-size:19px;margin-bottom:6px">How it nets out</h2>${balanceLedger()}</div>
      <div class="note">A card's holders get credit for what it pays, equally. ${hh ? `${esc(hh)} settle as one household, so using the shared card, Fynn's or Tara's own card all comes out the same for Max.` : 'Everyone settles individually.'} Change this in settings.</div>
    </div>`;
  }

  function viewSettle() {
    const plan = L.settlementPlan(S);
    const cards = plan.transfers.map((t, i) => {
      const fromSel = t.from.length > 1 ? `<label class="field" style="margin:0 0 10px"><span>Paid by</span><select id="pf-${i}">${t.from.map((id) => `<option value="${esc(id)}">${esc(pname(id))}</option>`).join('')}</select></label>` : '';
      const toSel = t.to.length > 1 ? `<label class="field" style="margin:0 0 10px"><span>Received by</span><select id="pt-${i}">${t.to.map((id) => `<option value="${esc(id)}">${esc(pname(id))}</option>`).join('')}</select></label>` : '';
      return `<div class="bigcard"><div style="font-weight:700">${esc(unitName(t.from))} pay ${esc(unitName(t.to))}</div>
        <div class="amt">${esc(fmt(t.baseMinor))}</div>${fromSel}${toSel}
        <button type="button" class="btn dark" data-act="pay" data-i="${i}">Mark as paid</button></div>`;
    }).join('');
    const square = `<div class="bigcard"><div style="font-weight:700">${S.expenses.length ? 'All square' : 'Nothing to settle yet'}</div><div class="amt">${esc(fmt(0))}</div></div>`;
    const pays = S.settlements.map((s) => `<div class="row" style="cursor:default"><span class="bubble sage">${ICON.check}</span><span class="grow"><div class="t">${esc(pname(s.from))} paid ${esc(pname(s.to))}</div><div class="s">${esc(shortDate(s.date))}</div></span><span class="amt">${esc(fmt(s.baseMinor))}</span><button type="button" class="btn secondary inline" data-act="undoPay" data-id="${esc(s.id)}">Undo</button></div>`).join('');
    return `<div class="stack">${plan.transfers.length ? cards : square}
      <div class="surface"><h2 style="font-size:19px;margin-bottom:6px">Where things stand</h2>${balanceLedger()}<p class="small muted" style="margin:8px 0 0">Net includes payments already recorded.</p></div>
      ${pays ? `<div class="sec"><h2>Payments</h2></div>${pays}` : ''}
    </div>`;
  }

  const views = { trip: viewTrip, add: viewAdd, cards: viewCards, settle: viewSettle };
  const TITLES = {
    trip: () => [S.trip.name, 'Trip'],
    add: () => [draft && draft.id ? 'Edit expense' : 'Add expense', S.trip.name],
    cards: () => ['Cards and wallets', S.trip.name],
    settle: () => ['Settle up', S.trip.name],
  };

  /* ---------- rendering ---------- */
  function headerHtml() {
    const t = TITLES[route]();
    const meBtn = me && person(me) ? `<button type="button" class="avatar me" data-act="who-me" aria-label="Signed in as ${esc(pname(me))}. Switch person." style="background:${PALETTE[Math.max(0, S.people.findIndex((p) => p.id === me)) % PALETTE.length][0]};color:${PALETTE[Math.max(0, S.people.findIndex((p) => p.id === me)) % PALETTE.length][1]}">${esc((pname(me)[0] || '?').toUpperCase())}</button>` : '';
    return `<div><div class="eyebrow">${esc(t[1])}</div><h1>${esc(t[0])}</h1></div><div class="ctrl">${meBtn}<button type="button" class="iconbtn" data-act="settings" aria-label="Settings">${ICON.gear}</button></div>`;
  }
  function renderHeaderOnly() {
    const h = $('#app .top');
    if (h) h.innerHTML = headerHtml();
  }
  function renderTabs() {
    const tabs = [['trip', 'Trip', ICON.home], ['add', 'Add', ICON.plus], ['cards', 'Cards', ICON.card], ['settle', 'Settle', ICON.check]];
    const el = $('#tabs');
    el.classList.toggle('hidden', !S || needsPin);
    el.innerHTML = tabs.map(([r, label, icon]) => `<a href="#${r}" ${route === r ? 'aria-current="page"' : ''}>${icon}${label}</a>`).join('');
  }
  function renderView() {
    const v = $('#view');
    if (v) v.innerHTML = (online ? '' : '<div class="banner" style="margin-bottom:12px">Offline. Showing the last data. Changes need a connection.</div>') + views[route]();
  }
  function renderApp() {
    const app = $('#app');
    if (needsPin) {
      app.innerHTML = `<div class="pinwrap"><form class="surface" id="pinform"><h2 style="margin-bottom:6px">Trip PIN</h2><p class="muted">Ask whoever set up the server for the PIN.</p><label class="field"><span>PIN</span><input id="pininput" type="password" autocomplete="current-password" inputmode="numeric"></label><button class="btn primary" type="submit">Unlock</button></form></div>`;
      renderTabs();
      return;
    }
    if (!S) { app.innerHTML = '<div class="pinwrap"><p class="muted">Loading…</p></div>'; return; }
    if (route === 'add' && !draft) draft = newDraft();
    app.innerHTML = `<header class="top">${headerHtml()}</header><main id="view"></main>`;
    renderView();
    renderTabs();
  }

  /* ---------- sheets ---------- */
  function openSheet(html) {
    const s = $('#sheet');
    s.innerHTML = `<div class="scrim" data-act="closeSheet"></div><div class="sheetpanel">${html}</div>`;
    s.classList.add('open');
  }
  function closeSheet() {
    const s = $('#sheet');
    s.classList.remove('open');
    s.innerHTML = '';
  }
  const checkRow = (id, label, checked, cls) => `<label class="personrow"><input type="checkbox" class="${cls}" value="${esc(id)}" ${checked ? 'checked' : ''}><span class="grow">${esc(label)}</span></label>`;

  function openIdentity() {
    openSheet(`<h2>Who are you?</h2><p class="muted" style="margin-top:-8px">So expenses show who added them. Saved on this phone.</p>
      <div class="chips">${S.people.map((p) => `<button type="button" class="chip" data-act="setMe" data-id="${esc(p.id)}"><span class="n">${esc(p.name)}</span></button>`).join('')}</div>`);
  }
  function openCardSheet(id) {
    const c = id ? cardOf(id) : { name: '', holders: me ? [me] : [] };
    openSheet(`<h2>${id ? 'Edit card' : 'Add a card'}</h2>
      <label class="field"><span>Card name</span><input id="cardName" maxlength="40" value="${esc(c.name)}" placeholder="e.g. Tara's Monzo"></label>
      <div class="label">Who holds it?</div>${S.people.map((p) => checkRow(p.id, p.name, c.holders.includes(p.id), 'holder')).join('')}
      <p class="small muted">Pick two people for a shared card. Changing holders also changes how past spend on this card is credited.</p>
      <button type="button" class="btn primary" data-act="saveCard" data-id="${id ? esc(id) : ''}">Save card</button>
      ${id ? `<button type="button" class="btn ghost" data-act="delCard" data-id="${esc(id)}">Remove card</button>` : ''}
      <button type="button" class="btn secondary" data-act="closeSheet">Cancel</button>`);
  }
  function openSettings() {
    const locked = S.expenses.length > 0 || S.settlements.length > 0;
    const hh = S.households[0] || [];
    const curs = R && R.rates ? Object.keys(R.rates).sort() : [base()];
    const rateInfo = R && R.rates ? `Rates ${R.date ? 'from ' + shortDate(R.date) : ''}${R.stale ? ' (offline copy)' : ''}` : 'No rates loaded yet. You can still type a rate or the actual amount charged.';
    openSheet(`<h2>Settings</h2>
      <label class="field"><span>Trip name</span><input id="setTrip" maxlength="40" value="${esc(S.trip.name)}"></label>
      <label class="field"><span>Base currency ${locked ? '(locked once expenses exist)' : ''}</span><select id="setBase" ${locked ? 'disabled' : ''}>${[...new Set([base(), ...curs])].map((c) => `<option ${c === base() ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
      <label class="personrow"><input type="checkbox" id="setHH" ${S.settings.householdsOn ? 'checked' : ''}><span class="grow"><b>Settle as a household</b><br><span class="small muted">Members below are treated as one when working out who pays whom.</span></span></label>
      <div style="margin:0 0 12px 34px">${S.people.map((p) => checkRow(p.id, p.name, hh.includes(p.id), 'hhm')).join('')}</div>
      <div class="note" style="margin-bottom:12px">${esc(rateInfo)}</div>
      <button type="button" class="btn secondary" data-act="refreshRates">Refresh exchange rates</button>
      <button type="button" class="btn secondary" data-act="export">Download CSV</button>
      <label class="field" style="margin-top:14px"><span>Add a person</span><input id="setPerson" maxlength="30" placeholder="Name"></label>
      <button type="button" class="btn dark" data-act="saveSettings">Save</button>
      <button type="button" class="btn secondary" data-act="closeSheet">Close</button>`);
  }

  /* ---------- actions ---------- */
  const actions = {
    closeSheet() { closeSheet(); },
    'who-me'() { openIdentity(); },
    setMe(el) { me = el.dataset.id; ls.set('me', me); ck.set('trip_me', me); closeSheet(); renderApp(); },
    settings() { openSettings(); },
    edit(el) {
      const e = S.expenses.find((x) => x.id === el.dataset.id);
      if (!e) return;
      draft = newDraft(e);
      pendingEdit = true;
      location.hash = '#add';
    },
    cur(el) {
      if (el.dataset.v === draft.currency) return;
      setCurrency(el.dataset.v);
      renderView();
    },
    toggleRate() { draft.showRate = !draft.showRate; renderView(); },
    card(el) { draft.cardId = el.dataset.id; renderView(); },
    who(el) {
      const id = el.dataset.id;
      const on = draft.weights[id] > 0;
      if (on && S.people.filter((p) => draft.weights[p.id] > 0).length === 1) { toast('Someone has to share it'); return; }
      draft.weights[id] = on ? 0 : 1;
      renderView();
    },
    mode(el) {
      draft.splitMode = el.dataset.v;
      if (draft.splitMode === 'equal') for (const id in draft.weights) if (draft.weights[id] > 0) draft.weights[id] = 1;
      renderView();
    },
    wstep(el) {
      const id = el.dataset.id;
      draft.weights[id] = Math.min(20, Math.max(1, (draft.weights[id] || 1) + Number(el.dataset.d)));
      renderView();
    },
    async save() {
      const d = draft;
      const b = base();
      const cv = convertDraft();
      if (!d.title.trim()) return toast('Add a short title');
      if (!cv.amt) return toast('Enter an amount');
      if (cv.baseMinor == null) return toast(`Enter a rate or the amount charged in ${b}`);
      const weights = {};
      S.people.forEach((p) => { if (d.weights[p.id] > 0) weights[p.id] = d.weights[p.id]; });
      const body = {
        title: d.title.trim(), amount: d.amount, currency: d.currency, cardId: d.cardId, date: d.date, note: d.note,
        split: { weights }, createdBy: me,
        rate: d.currency !== b ? Number(String(d.rate).replace(',', '.')) || undefined : undefined,
        rateSource: d.rateSource, actualBase: d.actualBase || undefined,
      };
      const res = d.id ? await api('PUT', '/api/expenses/' + d.id, body) : await api('POST', '/api/expenses', body);
      ls.set('lastCard', d.cardId);
      S = res.state;
      draft = null;
      toast(d.id ? 'Saved' : 'Expense added');
      location.hash = '#trip';
    },
    async del() {
      if (!draft || !draft.id) return;
      if (!confirm('Delete this expense?')) return;
      const res = await api('DELETE', '/api/expenses/' + draft.id);
      S = res.state;
      draft = null;
      toast('Deleted');
      location.hash = '#trip';
    },
    addCard() { openCardSheet(null); },
    editCard(el) { openCardSheet(el.dataset.id); },
    async saveCard(el) {
      const holders = [...document.querySelectorAll('#sheet .holder:checked')].map((x) => x.value);
      const body = { name: $('#cardName').value, holders };
      const res = el.dataset.id ? await api('PUT', '/api/cards/' + el.dataset.id, body) : await api('POST', '/api/cards', body);
      S = res.state; closeSheet(); renderView(); toast('Card saved');
    },
    async delCard(el) {
      if (!confirm('Remove this card?')) return;
      const res = await api('DELETE', '/api/cards/' + el.dataset.id);
      S = res.state; closeSheet(); renderView(); toast('Card removed');
    },
    async pay(el) {
      const i = Number(el.dataset.i);
      const t = L.settlementPlan(S).transfers[i];
      if (!t) return;
      const f = $('#pf-' + i);
      const to = $('#pt-' + i);
      const res = await api('POST', '/api/settlements', { from: f ? f.value : t.from[0], to: to ? to.value : t.to[0], baseMinor: t.baseMinor, date: L.today() });
      S = res.state; renderView(); toast('Payment recorded');
    },
    async undoPay(el) {
      const res = await api('DELETE', '/api/settlements/' + el.dataset.id);
      S = res.state; renderView(); toast('Payment removed');
    },
    async refreshRates() { await loadRates(true); openSettings(); toast(R && R.rates && !R.stale ? 'Rates updated' : 'Could not reach the rates service'); },
    async export() {
      const res = await fetch('/api/export.csv', { headers: { 'x-trip-pin': pin } });
      if (!res.ok) throw new Error('Export failed');
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url; a.download = 'trip-expenses.csv';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    },
    async saveSettings() {
      const members = [...document.querySelectorAll('#sheet .hhm:checked')].map((x) => x.value);
      const body = { tripName: $('#setTrip').value, householdsOn: $('#setHH').checked && members.length >= 2, households: members.length >= 2 ? [members] : [] };
      const baseSel = $('#setBase');
      if (baseSel && !baseSel.disabled && baseSel.value !== base()) body.baseCurrency = baseSel.value;
      let res = await api('PUT', '/api/settings', body);
      const np = $('#setPerson').value.trim();
      if (np) res = await api('POST', '/api/people', { name: np });
      S = res.state; closeSheet();
      if (body.baseCurrency) { R = null; await loadRates(); }
      renderApp(); toast('Settings saved');
    },
  };

  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const fn = actions[el.dataset.act];
    if (!fn) return;
    try { await fn(el, e); } catch (err) { if (err.message !== 'pin') toast(err.message || 'Something went wrong'); }
  });
  document.addEventListener('input', (e) => {
    const k = e.target.dataset && e.target.dataset.bind;
    if (!k || !draft) return;
    if (k === 'curMore') return;
    draft[k] = e.target.value;
    if (k === 'rate') { draft.rateSource = 'manual'; draft.actualBase = draft.actualBase || ''; }
    if (k === 'actualBase') draft.rateSource = e.target.value ? 'actual' : 'manual';
    updatePreview();
  });
  document.addEventListener('change', (e) => {
    if (e.target.dataset && e.target.dataset.bind === 'curMore' && e.target.value) {
      setCurrency(e.target.value);
      renderView();
    }
  });
  document.addEventListener('submit', async (e) => {
    if (e.target.id !== 'pinform') return;
    e.preventDefault();
    const entered = $('#pininput').value.trim();
    try {
      const res = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: entered }), cache: 'no-store' });
      if (res.status === 401) { toast('Wrong PIN, try again'); $('#pininput').select(); return; }
      if (!res.ok) throw new Error('HTTP ' + res.status);
    } catch (err) { toast('Could not reach the server'); return; }
    pin = entered;
    ls.set('pin', pin); // the server also sets a 400-day cookie, so this is a backup
    needsPin = false;
    await refresh(true);
    loadRates();
  });

  /* ---------- routing and boot ---------- */
  function onRoute() {
    const r = (location.hash || '#trip').slice(1);
    const next = views[r] ? r : 'trip';
    const was = route;
    route = next;
    closeSheet();
    if (route === 'add') {
      if (!pendingEdit && (!draft || draft.id)) draft = S ? newDraft() : null;
      pendingEdit = false;
    }
    if (S) renderApp();
    window.scrollTo(0, 0);
    if (was !== route && route === 'trip') refresh(true);
  }

  async function boot() {
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* optional */ }
    try { const c = ls.get('cache'); if (c) S = JSON.parse(c); } catch (e) { S = null; } // instant first paint, and data while offline
    try {
      const a = await fetch('/api/auth-required').then((r) => r.json());
      needsPin = !!a.pin && !a.authed && !pin;
    } catch (e) { /* server unreachable: refresh() will mark us offline */ }
    route = (location.hash || '#trip').slice(1);
    if (!views[route]) route = 'trip';
    if (route === 'add' && S && !draft) draft = newDraft();
    renderApp();
    if (!needsPin) await refresh(true);
    loadRates();
    window.addEventListener('hashchange', onRoute);
    setInterval(() => refresh(false), 5000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(false); });
  }
  boot();
})();
