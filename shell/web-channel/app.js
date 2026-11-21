const TOKEN_KEY = 'observatory-write-token';
let token = sessionStorage.getItem(TOKEN_KEY) || '';
let active = null;
let data = null;

const messages = document.getElementById('messages');
const state = document.getElementById('state');
const tokenBar = document.getElementById('token-bar');
const tokenInput = document.getElementById('token');
const text = document.getElementById('text');
const send = document.getElementById('send');
const modal = document.getElementById('modal');
const modalFrame = document.getElementById('modal-frame');

function el(tag, className, textContent) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (textContent !== undefined) node.textContent = textContent;
  return node;
}

function syncTokenBar() {
  tokenBar.classList.toggle('hidden', Boolean(token));
}

function scroll() {
  messages.scrollTop = messages.scrollHeight;
}

function addMessage(role, textContent) {
  const row = el('div', `msg ${role}`);
  const bubble = el('div', 'bubble', textContent);
  row.append(bubble);
  messages.append(row);
  scroll();
  return row;
}

function addNotice(textContent) {
  addMessage('notice', textContent);
}

function addProvenance(row, provenance) {
  if (!Array.isArray(provenance) || provenance.length === 0) return;
  const chips = el('div', 'chips');
  for (const node of provenance) {
    const chip = el('a', 'chip', node.label || node.id);
    chip.href = `/observatory/#node=${encodeURIComponent(node.id)}`;
    chip.target = '_blank';
    chip.rel = 'noopener';
    chips.append(chip);
  }
  row.append(chips);
}

function addCard(title, body, actions) {
  const card = el('div', 'card');
  card.append(el('h2', '', title));
  card.append(el('p', '', body));
  if (actions) {
    const bar = el('div', 'actions');
    for (const action of actions) {
      const button = el('button', action.primary ? 'primary' : '', action.label);
      button.type = 'button';
      button.addEventListener('click', () => {
        for (const other of bar.querySelectorAll('button')) other.disabled = true;
        action.run(card);
      });
      bar.append(button);
    }
    card.append(bar);
  }
  messages.append(card);
  scroll();
  return card;
}

function showResult(card, textContent, ok) {
  let result = card.querySelector('.result');
  if (!result) {
    result = el('div', 'result');
    card.append(result);
  }
  result.textContent = textContent;
  result.style.color = ok ? '' : 'var(--warn)';
}

async function post(path, body) {
  if (!token) throw new Error('先填写 observatory-token');
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-observatory-token': token },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || payload.text || `HTTP ${response.status}`);
  return payload;
}

function proposalCard(proposal) {
  const existing = [...document.querySelectorAll('.card[data-proposal]')]
    .find((card) => card.dataset.proposal === proposal.id);
  if (existing) {
    for (const button of existing.querySelectorAll('.actions button')) button.disabled = true;
    if (proposal.status === 'discarded') showResult(existing, '已作废。', true);
    else if (proposal.status === 'rejected') showResult(existing, proposal.rejectedReason || proposal.resultText || '已拒绝。', false);
    else if (proposal.status && proposal.status !== 'pending') showResult(existing, proposal.resultText || '已执行。', true);
    return;
  }
  if (proposal.kind === 'credential') {
    const fields = (proposal.credential?.fields ?? []).map((field) => field.label || field.name);
    const card = addCard(
      `凭据请求：${proposal.credential?.service ?? ''}`,
      `${proposal.reason || proposal.credential?.purpose || ''}\n字段：${fields.join('、') || '（无）'}`,
      [{
        label: '打开保密输入面',
        primary: true,
        run: () => openModal('/observatory/#credentials'),
      }],
    );
    card.dataset.proposal = proposal.id;
    return;
  }
  const detail = Array.isArray(proposal.detail) ? proposal.detail : [];
  const card = addCard(
    `插件提案：${proposal.name || proposal.args || ''}`,
    [proposal.reason, proposal.removal ? `摘除：${proposal.removal}` : ''].filter(Boolean).join('\n'),
    [
      {
        label: '批准',
        primary: true,
        run: async (target) => {
          try {
            const result = await post('/channel/web/proposal', { id: proposal.id, action: 'confirm' });
            showResult(target, result.text, result.ok);
          } catch (error) {
            showResult(target, error.message, false);
          }
        },
      },
      {
        label: '拒绝',
        run: async (target) => {
          try {
            const result = await post('/channel/web/proposal', { id: proposal.id, action: 'discard' });
            showResult(target, result.text, true);
          } catch (error) {
            showResult(target, error.message, false);
          }
        },
      },
    ],
  );
  card.dataset.proposal = proposal.id;
  if (detail.length > 0) {
    const list = el('ul');
    for (const line of detail) list.append(el('li', '', line));
    card.insertBefore(list, card.querySelector('.actions'));
  }
}

function emergenceCard(event) {
  const commitment = typeof event.id === 'string' && event.id.startsWith('surfacing:commitment:');
  if (!commitment) {
    addNotice(`浮现：${event.text || event.reason || ''}`);
    return;
  }
  addCard(
    '承诺浮现',
    `${event.text || ''}\n${event.reason || ''}`.trim(),
    [
      {
        label: '确认',
        primary: true,
        run: async (card) => {
          try {
            const result = await post('/channel/web/commitment', { id: event.id, action: 'confirm' });
            showResult(card, result.text, true);
          } catch (error) {
            showResult(card, error.message, false);
          }
        },
      },
      {
        label: '顺延 1 小时',
        run: async (card) => {
          try {
            const result = await post('/channel/web/commitment', { id: event.id, action: 'snooze', minutes: 60 });
            showResult(card, result.text, true);
          } catch (error) {
            showResult(card, error.message, false);
          }
        },
      },
    ],
  );
}

function openModal(url) {
  modalFrame.src = url;
  modal.classList.remove('hidden');
}

function closeModal() {
  modal.classList.add('hidden');
  modalFrame.src = 'about:blank';
}

function connect() {
  const stream = new EventSource('/channel/web/events');
  stream.addEventListener('open', () => {
    state.textContent = '在线';
  });
  stream.addEventListener('error', () => {
    state.textContent = '重连中';
  });
  stream.addEventListener('user', (event) => {
    const payload = JSON.parse(event.data);
    addMessage('user', payload.text);
  });
  stream.addEventListener('reply_delta', (event) => {
    const payload = JSON.parse(event.data);
    if (!active) active = addMessage('assistant', '');
    active.querySelector('.bubble').textContent += payload.delta;
    scroll();
  });
  stream.addEventListener('reply_end', (event) => {
    const payload = JSON.parse(event.data);
    const row = active || addMessage('assistant', '');
    row.querySelector('.bubble').textContent = payload.text;
    addProvenance(row, payload.provenance);
    active = null;
    scroll();
  });
  stream.addEventListener('notice', (event) => {
    addNotice(JSON.parse(event.data).text || '');
  });
  stream.addEventListener('proposal', (event) => {
    proposalCard(JSON.parse(event.data).proposal || {});
  });
  stream.addEventListener('emergence', (event) => {
    emergenceCard(JSON.parse(event.data));
  });
  stream.addEventListener('state', (event) => {
    const payload = JSON.parse(event.data);
    state.textContent = payload.state === 'RUNNING' ? '思考中' : '在线';
  });
  stream.addEventListener('bye', () => {
    state.textContent = '渠道已停止';
    stream.close();
  });
}

async function loadHistory() {
  try {
    const response = await fetch('/channel/web/history');
    if (!response.ok) return;
    data = await response.json();
    for (const message of data.messages || []) addMessage(message.role, message.text);
  } catch {
    return;
  }
}

async function submit() {
  const value = text.value.trim();
  if (!value) return;
  send.disabled = true;
  try {
    await post('/channel/web/send', { text: value });
    text.value = '';
  } catch (error) {
    addNotice(error.message);
  } finally {
    send.disabled = false;
    text.focus();
  }
}

document.getElementById('token-save').addEventListener('click', () => {
  token = tokenInput.value.trim();
  if (token) sessionStorage.setItem(TOKEN_KEY, token);
  else sessionStorage.removeItem(TOKEN_KEY);
  syncTokenBar();
});
document.getElementById('modal-close').addEventListener('click', closeModal);
send.addEventListener('click', submit);
text.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    void submit();
  }
});

syncTokenBar();
tokenInput.value = token;
await loadHistory();
connect();
