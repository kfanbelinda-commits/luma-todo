/* Wires palettes into the existing renderer without rewriting app.js.
   window.luma is provided by preload before these scripts run. */
(function () {
  function applyPalette(palette) {
    const appearance = LumaAppearance.normalize({ palette });
    document.documentElement.dataset.theme = appearance.lightMode ? 'light' : 'dark';
    document.documentElement.dataset.palette = appearance.palette;
    document.querySelectorAll('[name="palette"]').forEach((input) => {
      input.checked = input.value === appearance.palette;
    });
    const toggle = document.querySelector('#lightModeToggle');
    if (toggle) toggle.checked = appearance.lightMode;
    return appearance;
  }

  if (!document.querySelector('#lightModeToggle')) {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = 'lightModeToggle';
    input.hidden = true;
    document.body.appendChild(input);
  }

  const luma = window.luma;
  if (luma && typeof luma.load === 'function') {
    const originalLoad = luma.load.bind(luma);
    luma.load = async () => {
      const state = await originalLoad();
      if (state?.settings) Object.assign(state.settings, LumaAppearance.normalize(state.settings));
      queueMicrotask(() => applyPalette(state?.settings?.palette));
      return state;
    };
  }
  if (luma && typeof luma.save === 'function') {
    const originalSave = luma.save.bind(luma);
    luma.save = async (state) => {
      if (state?.settings) {
        Object.assign(state.settings, LumaAppearance.normalize({
          palette: document.documentElement.dataset.palette || state.settings.palette,
          lightMode: state.settings.lightMode,
        }));
      }
      return originalSave(state);
    };
  }

  document.addEventListener('change', (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.name !== 'palette' || !input.checked) return;
    const appearance = applyPalette(input.value);
    const toggle = document.querySelector('#lightModeToggle');
    if (toggle && toggle.checked !== appearance.lightMode) {
      toggle.checked = appearance.lightMode;
      toggle.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });

  window.LumaAppearanceApply = applyPalette;

  function relocateOverdueChip(item) {
    const date = item.querySelector('.task-date-label');
    const chip = item.querySelector('.overdue-chip');
    if (!date) {
      chip?.remove();
      return item;
    }
    if (date.querySelector('.overdue-mark')) {
      chip?.remove();
      item.querySelectorAll(':scope > .overdue-mark, .task-actions > .overdue-mark').forEach((node) => node.remove());
      return item;
    }

    const source = (chip && chip.textContent) || '';
    const match = source.match(/(\d+)/);
    const days = match ? Number(match[1]) : 0;
    if (!chip && !days) return item;

    const dueNode = date.querySelector('.task-due');
    const dueText = (dueNode ? dueNode.textContent : date.textContent).replace(/\s*\+\d+\s*/g, '').trim();
    date.classList.add('is-overdue');
    date.removeAttribute('title');
    date.textContent = '';
    const mark = document.createElement('span');
    mark.className = 'overdue-mark';
    mark.textContent = `+${days || 1}`;
    const due = document.createElement('span');
    due.className = 'task-due';
    due.textContent = dueText;
    date.append(mark, due);

    item.querySelectorAll(':scope > .overdue-mark, .task-actions > .overdue-mark').forEach((node) => {
      if (node !== mark) node.remove();
    });
    chip?.remove();
    const meta = item.querySelector('.task-meta');
    if (meta && !meta.children.length) meta.remove();
    return item;
  }

  function bindProgressToggle(group) {
    const actions = group.querySelector('.project-header-actions');
    let progress = group.querySelector('.project-progress');
    if (!progress || !actions) return;
    if (progress.parentElement !== actions) actions.insertBefore(progress, actions.firstChild);

    const hiddenToggle = group.querySelector('.completed-toggle');
    if (!hiddenToggle || progress.dataset.boundToggle === '1') return;

    const button = progress.tagName === 'BUTTON' ? progress : document.createElement('button');
    if (button !== progress) {
      button.type = 'button';
      button.className = `${progress.className} is-toggle`.trim();
      button.textContent = progress.textContent;
      progress.replaceWith(button);
      progress = button;
    } else {
      button.classList.add('is-toggle');
    }
    button.dataset.boundToggle = '1';
    button.setAttribute('aria-expanded', hiddenToggle.getAttribute('aria-expanded') || 'false');
    button.title = button.getAttribute('aria-expanded') === 'true' ? '收起已完成任务' : '查看已完成任务';
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      hiddenToggle.click();
    });
  }

  function installRowPatches() {
    if (typeof taskElement === 'function' && taskElement.name !== 'patchedTaskElement') {
      const originalTaskElement = taskElement;
      taskElement = function patchedTaskElement(task) {
        return relocateOverdueChip(originalTaskElement(task));
      };
    }
    if (typeof renderProjects === 'function' && renderProjects.name !== 'patchedRenderProjects') {
      const originalRenderProjects = renderProjects;
      renderProjects = function patchedRenderProjects() {
        originalRenderProjects();
        document.querySelectorAll('.project-group').forEach(bindProgressToggle);
      };
    }
    document.querySelectorAll('.project-group').forEach(bindProgressToggle);
    document.querySelectorAll('.task-item').forEach(relocateOverdueChip);
  }

  function loadWeekView() {
    if (document.querySelector('script[src="src/week-view.js"]')) return;
    const script = document.createElement('script');
    script.src = 'src/week-view.js';
    document.body.appendChild(script);
  }

  installRowPatches();
  loadWeekView();
  document.addEventListener('DOMContentLoaded', () => {
    installRowPatches();
    loadWeekView();
  });
})();
