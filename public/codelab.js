const STORAGE_KEY = 'qnx-pulse-codelab-completed-v1';
const TOTAL_STEPS = 7;

function loadCompleted() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

function saveCompleted(set) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(set)));
  } catch {
    // ignore private mode storage limits
  }
}

const completed = loadCompleted();

function renderProgress() {
  const count = completed.size;
  const pct = Math.round((count / TOTAL_STEPS) * 100);

  document.getElementById('progressLabel').textContent = `${count} of ${TOTAL_STEPS} completed`;
  document.getElementById('progressPct').textContent = `${pct}%`;
  document.getElementById('progressFill').style.width = `${pct}%`;

  const badge = document.getElementById('headerProgressBadge');
  badge.textContent = `${count} / ${TOTAL_STEPS} steps`;
  badge.className = count === TOTAL_STEPS ? 'status-chip status-pass' : 'status-chip status-neutral';

  document.querySelectorAll('.toc-item').forEach((li) => {
    const step = Number.parseInt(li.getAttribute('data-step'), 10);
    li.classList.toggle('done', completed.has(step));
  });

  document.querySelectorAll('[data-step-card]').forEach((card) => {
    const step = Number.parseInt(card.getAttribute('data-step-card'), 10);
    const isDone = completed.has(step);
    card.classList.toggle('completed', isDone);
    const btn = card.querySelector('.step-toggle');
    if (btn) {
      btn.textContent = isDone ? 'Done' : 'Mark done';
      btn.className = isDone ? 'tb-btn active step-toggle' : 'tb-btn step-toggle';
    }
  });
}

document.querySelectorAll('.step-toggle').forEach((btn) => {
  btn.addEventListener('click', () => {
    const step = Number.parseInt(btn.getAttribute('data-toggle-step'), 10);
    if (completed.has(step)) completed.delete(step);
    else completed.add(step);
    saveCompleted(completed);
    renderProgress();
  });
});

document.getElementById('btnResetProgress').addEventListener('click', () => {
  completed.clear();
  saveCompleted(completed);
  renderProgress();
});

// 1-click Copy Command buttons
document.querySelectorAll('.copy-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const pre = btn.closest('.code-block')?.querySelector('pre');
    if (!pre) return;
    try {
      await navigator.clipboard.writeText(pre.textContent.trim());
      btn.textContent = 'Copied';
      setTimeout(() => {
        btn.textContent = 'Copy';
      }, 1400);
    } catch {
      btn.textContent = 'Ctrl+C';
      setTimeout(() => {
        btn.textContent = 'Copy';
      }, 1400);
    }
  });
});

// Interactive Before / After Diff switcher
document.querySelectorAll('.diff-mode-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const mode = btn.getAttribute('data-diff');
    document.querySelectorAll('.diff-mode-btn').forEach((b) => b.classList.toggle('active', b === btn));
    const container = document.getElementById('diffContainer');
    const beforeBox = document.getElementById('diffBefore');
    const afterBox = document.getElementById('diffAfter');

    if (mode === 'split') {
      container.style.gridTemplateColumns = '';
      beforeBox.classList.remove('hidden');
      afterBox.classList.remove('hidden');
    } else if (mode === 'before') {
      container.style.gridTemplateColumns = '1fr';
      beforeBox.classList.remove('hidden');
      afterBox.classList.add('hidden');
    } else {
      container.style.gridTemplateColumns = '1fr';
      beforeBox.classList.add('hidden');
      afterBox.classList.remove('hidden');
    }
  });
});

renderProgress();
