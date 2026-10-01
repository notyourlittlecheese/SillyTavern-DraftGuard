import { DraftStore, stamp } from './store.js';
import { getCurrentUserHandle } from '../../../user.js';

const store = new DraftStore();
const context = () => SillyTavern.getContext();
let box, button, dialog, status, key = null, value = '', dirty = false, composing = false;
let timer = null, queue = Promise.resolve(), candidate = null, started = false;
let failure = '', lastSaved = '', panelKey = null, panelVersion = 0;
const handled = new WeakSet();

function chatKey() {
    const ctx = context();
    const id = ctx.getCurrentChatId?.() ?? ctx.chatId;
    if (!id) return null;
    const owner = ctx.groupId != null && ctx.groupId !== ''
        ? ['group', String(ctx.groupId)]
        : ['character', ctx.characters?.[ctx.characterId]?.avatar];
    if (!owner[1]) return null;
    return JSON.stringify([getCurrentUserHandle(), ...owner, String(id)]);
}

function report(error) {
    console.error('[Draft Guard]', error);
    failure = error?.message || String(error);
    button?.classList.add('tdg-error');
    if (button) button.title = `草稿保存失败：${failure}。点击查看。`;
    if (status) status.textContent = `保存失败：${failure}。可关闭后重新打开重试。`;
}

function enqueue(task) {
    const result = queue.then(task);
    // Errors never reject a SillyTavern event or block message sending.
    queue = result.catch(report);
    return result;
}

function save(text, scope = key, at = stamp()) {
    if (!scope) return Promise.resolve();
    const result = enqueue(async () => {
        await store.save(scope, text, at);
        failure = '';
        lastSaved = new Date().toLocaleTimeString();
        button?.classList.remove('tdg-error');
        if (button) button.title = `草稿历史 · 最近保存 ${lastSaved}`;
    });
    // Preserve failed work for the next input/explicit retry, without a busy retry loop.
    result.catch(() => { if (scope === key && text === value) dirty = true; });
    return result;
}

function cancelTimer() { clearTimeout(timer); timer = null; }

function schedule() {
    if (timer || !dirty || !key || document.hidden) return;
    timer = setTimeout(() => {
        timer = null;
        if (!composing) flush();
        // compositionend will schedule the next save; no polling while composing.
    }, 3000);
}

function flush() {
    cancelTimer();
    if (!dirty || !key) return queue;
    dirty = false;
    return save(value);
}

function switchChat() {
    const next = chatKey();
    if (next === key) return;
    flush(); // value belongs to the old chat; never read the new textarea here.
    key = next;
    value = box.value;
    candidate = null;
    dirty = Boolean(key && value);
    if (dialog?.open) dialog.close();
    if (button) button.disabled = !key;
    schedule();
}

function input(event) {
    if (chatKey() !== key) switchChat();
    const next = box.value;
    if (next === value) return;
    const now = stamp();
    if (value && !next) {
        // ST clears the textarea synchronously before MESSAGE_SENT. Catch the
        // last keystrokes here, even if the three-second timer hasn't fired.
        save(value, key, now);
        if (!event.isTrusted) candidate = { key, text: value, at: now };
    }
    value = next;
    dirty = true;
    schedule();
}

function onSent(index) {
    const ctx = context();
    const message = ctx.chat?.[index];
    if (!message?.is_user || message.is_system || handled.has(message)) return;
    handled.add(message);
    const scope = chatKey();
    if (!scope) return;
    const pending = candidate?.key === scope ? candidate : null;
    candidate = null;
    const now = stamp();
    const boundary = pending?.at ?? now;
    const text = pending?.text ?? String(message.mes || '');
    // Flush a next draft with its own timestamp so rotation leaves it intact.
    if (scope === key) {
        cancelTimer();
        if (dirty && value) save(value, scope, now);
        dirty = false;
    }
    // Quick replies/scripts can emit MESSAGE_SENT without sending the textbox.
    // Preserve its independent draft if the textbox was never cleared.
    const consumeCurrent = Boolean(pending) || !box.value;
    void enqueue(() => store.sent(scope, text, boundary, now, consumeCurrent));
}

function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
}

async function openHistory() {
    if (!key) return;
    if (dialog?.open) { dialog.focus(); return; }
    const scope = key;
    panelKey = scope;
    const version = ++panelVersion;
    if (!dialog) {
        dialog = element('dialog', null, 'tdg-dialog');
        dialog.setAttribute('aria-label', '草稿历史');
        document.body.append(dialog);
        dialog.addEventListener('close', () => { panelVersion++; panelKey = null; });
        dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
    }
    dialog.replaceChildren();
    const heading = element('div', null, 'tdg-heading');
    heading.append(element('strong', '输入框保护'));
    const close = element('button', '关闭', 'menu_button');
    close.type = 'button'; close.onclick = () => dialog.close(); heading.append(close);
    status = element('p', '正在读取…', 'tdg-status');
    status.setAttribute('role', 'status');
    const explanation = element('p', '每 3 秒保存有变化的草稿。保留「正在写」和「上一条已发送」；再次发送才清理旧的一楼。历史仅存本浏览器。', 'tdg-note');
    dialog.append(heading, explanation, status);
    dialog.showModal();
    try {
        // Include extensions that changed .value without dispatching input.
        if (box.value !== value) input({ isTrusted: false });
        // A failed new save must not hide previously durable history.
        await Promise.resolve(flush()).catch(() => {});
        await queue;
        const meta = await store.list(scope);
        if (version !== panelVersion || scope !== key) return;
        if (failure) status.textContent = `保存失败：${failure}`;
        else status.textContent = `已读取 ${meta.current.length + meta.previous.length} 个版本。恢复前会先保存当前输入。`;
        const select = element('select', null, 'tdg-select text_pole');
        select.setAttribute('aria-label', '选择草稿版本');
        for (const [label, rows] of [['正在写 · 未发送', meta.current], ['上一条已发送 · 下次发送时清理', meta.previous]]) {
            const group = element('optgroup'); group.label = label;
            for (const row of [...rows].reverse()) {
                const option = element('option', `${new Date(row.at).toLocaleString()} · ${row.bytes / 2} 字符${row.bytes ? '' : '（空白）'}`);
                option.value = row.id; group.append(option);
            }
            if (rows.length) select.append(group);
        }
        if (!select.options.length) { status.textContent = '还没有历史。开始输入后会自动保存。'; return; }
        const preview = element('textarea', null, 'tdg-preview text_pole');
        preview.readOnly = true;
        preview.setAttribute('aria-label', '所选版本内容');
        preview.spellcheck = false;
        const actions = element('div', null, 'tdg-actions');
        const restore = element('button', '恢复到输入框', 'menu_button');
        const download = element('button', '导出所选 TXT', 'menu_button');
        restore.type = download.type = 'button';
        let selected = null, selection = 0;
        const load = async () => {
            const request = ++selection;
            selected = null; restore.disabled = download.disabled = true;
            const row = await store.read(scope, select.value);
            if (request !== selection || version !== panelVersion) return;
            selected = row;
            preview.value = row?.text ?? '该版本已清理，请关闭后重新打开。';
            restore.disabled = download.disabled = !row;
        };
        select.onchange = () => { load().catch(report); };
        restore.onclick = async () => {
            if (!selected || scope !== key || panelKey !== scope) return;
            restore.disabled = true;
            try {
                const restored = selected.text;
                // Do not overwrite the user's work if its safety save fails.
                await save(box.value, scope);
                if (scope !== key || !dialog.open) return;
                box.value = restored;
                box.dispatchEvent(new Event('input', { bubbles: true }));
                candidate = null;
                await flush();
                dialog.close(); box.focus();
            } catch (error) { report(error); }
            finally { restore.disabled = false; }
        };
        download.onclick = () => {
            if (!selected) return;
            const url = URL.createObjectURL(new Blob([selected.text], { type: 'text/plain;charset=utf-8' }));
            const link = element('a');
            link.href = url; link.download = `草稿-${new Date(selected.at).toISOString().replace(/[:.]/g, '-')}.txt`;
            link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        };
        actions.append(restore, download);
        dialog.append(select, preview, actions);
        await load();
    } catch (error) { report(error); }
}

function start() {
    if (started) return;
    box = document.querySelector('#send_textarea');
    const host = document.querySelector('#leftSendForm') || box?.parentElement;
    if (!box || !host) return;
    started = true;
    button = element('button', '↶', 'tdg-button menu_button');
    button.type = 'button'; button.id = 'tdg-open'; button.title = '草稿历史 · 每 3 秒自动保存';
    button.setAttribute('aria-label', '查看和恢复草稿历史');
    button.onclick = () => { openHistory().catch(report); };
    host.append(button);
    const ctx = context(), events = ctx.eventTypes || ctx.event_types;
    ctx.eventSource.on(events.CHAT_CHANGED, switchChat);
    ctx.eventSource.on(events.MESSAGE_SENT, onSent);
    box.addEventListener('input', input);
    box.addEventListener('compositionstart', () => { composing = true; });
    box.addEventListener('compositionend', () => { composing = false; input({ isTrusted: true }); schedule(); });
    box.addEventListener('blur', () => { flush(); });
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) flush(); else { switchChat(); schedule(); }
    });
    window.addEventListener('pagehide', () => { flush(); });
    switchChat();
    store.open().catch(report);
}

const ctx = context();
ctx.eventSource.on((ctx.eventTypes || ctx.event_types).APP_READY, start);
// Also supports enabling the extension after APP_READY has already fired.
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
else start();
