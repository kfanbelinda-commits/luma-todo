/* Lifelog: separate from todo state. Demo uses lifelog.json + lifelog-media. */
(function () {
  const WEATHER = [
    { id: "sunny", label: "晴", emoji: "☀️" },
    { id: "cloudy", label: "云", emoji: "☁️" },
    { id: "rainy", label: "雨", emoji: "🌧" },
    { id: "windy", label: "风", emoji: "🌬" },
    { id: "snowy", label: "雪", emoji: "❄️" },
    { id: "storm", label: "雷", emoji: "⛈" },
  ];
  const MOODS = [
    { id: "great", label: "超棒", emoji: "😄" },
    { id: "good", label: "不错", emoji: "🙂" },
    { id: "okay", label: "还行", emoji: "😐" },
    { id: "calm", label: "平静", emoji: "😌" },
    { id: "low", label: "低落", emoji: "😔" },
    { id: "awful", label: "糟糕", emoji: "😣" },
  ];
  const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

  let store = { version: 1, entries: {} };
  let mediaCache = new Map();
  let view = "month";
  let cursor = new Date();
  let noteTimer = 0;
  let ready = false;

  function pad(n) { return String(n).padStart(2, "0"); }
  function toKey(date) {
    return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
  }
  function parseKey(key) {
    const [y, m, d] = String(key || toKey(new Date())).split("-").map(Number);
    return new Date(y, m - 1, d, 12, 0, 0, 0);
  }
  function weatherMeta(id) { return WEATHER.find((item) => item.id === id) || null; }
  function moodMeta(id) { return MOODS.find((item) => item.id === id) || null; }
  function emptyEntry() {
    return { weather: "", mood: "", note: "", photos: [], coverPhotoId: null, updatedAt: Date.now() };
  }
  function entryFor(key) {
    if (!store.entries[key]) store.entries[key] = emptyEntry();
    return store.entries[key];
  }

  async function loadStore() {
    const loaded = await window.luma?.lifelogLoad?.();
    store = {
      version: 1,
      entries: loaded?.entries && typeof loaded.entries === "object" ? loaded.entries : {},
    };
    mediaCache = new Map();
    ready = true;
  }

  async function saveStore() {
    await window.luma?.lifelogSave?.({ version: 1, entries: store.entries });
  }

  async function mediaUrl(relativePath) {
    if (!relativePath) return null;
    if (mediaCache.has(relativePath)) return mediaCache.get(relativePath);
    const url = await window.luma?.lifelogMediaDataUrl?.(relativePath);
    if (url) mediaCache.set(relativePath, url);
    return url || null;
  }

  async function coverUrl(entry) {
    if (!entry?.photos?.length) return null;
    const cover = entry.photos.find((photo) => photo.id === entry.coverPhotoId) || entry.photos[0];
    return cover ? mediaUrl(cover.path) : null;
  }

  function ensureBoard() {
    const panel = document.querySelector("#calendarPanel");
    if (!panel) return null;
    let board = document.querySelector("#lifeLogBoard");
    if (!board) {
      board = document.createElement("div");
      board.id = "lifeLogBoard";
      board.className = "lifelog-board hidden";
      board.setAttribute("aria-label", "Lifelog");
      const grid = document.querySelector("#calendarGrid");
      if (grid?.parentElement) grid.parentElement.insertBefore(board, grid.nextSibling);
      else panel.appendChild(board);
    }
    return board;
  }

  function ensureSwitcher() {
    const controls = document.querySelector(".month-controls");
    if (!controls) return null;
    let wrap = controls.querySelector(".calendar-view-switch");
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.className = "calendar-view-switch";
      wrap.setAttribute("role", "group");
      wrap.setAttribute("aria-label", "日历视图");
      wrap.innerHTML = ""
        + '<button type="button" class="calendar-view-button" data-calendar-view="month" aria-pressed="true">月</button>'
        + '<button type="button" class="calendar-view-button" data-calendar-view="week" aria-pressed="false">周</button>'
        + '<button type="button" class="calendar-view-button" data-calendar-view="lifelog" aria-pressed="false">LifeLog</button>';
      controls.insertBefore(wrap, controls.firstChild);
    } else if (!wrap.querySelector('[data-calendar-view="lifelog"]')) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "calendar-view-button";
      btn.dataset.calendarView = "lifelog";
      btn.setAttribute("aria-pressed", "false");
      btn.textContent = "LifeLog";
      wrap.appendChild(btn);
    }
    if (wrap.dataset.lifelogBound !== "1") {
      wrap.dataset.lifelogBound = "1";
      wrap.addEventListener("click", (event) => {
        const button = event.target.closest("[data-calendar-view]");
        if (!button) return;
        if (button.dataset.calendarView === "lifelog") {
          event.preventDefault();
          event.stopImmediatePropagation();
          setView("lifelog");
          return;
        }
        // Month/Week: hide Lifelog, let week-view / month handlers continue.
        view = button.dataset.calendarView;
        syncChrome();
      }, true);
    }
    return wrap;
  }

  function syncChrome() {
    document.querySelectorAll("[data-calendar-view]").forEach((button) => {
      button.setAttribute("aria-pressed", button.dataset.calendarView === view ? "true" : "false");
    });
    const panel = document.querySelector("#calendarPanel");
    panel?.classList.toggle("is-lifelog", view === "lifelog");
    panel?.classList.toggle("is-week", view === "week");
    const board = ensureBoard();
    const grid = document.querySelector("#calendarGrid");
    const weekdays = document.querySelector(".weekdays");
    const weekBoard = document.querySelector("#weekBoard");
    if (view === "lifelog") {
      board?.classList.remove("hidden");
      if (grid) grid.hidden = true;
      if (weekdays) weekdays.hidden = true;
      weekBoard?.classList.add("hidden");
    } else {
      board?.classList.add("hidden");
      if (view === "month") {
        if (grid) grid.hidden = false;
        if (weekdays) weekdays.hidden = false;
      }
    }
  }

  async function renderBoard() {
    const board = ensureBoard();
    if (!board || view !== "lifelog") return;
    const year = cursor.getFullYear();
    const month = cursor.getMonth();
    const start = new Date(year, month, 1, 12);
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const firstOffset = (start.getDay() + 6) % 7;
    const keys = [];
    for (let d = 1; d <= daysInMonth; d++) keys.push(toKey(new Date(year, month, d, 12)));

    let daysWith = 0;
    let photos = 0;
    const moodCount = {};
    for (const key of keys) {
      const entry = store.entries[key];
      if (!entry) continue;
      if (entry.note || entry.mood || entry.weather || entry.photos?.length) daysWith += 1;
      photos += entry.photos?.length || 0;
      if (entry.mood) moodCount[entry.mood] = (moodCount[entry.mood] || 0) + 1;
    }
    const topMoodId = Object.entries(moodCount).sort((a, b) => b[1] - a[1])[0]?.[0];
    const topMood = moodMeta(topMoodId);

    const title = document.querySelector("#monthTitle");
    if (title) title.textContent = year + " 年 " + (month + 1) + " 月";
    const lunar = document.querySelector("#monthLunar");
    if (lunar) lunar.textContent = "Lifelog";

    const cells = [];
    for (let i = 0; i < firstOffset; i++) cells.push('<div class="lifelog-cell empty" aria-hidden="true"></div>');

    for (let d = 1; d <= daysInMonth; d++) {
      const key = keys[d - 1];
      const entry = store.entries[key];
      const has = Boolean(entry && (entry.note || entry.mood || entry.weather || entry.photos?.length));
      const cover = entry ? await coverUrl(entry) : null;
      const weather = weatherMeta(entry?.weather);
      const mood = moodMeta(entry?.mood);
      const cls = cover ? "has-img" : has ? "has-note" : "no-note";
      cells.push(
        '<button type="button" class="lifelog-cell ' + cls + '" data-date="' + key + '">'
        + (cover ? '<img class="lifelog-cell-img" src="' + cover + '" alt="">' : "")
        + '<span class="lifelog-day-num">' + d + "</span>"
        + (has && !cover ? '<span class="lifelog-cell-footer"><span>' + (weather?.emoji || "") + "</span><span>" + (mood?.emoji || "") + "</span></span>" : "")
        + "</button>"
      );
    }

    board.innerHTML = ""
      + '<div class="lifelog-header">'
      + '<div class="lifelog-title-zone"><h2 class="lifelog-title">Lifelog</h2><div class="lifelog-meta">' + (month + 1) + " 月 " + year + "</div></div>"
      + '<div class="lifelog-pills">'
      + '<div class="lifelog-pill">📝 ' + daysWith + " Days</div>"
      + '<div class="lifelog-pill">📷 ' + photos + " Photos</div>"
      + (topMood ? '<div class="lifelog-pill">✨ Most ' + topMood.emoji + "</div>" : "")
      + "</div></div>"
      + '<div class="lifelog-weekdays">' + WEEKDAYS.map((label) => "<span>" + label + "</span>").join("") + "</div>"
      + '<div class="lifelog-grid">' + cells.join("") + "</div>";

    board.querySelectorAll(".lifelog-cell[data-date]").forEach((cell) => {
      cell.addEventListener("click", () => {
        if (typeof openCalendarDetail === "function") openCalendarDetail(cell.dataset.date);
      });
    });
  }

  function ensureDetailMount() {
    const detail = document.querySelector("#calendarDetailView");
    if (!detail) return null;
    let section = document.querySelector("#lifeLogDetail");
    if (!section) {
      section = document.createElement("section");
      section.id = "lifeLogDetail";
      section.className = "calendar-detail-section lifelog-detail";
      const addBtn = document.querySelector("#addCalendarItem");
      if (addBtn) detail.insertBefore(section, addBtn);
      else detail.appendChild(section);
    }
    return section;
  }

  function pickerField(kind, entry) {
    const list = kind === "weather" ? WEATHER : MOODS;
    const selected = list.find((item) => item.id === entry[kind]);
    const label = kind === "weather" ? "天气" : "心情";
    const icon = selected ? selected.emoji : "＋";
    const options = list.map((item) => (
      '<button type="button" class="lifelog-chip' + (entry[kind] === item.id ? " is-active" : "") + '" data-id="' + item.id + '" role="option">'
      + '<span class="lifelog-chip-emoji">' + item.emoji + '</span>'
      + '<span class="lifelog-chip-label">' + item.label + "</span>"
      + "</button>"
    )).join("");
    return ""
      + '<div class="lifelog-field" data-kind="' + kind + '">'
      + '<span class="lifelog-field-label">' + label + "</span>"
      + '<button type="button" class="lifelog-pick' + (selected ? " has-value" : "") + '" data-kind="' + kind + '" aria-label="' + label + '" aria-haspopup="listbox" aria-expanded="false">'
      + '<span class="lifelog-pick-icon">' + icon + "</span>"
      + "</button>"
      + '<div class="lifelog-menu hidden" role="listbox" hidden>' + options + "</div>"
      + "</div>";
  }

  async function renderDetail(dateKey) {
    const section = ensureDetailMount();
    if (!section || !dateKey) return;
    const entry = entryFor(dateKey);
    const cover = await coverUrl(entry);
    section.innerHTML = ""
      + '<div class="calendar-detail-section-title"><span>Lifelog</span><span class="calendar-detail-count">生活记录</span></div>'
      + '<div class="lifelog-pick-row">'
      + pickerField("weather", entry)
      + pickerField("mood", entry)
      + "</div>"
      + '<label class="lifelog-note-label" for="lifeLogNote">一两句话</label>'
      + '<textarea id="lifeLogNote" class="lifelog-note" rows="3" maxlength="280" placeholder="今天发生了什么…">' + (entry.note || "").replace(/</g, "&lt;") + "</textarea>"
      + '<div class="lifelog-photos">'
      + (cover ? '<img class="lifelog-photo-thumb" src="' + cover + '" alt="">' : '<div class="lifelog-photo-empty">demo 封面会显示在这里；真实选图下一步再加</div>')
      + "</div>";

    function closeMenus(except) {
      section.querySelectorAll(".lifelog-field").forEach((field) => {
        if (except && field === except) return;
        const pick = field.querySelector(".lifelog-pick");
        const menu = field.querySelector(".lifelog-menu");
        pick?.classList.remove("is-open");
        pick?.setAttribute("aria-expanded", "false");
        menu?.classList.add("hidden");
        menu?.setAttribute("hidden", "");
      });
    }

    section.querySelectorAll(".lifelog-field").forEach((field) => {
      const kind = field.dataset.kind;
      const pick = field.querySelector(".lifelog-pick");
      const menu = field.querySelector(".lifelog-menu");
      pick?.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const willOpen = menu?.classList.contains("hidden");
        closeMenus(field);
        if (willOpen) {
          menu.classList.remove("hidden");
          menu.removeAttribute("hidden");
          pick.classList.add("is-open");
          pick.setAttribute("aria-expanded", "true");
        }
      });
      menu?.addEventListener("click", async (event) => {
        const chip = event.target.closest(".lifelog-chip");
        if (!chip) return;
        event.preventDefault();
        event.stopPropagation();
        const current = entryFor(dateKey);
        current[kind] = current[kind] === chip.dataset.id ? "" : chip.dataset.id;
        current.updatedAt = Date.now();
        await saveStore();
        await renderDetail(dateKey);
        if (view === "lifelog") await renderBoard();
      });
    });

    document.addEventListener("click", (event) => {
      if (!section.contains(event.target)) closeMenus();
    }, { once: true });

    const note = section.querySelector("#lifeLogNote");
    note?.addEventListener("input", () => {
      window.clearTimeout(noteTimer);
      noteTimer = window.setTimeout(async () => {
        const current = entryFor(dateKey);
        current.note = note.value.trim();
        current.updatedAt = Date.now();
        await saveStore();
        if (view === "lifelog") await renderBoard();
      }, 350);
    });
  }

async function setView(next) {
    if (next !== "lifelog") return;
    view = "lifelog";
    syncChrome();
    cursor = (typeof calendarCursor !== "undefined" && calendarCursor instanceof Date)
      ? new Date(calendarCursor.getFullYear(), calendarCursor.getMonth(), 1)
      : new Date();
    await renderBoard();
  }

  function wrapOpenDetail() {
    if (typeof openCalendarDetail !== "function") return;
    if (openCalendarDetail.__lifelogWrapped) return;
    const original = openCalendarDetail;
    openCalendarDetail = function lifelogAwareOpen(dateKey) {
      original(dateKey);
      queueMicrotask(() => { renderDetail(dateKey); });
    };
    openCalendarDetail.__lifelogWrapped = true;
  }

  function wrapMonthNav() {
    if (typeof changeCalendarMonth === "function" && changeCalendarMonth.name !== "lifelogAwareChange") {
      const original = changeCalendarMonth;
      changeCalendarMonth = function lifelogAwareChange(offset, animate) {
        if (view === "lifelog") {
          cursor = new Date(cursor.getFullYear(), cursor.getMonth() + offset, 1);
          if (typeof calendarCursor !== "undefined") calendarCursor = new Date(cursor);
          renderBoard();
          return;
        }
        return original(offset, animate);
      };
    }
  }

  async function boot() {
    ensureSwitcher();
    ensureBoard();
    wrapOpenDetail();
    wrapMonthNav();
    await loadStore();
    syncChrome();
    if (typeof calendarDetailDate === "string" && calendarDetailDate) await renderDetail(calendarDetailDate);
  }

  window.LumaLifelog = {
    boot,
    setView,
    reload: loadStore,
    renderBoard,
    renderDetail,
    getStore: () => store,
  };

  boot();
  document.addEventListener("DOMContentLoaded", boot);
})();
