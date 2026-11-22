const slot = document.getElementById('view-channels');

const TOKEN_KEY = 'observatory-write-token';
let token = sessionStorage.getItem(TOKEN_KEY) || '';
let cards = [];
let error = '';
let form = null;

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'text') node.textContent = value;
    else if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  node.append(...children);
  return node;
}

function label(state) {
  if (state === 'connected') return '已连接';
  if (state === 'pairing') return '待配对';
  if (state === 'error') return '异常';
  return '未连接';
}

async function api(path, body) {
  const response = await fetch(`/observatory/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      accept: 'application/json',
      'x-observatory-token': token,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || payload.error || `HTTP ${response.status}`);
  return payload;
}

async function load() {
  if (!token) return;
  try {
    cards = (await api('channels')).channels;
    error = '';
  } catch (cause) {
    error = cause.message;
  }
  render();
}

async function act(path, body = {}) {
  try {
    return await api(path, body);
  } catch (cause) {
    error = cause.message;
    render();
    return undefined;
  }
}

function tokenRow() {
  if (token) return null;
  const input = el('input', { type: 'password', placeholder: 'observatory-token', autocomplete: 'off', spellcheck: 'false' });
  return el('div', { class: 'channel-token' }, [
    input,
    el('button', {
      type: 'button',
      text: '保存令牌',
      onclick: () => {
        token = input.value.trim();
        sessionStorage.setItem(TOKEN_KEY, token);
        render();
        void load();
      },
    }),
  ]);
}

function begin(card) {
  void act(`channels/${card.id}/begin`).then((reply) => {
    if (!reply?.ok) {
      if (reply?.error) error = reply.error;
      render();
      return;
    }
    form = { id: card.id, requestId: reply.requestId, fields: card.config, values: {} };
    render();
  });
}

function submitForm(card) {
  void act('credentials/submit', { id: form.requestId, values: form.values }).then((saved) => {
    if (!saved?.ok) {
      if (saved?.error) error = saved.error;
      render();
      return;
    }
    void act(`channels/${card.id}/start`, { ref: saved.ref }).then((started) => {
      if (!started?.ok) {
        if (started?.error) error = started.error;
        render();
        return;
      }
      form = null;
      void load();
    });
  });
}

function credentialForm(card) {
  const row = el('div', { class: 'channel-form' });
  for (const field of form.fields) {
    const input = el('input', {
      type: field.secret ? 'password' : 'text',
      placeholder: field.label || field.name,
      autocomplete: 'off',
      spellcheck: 'false',
      oninput: (event) => { form.values[field.name] = event.target.value; },
    });
    row.append(el('label', { text: `${field.label || field.name}（宿主保密输入面）` }), input);
  }
  row.append(el('div', { class: 'channel-actions' }, [
    el('button', { type: 'button', class: 'primary', text: '保存并连接', onclick: () => submitForm(card) }),
    el('button', { type: 'button', text: '取消', onclick: () => { form = null; render(); } }),
  ]));
  return row;
}

function channelCard(card) {
  const body = [
    el('div', { class: 'channel-head' }, [
      el('strong', { text: card.name }),
      el('span', { class: `channel-state ${card.state}`, text: label(card.state) }),
    ]),
  ];
  if (card.detail) body.push(el('p', { class: 'channel-detail', text: card.detail }));
  if (card.pairingCode) body.push(el('code', { class: 'channel-code', text: card.pairingCode }));
  if (form?.id === card.id) {
    body.push(credentialForm(card));
  } else {
    const actions = [];
    if (card.connectable && card.state !== 'connected' && card.state !== 'pairing') {
      actions.push(el('button', { type: 'button', class: 'primary', text: `连接 ${card.name}`, onclick: () => begin(card) }));
    }
    if (card.connectable && card.state !== 'disconnected') {
      actions.push(el('button', {
        type: 'button',
        text: card.state === 'pairing' ? '取消连接' : '断开',
        onclick: () => { void act(`channels/${card.id}/disconnect`).then(() => load()); },
      }));
    }
    if (actions.length) body.push(el('div', { class: 'channel-actions' }, actions));
  }
  return el('article', { class: 'channel-card' }, body);
}

function render() {
  if (!slot) return;
  slot.innerHTML = '';
  slot.append(el('header', { class: 'channel-header' }, [
    el('h2', { text: '渠道' }),
    el('p', { text: '连接同伴说话的入口；配对与令牌都在这一个面里完成。' }),
  ]));
  const tokenBar = tokenRow();
  if (tokenBar) slot.append(tokenBar);
  if (error) slot.append(el('p', { class: 'channel-error', text: error }));
  if (token && cards.length === 0) slot.append(el('p', { class: 'channel-detail', text: '还没有渠道插件提供连接。' }));
  for (const card of cards) slot.append(channelCard(card));
}

render();
void load();
setInterval(() => {
  if (document.hidden || form) return;
  void load();
}, 2_000);
