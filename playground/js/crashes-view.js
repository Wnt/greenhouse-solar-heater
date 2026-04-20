/**
 * #crashes view.
 *
 * Lists rows from GET /api/script/crashes. Clicking a row lazy-loads
 * the full GET /api/script/crashes/:id payload (which includes the
 * ring buffer of pre-crash state snapshots) and toggles an expanded
 * detail section. "Copy JSON" puts the whole row on the clipboard so
 * it's easy to paste into a bug report or chat.
 */

function formatTs(ms) {
  if (!ms) return '—';
  try {
    return new Date(ms).toLocaleString('en-GB', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    });
  } catch (e) {
    return String(ms);
  }
}

function truncate(s, n) {
  if (!s) return '';
  if (s.length <= n) return s;
  return s.slice(0, n) + '…';
}

function detailTemplate(row) {
  const copyBtn = '<button class="crashes-copy" type="button">Copy JSON</button>';
  const detail = JSON.stringify({
    id: row.id,
    ts: new Date(row.ts).toISOString(),
    error_msg: row.error_msg,
    error_trace: row.error_trace,
    sys_status: row.sys_status,
    recent_states: row.recent_states,
    resolved_at: row.resolved_at ? new Date(row.resolved_at).toISOString() : null,
  }, null, 2);
  return '<div class="crashes-detail">' + escapeHtml(detail) + '</div>' + copyBtn;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderList(list, empty, crashes) {
  list.innerHTML = '';
  if (!crashes || crashes.length === 0) {
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  for (const row of crashes) {
    const li = document.createElement('li');
    li.dataset.id = row.id;
    const resolved = row.resolved_at
      ? '<span class="crashes-resolved">resolved ' + formatTs(row.resolved_at) + '</span>'
      : '';
    li.innerHTML =
      '<div class="crashes-summary">' +
        '<span class="crashes-msg">' + escapeHtml(truncate(row.error_msg || '(no error message)', 120)) + '</span>' +
        '<span class="crashes-ts">' + formatTs(row.ts) + resolved + '</span>' +
      '</div>';
    li.addEventListener('click', (e) => toggleDetail(li, row.id, e));
    list.appendChild(li);
  }
}

function toggleDetail(li, id, event) {
  // Clicks inside the copy button bubble — ignore them so the detail
  // doesn't collapse when the user is trying to copy.
  if (event && event.target && event.target.classList.contains('crashes-copy')) return;

  const existing = li.querySelector('.crashes-detail');
  if (existing) {
    existing.remove();
    const btn = li.querySelector('.crashes-copy');
    if (btn) btn.remove();
    return;
  }
  // Fetch full detail and render.
  fetch('/api/script/crashes/' + encodeURIComponent(id), { credentials: 'include' })
    .then(r => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)))
    .then(row => {
      li.insertAdjacentHTML('beforeend', detailTemplate(row));
      const copyBtn = li.querySelector('.crashes-copy');
      if (copyBtn) {
        copyBtn.addEventListener('click', () => {
          const detailEl = li.querySelector('.crashes-detail');
          if (!detailEl) return;
          navigator.clipboard.writeText(detailEl.textContent)
            .then(() => {
              copyBtn.textContent = 'Copied';
              setTimeout(() => { copyBtn.textContent = 'Copy JSON'; }, 1500);
            })
            .catch(() => {
              copyBtn.textContent = 'Copy failed';
              setTimeout(() => { copyBtn.textContent = 'Copy JSON'; }, 1500);
            });
        });
      }
    })
    .catch(err => {
      li.insertAdjacentHTML('beforeend',
        '<div class="crashes-detail">Failed to load: ' + escapeHtml(err.message) + '</div>');
    });
}

/**
 * Mounts the #crashes view. Fetches the crash list and wires rendering.
 * Returns an unmount function (noop — nothing to tear down).
 */
export function mountCrashesView() {
  const list = document.getElementById('crashes-list');
  const empty = document.getElementById('crashes-empty');
  if (!list || !empty) return () => {};

  list.innerHTML = '<li style="cursor:default;opacity:0.6;">Loading…</li>';
  fetch('/api/script/crashes?limit=50', { credentials: 'include' })
    .then(r => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)))
    .then(json => renderList(list, empty, json.crashes || []))
    .catch(err => {
      list.innerHTML = '';
      empty.style.display = 'block';
      empty.textContent = 'Failed to load crashes: ' + (err && err.message || err);
    });

  return () => {};
}
