const slot = document.getElementById('view-chat');
if (slot && !document.getElementById('messages')) {
  slot.innerHTML = `
    <div class="chat-status"><span id="state">未连接</span></div>
    <main id="messages" aria-live="polite"><div class="daymark" id="daymark"></div></main>
    <div id="token-bar" class="hidden">
      <input id="token" type="password" placeholder="observatory-token" autocomplete="off" spellcheck="false">
      <button id="token-save" type="button">保存令牌</button>
    </div>
    <footer class="composer">
      <div class="composer-inner">
        <div class="composer-box">
          <textarea id="text" rows="1" placeholder="跟同伴说话…（Enter 发送）" aria-label="输入消息"></textarea>
          <button id="send" class="send-btn" type="button" aria-label="发送">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>
          </button>
        </div>
        <div class="hint">Enter 发送 · Shift+Enter 换行</div>
      </div>
    </footer>
    <div id="modal" class="hidden">
      <div class="sheet">
        <div class="bar"><button id="modal-close" type="button">关闭</button></div>
        <iframe id="modal-frame" title="保密输入面"></iframe>
      </div>
    </div>`;
}

const companion = window.__COGMEM_COMPANION__ ?? { name: 'Cog', avatar: 'C' };
const TOKEN_KEY = 'observatory-write-token';
let token = sessionStorage.getItem(TOKEN_KEY) || '';
let active = null;
let oldestCursor = 0;
let hasMore = false;
let loadingOlder = false;
let failedInbound = 0;

const messages = document.getElementById('messages');
const state = document.getElementById('state');
const tokenBar = document.getElementById('token-bar');
const tokenInput = document.getElementById('token');
const text = document.getElementById('text');
const send = document.getElementById('send');
const modal = document.getElementById('modal');
const modalFrame = document.getElementById('modal-frame');
const daymark = document.getElementById('daymark');

const now = new Date();
daymark.textContent = `今天 · ${now.getMonth() + 1} 月 ${now.getDate()} 日 周${'日一二三四五六'[now.getDay()]}`;

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

function showState(label) {
  state.textContent = failedInbound > 0 ? `${label} · 未送达 ${failedInbound}` : label;
}

function clock(at) {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function addMessage(role, textContent, prepend, at) {
  const row = el('div', `msg ${role}`);
  const body = el('div', 'msg-body');
  const bubble = el('div', 'bubble', textContent);
  if (role === 'notice') {
    body.append(bubble);
    row.append(body);
  } else {
    const who = el('div', 'who', `${role === 'assistant' ? companion.name : '你'}${at || !prepend ? ` · ${clock(at ?? Date.now())}` : ''}`);
    body.append(who, bubble);
    const avatar = el('span', 'avatar', role === 'assistant' ? companion.avatar : '你');
    row.append(...(role === 'user' ? [body, avatar] : [avatar, body]));
  }
  if (prepend) messages.insertBefore(row, daymark.nextSibling);
  else {
    messages.append(row);
    scroll();
  }
  return row;
}

function addNotice(textContent) {
  addMessage('notice', textContent);
}

function addProvenance(row, provenance) {
  if (!Array.isArray(provenance) || provenance.length === 0) return;
  const chips = el('div', 'chips');
  for (const node of provenance) {
    const chip = el('a', 'chip');
    chip.href = `/observatory/#node=${encodeURIComponent(node.id)}`;
    chip.target = '_blank';
    chip.rel = 'noopener';
    const dot = el('span', 'dot');
    dot.style.color = node.color || node.role || 'var(--gold)';
    chip.append(dot, node.label || node.id);
    chips.append(chip);
  }
  (row.querySelector('.msg-body') || row).append(chips);
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
  let result = card.querySelector('.p-status') || card.querySelector('.result');
  if (!result) {
    result = el('div', 'result');
    card.append(result);
  }
  if (result.classList.contains('p-status')) {
    result.classList.add('show', ok ? 'ok' : 'no');
    result.classList.remove(ok ? 'no' : 'ok');
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
  const existing = [...document.querySelectorAll('.card[data-proposal], .proposal[data-proposal]')]
    .find((card) => card.dataset.proposal === proposal.id);
  if (existing) {
    for (const button of existing.querySelectorAll('.actions button, .p-actions button')) button.disabled = true;
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
  const card = el('div', 'proposal');
  card.dataset.proposal = proposal.id;
  const head = el('div', 'p-head');
  head.append(el('span', 'tag', '插件提案'), el('b', '', proposal.name || proposal.args || ''), el('span', 'from', '同伴起草 · 待你批准'));
  const list = el('dl');
  const rows = [['装什么', proposal.purpose || proposal.reason || '']];
  for (const line of detail) {
    const split = line.search(/[：:]/);
    if (split > 0) rows.push([line.slice(0, split), line.slice(split + 1).trim()]);
    else rows.push(['明细', line]);
  }
  if (proposal.removal && !detail.some((line) => line.includes(proposal.removal))) rows.push(['怎么摘', proposal.removal]);
  for (const [label, value] of rows) list.append(el('dt', '', label), el('dd', '', value));
  const steps = el('div', 'steps');
  for (const label of ['写入注册表', '重启并加载插件', '健康检查', '连通性自检']) {
    const step = el('div', 'st');
    step.append(el('i'), el('span', '', label));
    steps.append(step);
  }
  const status = el('p', 'p-status');
  const actions = el('div', 'p-actions');
  const settle = (ok, text) => {
    for (const step of steps.children) step.className = ok ? 'st done' : 'st';
    if (!ok) steps.lastElementChild.className = 'st fail';
    showResult(card, text, ok);
  };
  const run = async (action, okOnSuccess) => {
    for (const button of actions.querySelectorAll('button')) button.disabled = true;
    steps.classList.add('show');
    steps.firstElementChild.className = 'st doing';
    try {
      const result = await post('/channel/web/proposal', { id: proposal.id, action });
      settle(okOnSuccess(result), result.text);
    } catch (error) {
      settle(false, error.message);
    }
  };
  const approve = el('button', 'btn primary', '批准安装');
  approve.type = 'button';
  approve.addEventListener('click', () => run('confirm', (result) => result.ok));
  const reject = el('button', 'btn ghost', '拒绝');
  reject.type = 'button';
  reject.addEventListener('click', () => run('discard', () => true));
  actions.append(approve, reject);
  card.append(head, list, steps, status, actions);
  messages.append(card);
  scroll();
}

function emergenceCard(event) {
  const commitment = typeof event.id === 'string' && event.id.startsWith('surfacing:commitment:');
  if (!commitment) {
    addNotice(`浮现：${event.text || event.reason || ''}`);
    return;
  }
  const card = el('div', 'surface-card');
  const icon = el('div', 'sc-ic');
  icon.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>';
  const body = el('div');
  body.append(el('b', '', '承诺浮现'), el('p', '', `${event.text || ''}\n${event.reason || ''}`.trim()));
  body.append(el('p', 'result'));
  const actions = el('div', 'sc-actions');
  const act = async (action, minutes, okOnSuccess) => {
    for (const button of actions.querySelectorAll('button')) button.disabled = true;
    try {
      const result = await post('/channel/web/commitment', { id: event.id, action, ...(minutes ? { minutes } : {}) });
      showResult(card, result.text, okOnSuccess);
    } catch (error) {
      showResult(card, error.message, false);
    }
  };
  const confirm = el('button', '', '知道了');
  confirm.type = 'button';
  confirm.addEventListener('click', () => act('confirm', undefined, true));
  const snooze = el('button', '', '顺延 1 小时');
  snooze.type = 'button';
  snooze.addEventListener('click', () => act('snooze', 60, true));
  actions.append(snooze, confirm);
  body.append(actions);
  card.append(icon, body);
  messages.append(card);
  scroll();
}

function resendCard(event) {
  const card = el('div', 'notice');
  card.append(el('div', '', '模型线路故障，这句我没回答。'));
  const actions = el('div', '');
  const button = el('button', '', '重发');
  button.type = 'button';
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const result = await post('/channel/web/resend', { id: event.id });
      card.replaceChildren(el('div', '', result.text));
      scroll();
    } catch (error) {
      addNotice(`重发失败：${error instanceof Error ? error.message : String(error)}`);
    }
  });
  actions.append(button);
  card.append(actions);
  messages.append(card);
  scroll();
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
    showState('在线');
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
  stream.addEventListener('receipt', (event) => {
    receiptCard(JSON.parse(event.data));
  });
  stream.addEventListener('emergence', (event) => {
    emergenceCard(JSON.parse(event.data));
  });
  stream.addEventListener('resend', (event) => {
    resendCard(JSON.parse(event.data));
  });
  stream.addEventListener('state', (event) => {
    const payload = JSON.parse(event.data);
    if (typeof payload.failed === 'number') failedInbound = payload.failed;
    showState(payload.state === 'RUNNING' ? '思考中' : '在线');
  });
  stream.addEventListener('bye', () => {
    state.textContent = '渠道已停止';
    stream.close();
  });
}

function receiptCard(receipt) {
  if (!receipt || typeof receipt.text !== 'string') return;
  const card = el('div', 'notice');
  const line = el('div', '', receipt.text);
  const actions = el('div', '');
  const labels = { confirm: '对', intention: '只是打算，不用提醒', forget: '别记' };
  for (const action of receipt.actions || []) {
    const button = el('button', '', labels[action] || action);
    button.type = 'button';
    button.addEventListener('click', async () => {
      try {
        const result = await post('/channel/web/receipt', {
          sourceEventId: receipt.sourceEventId,
          action,
          content: receipt.content,
          dueAt: receipt.dueAt,
        });
        card.replaceChildren(el('div', '', result.text));
        scroll();
      } catch (error) {
        addNotice(`回执处理失败：${error instanceof Error ? error.message : String(error)}`);
      }
    });
    actions.append(button);
  }
  card.append(line, actions);
  messages.append(card);
  scroll();
}

async function loadHistory(before) {
  try {
    const response = await fetch(`/channel/web/history${before ? `?before=${before}` : ''}`);
    if (!response.ok) return;
    const page = await response.json();
    const items = page.messages || [];
    if (!before) {
      for (const message of items) addMessage(message.role, message.text, false, message.at);
    } else {
      const height = messages.scrollHeight;
      for (const message of [...items].reverse()) addMessage(message.role, message.text, true, message.at);
      messages.scrollTop += messages.scrollHeight - height;
    }
    oldestCursor = page.cursor || 0;
    hasMore = Boolean(page.hasMore) && items.length > 0;
  } catch {
    return;
  }
}

messages.addEventListener('scroll', () => {
  if (!hasMore || loadingOlder || messages.scrollTop > 80) return;
  loadingOlder = true;
  void loadHistory(oldestCursor).finally(() => {
    loadingOlder = false;
  });
});

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
