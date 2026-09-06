/* Lifelog: separate from todo state. Demo uses lifelog.json + lifelog-media. */
(function () {
  const WEATHER = [
    { id: "sunny", label: "晴", color: "#E8C547", file: "weather-sunny.svg" },
    { id: "cloudy", label: "云", color: "#A8B4C0", file: "weather-cloudy.svg" },
    { id: "rainy", label: "雨", color: "#8FA4B8", file: "weather-rainy.svg" },
    { id: "foggy", label: "雾", color: "#B0B6BE", file: "weather-foggy.svg" },
    { id: "snowy", label: "雪", color: "#C5CCD4", file: "weather-snowy.svg" },
    { id: "storm", label: "雷", color: "#6B7C8F", file: "weather-stormy.svg" },
  ];
  const MOODS = [
    { id: "great", label: "超棒", color: "#E8C547", file: "mood-great.svg" },
    { id: "good", label: "不错", color: "#D4C07A", file: "mood-good.svg" },
    { id: "okay", label: "还行", color: "#B8A88A", file: "mood-okay.svg" },
    { id: "calm", label: "平静", color: "#8FA896", file: "mood-calm.svg" },
    { id: "low", label: "低落", color: "#7E93A8", file: "mood-low.svg" },
    { id: "awful", label: "糟糕", color: "#B87A72", file: "mood-bad.svg" },
  ];
  const ICON_BASE = "src/lifelog-icons/";
  const MOOD_EMPTY = ICON_BASE + "mood-empty.svg";
  const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];
  const WEEKDAYS_SUN = ["日", "一", "二", "三", "四", "五", "六"];
  const MAX_PHOTOS = 9;

  function iconImg(item, size, extraClass) {
    if (!item || !item.file) {
      return '<img class="lifelog-ico ' + (extraClass || "") + '" src="' + MOOD_EMPTY + '" width="' + size + '" height="' + size + '" alt="" aria-hidden="true">';
    }
    return '<img class="lifelog-ico ' + (extraClass || "") + '" src="' + ICON_BASE + item.file + '" width="' + size + '" height="' + size + '" alt="' + escapeHtml(item.label || "") + '" style="--mood:' + (item.color || "#C5CCD4") + '">';
  }

  let store = { version: 1, entries: {} };
  let mediaCache = new Map();
  let view = "month";
  let cursor = new Date();
  let noteTimers = new Map();
  let notePersistChain = Promise.resolve();
  let ready = false;
  let currentDetailDate = null;
  let viewingPhotoId = null;
  let detailSectionPasteBound = false;
  let persistStatus = "idle";
  let savedStatusTimer = 0;
  let noticeTimer = 0;
  let undo = null;
  let menuDocBound = false;

  function pad(n) { return String(n).padStart(2, "0"); }
  function toKey(date) {
    return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
  }
  function todayKey() { return toKey(new Date()); }
  function parseKey(key) {
    const [y, m, d] = String(key || todayKey()).split("-").map(Number);
    return new Date(y, m - 1, d, 12, 0, 0, 0);
  }
  function weatherMeta(id) { return WEATHER.find((item) => item.id === id) || null; }
  function moodMeta(id) { return MOODS.find((item) => item.id === id) || null; }
  function emptyEntry() {
    return { weather: "", mood: "", note: "", photos: [], coverPhotoId: null, updatedAt: Date.now() };
  }
  function entryFor(key) {
    if (!store.entries[key]) store.entries[key] = emptyEntry();
    const entry = store.entries[key];
    if (entry.weather === "windy") entry.weather = "foggy";
    if (entry.mood === "bad") entry.mood = "awful";
    return entry;
  }
  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&" + "amp;")
      .replace(/</g, "&" + "lt;")
      .replace(/>/g, "&" + "gt;")
      .replace(/"/g, "&" + "quot;");
  }
  function noteExcerpt(text) {
    const compact = String(text || "").replace(/\s+/g, " ").trim();
    if (!compact) return "";
    return compact.length > 28 ? compact.slice(0, 28) + "…" : compact;
  }
  function dateSpoken(key) {
    const date = parseKey(key);
    return date.getFullYear() + "年" + (date.getMonth() + 1) + "月" + date.getDate() + "日 周" + WEEKDAYS_SUN[date.getDay()];
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

  function applyNoteDraft(dateKey, text) {
    if (!dateKey) return;
    const current = entryFor(dateKey);
    current.note = String(text ?? "");
    current.updatedAt = Date.now();
  }

  function paintPersistStatus() {
    const el = document.querySelector("#lifeLogSaveStatus");
    if (!el) return;
    el.classList.remove("is-saving", "is-saved", "is-error");
    if (persistStatus === "saving") {
      el.hidden = false;
      el.classList.add("is-saving");
      el.textContent = "保存中";
    } else if (persistStatus === "saved") {
      el.hidden = false;
      el.classList.add("is-saved");
      el.textContent = "已保存";
    } else if (persistStatus === "error") {
      el.hidden = false;
      el.classList.add("is-error");
      el.innerHTML = '<button type="button" class="lifelog-save-retry" data-lifelog-act="retry">保存失败，重试</button>';
    } else {
      el.hidden = true;
      el.textContent = "";
    }
  }

  function showNotice(text) {
    const el = document.querySelector("#lifeLogNotice");
    if (!el) return;
    el.hidden = false;
    el.textContent = text;
    window.clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(() => {
      if (el.textContent === text) {
        el.hidden = true;
        el.textContent = "";
      }
    }, 2800);
  }

  function paintUndo() {
    const el = document.querySelector("#lifeLogUndo");
    if (!el) return;
    if (!undo) {
      el.hidden = true;
      el.innerHTML = "";
      return;
    }
    el.hidden = false;
    el.innerHTML = '已删除照片 <button type="button" class="lifelog-undo-btn" data-lifelog-act="undo">撤销</button>';
  }

  function enqueuePersist() {
    persistStatus = "saving";
    paintPersistStatus();
    notePersistChain = notePersistChain
      .then(async () => {
        await saveStore();
        persistStatus = "saved";
        paintPersistStatus();
        window.clearTimeout(savedStatusTimer);
        savedStatusTimer = window.setTimeout(() => {
          if (persistStatus === "saved") {
            persistStatus = "idle";
            paintPersistStatus();
          }
        }, 1600);
        if (view === "lifelog") await renderBoard();
      })
      .catch(() => {
        persistStatus = "error";
        paintPersistStatus();
      });
    return notePersistChain;
  }

  function scheduleNotePersist(dateKey) {
    if (!dateKey) return;
    const prev = noteTimers.get(dateKey);
    if (prev) window.clearTimeout(prev);
    const timer = window.setTimeout(() => {
      noteTimers.delete(dateKey);
      const entry = store.entries[dateKey];
      if (entry) entry.note = String(entry.note || "").trim();
      enqueuePersist();
    }, 350);
    noteTimers.set(dateKey, timer);
  }

  async function flushNotePersist(dateKey) {
    if (!dateKey) return;
    const timer = noteTimers.get(dateKey);
    if (timer) {
      window.clearTimeout(timer);
      noteTimers.delete(dateKey);
    }
    const entry = store.entries[dateKey];
    if (entry) entry.note = String(entry.note || "").trim();
    await enqueuePersist();
  }

  async function flushAllNotes() {
    const live = document.querySelector("#lifeLogNote");
    if (currentDetailDate && live) applyNoteDraft(currentDetailDate, live.value);
    for (const [key, timer] of [...noteTimers]) {
      window.clearTimeout(timer);
      noteTimers.delete(key);
      const entry = store.entries[key];
      if (entry) entry.note = String(entry.note || "").trim();
    }
    await enqueuePersist();
  }

  async function mediaUrl(relativePath) {
    if (!relativePath) return null;
    if (mediaCache.has(relativePath)) return mediaCache.get(relativePath);
    try {
      const url = await window.luma?.lifelogMediaDataUrl?.(relativePath);
      if (url) mediaCache.set(relativePath, url);
      return url || null;
    } catch {
      return null;
    }
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
      board.setAttribute("aria-label", "生活记录");
      const grid = document.querySelector("#calendarGrid");
      if (grid?.parentElement) grid.parentElement.insertBefore(board, grid.nextSibling);
      else panel.appendChild(board);
    }
    return board;
  }

  function defaultEyebrow() {
    const eyebrow = document.querySelector("#calendarPanel .eyebrow");
    if (!eyebrow) return;
    if (!eyebrow.dataset.defaultText) eyebrow.dataset.defaultText = eyebrow.textContent || "计划与时间节点";
    return eyebrow;
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
        view = button.dataset.calendarView;
        syncChrome();
        if (typeof closeCalendarDetail === "function") closeCalendarDetail();
        else {
          const detail = document.querySelector("#calendarDetail");
          document.querySelector("#calendarPanel")?.classList.remove("calendar-detail-open");
          detail?.classList.add("hidden");
          detail?.setAttribute("aria-hidden", "true");
        }
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
    const eyebrow = defaultEyebrow();
    if (view === "lifelog") {
      board?.classList.remove("hidden");
      if (grid) grid.hidden = true;
      if (weekdays) weekdays.hidden = true;
      weekBoard?.classList.add("hidden");
      if (eyebrow) eyebrow.textContent = "日子与片刻";
    } else {
      board?.classList.add("hidden");
      if (view === "month") {
        if (grid) grid.hidden = false;
        if (weekdays) weekdays.hidden = false;
      }
      if (eyebrow && eyebrow.dataset.defaultText) eyebrow.textContent = eyebrow.dataset.defaultText;
    }
  }

  function goLifelogMonth(date) {
    cursor = new Date(date.getFullYear(), date.getMonth(), 1, 12);
    if (typeof calendarCursor !== "undefined") calendarCursor = new Date(cursor);
    return renderBoard();
  }

  function shiftLifelogMonth(offset) {
    return goLifelogMonth(new Date(cursor.getFullYear(), cursor.getMonth() + offset, 1));
  }

  function goLifelogToday() {
    return goLifelogMonth(new Date());
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
    let photoCount = 0;
    const moodCount = {};
    for (const key of keys) {
      const entry = store.entries[key];
      if (!entry) continue;
      if (entry.note || entry.mood || entry.weather || entry.photos?.length) daysWith += 1;
      photoCount += entry.photos?.length || 0;
      if (entry.mood) moodCount[entry.mood] = (moodCount[entry.mood] || 0) + 1;
    }
    const topMoodId = Object.entries(moodCount).sort((a, b) => b[1] - a[1])[0]?.[0];
    const topMood = moodMeta(topMoodId);

    const title = document.querySelector("#monthTitle");
    if (title) title.textContent = year + " 年 " + (month + 1) + " 月";
    const lunar = document.querySelector("#monthLunar");
    if (lunar) lunar.textContent = "本月记录";
    const eyebrow = defaultEyebrow();
    if (eyebrow) eyebrow.textContent = "日子与片刻";

    const cells = [];
    for (let i = 0; i < firstOffset; i++) cells.push('<div class="lifelog-cell empty" aria-hidden="true"></div>');

    const today = todayKey();
    for (let d = 1; d <= daysInMonth; d++) {
      const key = keys[d - 1];
      const entry = store.entries[key];
      const has = Boolean(entry && (entry.note || entry.mood || entry.weather || entry.photos?.length));
      const cover = entry ? await coverUrl(entry) : null;
      const weather = weatherMeta(entry?.weather);
      const mood = moodMeta(entry?.mood);
      const excerpt = !cover && entry?.note ? noteExcerpt(entry.note) : "";
      let cls = cover ? "has-img" : has ? "has-note" : "no-note";
      if (key === today) cls += " is-today";
      if (key === currentDetailDate) cls += " is-selected";
      const ariaCurrent = key === currentDetailDate ? ' aria-current="date"' : "";
      cells.push(
        '<button type="button" class="lifelog-cell ' + cls + '" data-date="' + key + '" aria-label="' + escapeHtml(dateSpoken(key)) + '"' + ariaCurrent + ">"
        + (cover ? '<img class="lifelog-cell-img" src="' + cover + '" alt="">' : "")
        + (excerpt ? '<span class="lifelog-cell-note">' + escapeHtml(excerpt) + "</span>" : (!cover && has && !weather && !mood ? '<span class="lifelog-cell-mark" aria-hidden="true">文</span>' : ""))
        + '<span class="lifelog-day-num">' + d + "</span>"
        + ((weather || mood) ? '<span class="lifelog-cell-footer' + (cover ? " on-photo" : "") + '"><span>' + (weather ? iconImg(weather, 16) : "") + "</span><span>" + (mood ? iconImg(mood, 16) : "") + "</span></span>" : "")
        + "</button>"
      );
    }

    let statsHtml = ""
      + '<span class="lifelog-pill"><span class="lifelog-pill-ico" aria-hidden="true">📝</span><span class="lifelog-pill-text">' + daysWith + " Days</span></span>"
      + '<span class="lifelog-pill"><span class="lifelog-pill-ico" aria-hidden="true">📷</span><span class="lifelog-pill-text">' + photoCount + " Photos</span></span>"
      + (topMood ? '<span class="lifelog-pill"><span class="lifelog-pill-ico" aria-hidden="true">' + iconImg(topMood, 14) + '</span><span class="lifelog-pill-text">Most ' + escapeHtml(topMood.label) + "</span></span>" : "");

    board.innerHTML = ""
      + '<div class="lifelog-pills" aria-label="本月 Lifelog 统计">'
      + statsHtml
      + "</div>"
      + '<div class="lifelog-weekdays">' + WEEKDAYS.map((label) => "<span>" + label + "</span>").join("") + "</div>"
      + '<div class="lifelog-grid">' + cells.join("") + "</div>"
      + (daysWith === 0 ? '<p class="lifelog-empty-hint">点一个日期，留下一句今天</p>' : "");

    const titleMonth = month + 1;
    const mismatched = [...board.querySelectorAll(".lifelog-cell[data-date]")].filter((cell) => {
      const parts = String(cell.dataset.date || "").split("-").map(Number);
      return parts[0] !== year || parts[1] !== titleMonth;
    });
    if (mismatched.length) {
      console.warn("[lifelog] title/grid month mismatch", title?.textContent, mismatched.map((cell) => cell.dataset.date));
    }

    board.querySelectorAll(".lifelog-cell[data-date]").forEach((cell) => {
      cell.addEventListener("click", () => {
        if (typeof openCalendarDetail === "function") openCalendarDetail(cell.dataset.date);
      });
    });
  }

  function ensureDetailMount() {
    const detail = document.querySelector("#calendarDetailView");
    if (!detail) return null;
    const body = detail.querySelector(".calendar-detail-body");
    if (!body) return null;

    let section = document.querySelector("#lifeLogDetail");
    if (!section) {
      section = document.createElement("section");
      section.id = "lifeLogDetail";
      section.className = "calendar-detail-section lifelog-detail";
    }

    const addBtn = document.querySelector("#addCalendarItem");
    const scheduleSection = document.querySelector("#calendarScheduleList")?.closest(".calendar-detail-section");
    const todoSection = document.querySelector("#calendarTodoList")?.closest(".calendar-detail-section")
      || body.querySelector(".calendar-detail-todos");

    if (view === "lifelog") {
      let plan = document.querySelector("#lifeLogDayPlan");
      if (plan && plan.tagName === "DETAILS") {
        const next = document.createElement("section");
        next.id = "lifeLogDayPlan";
        next.className = "lifelog-day-plan";
        Array.from(plan.childNodes).forEach((child) => {
          if (child.nodeName === "SUMMARY") return;
          next.appendChild(child);
        });
        plan.replaceWith(next);
        plan = next;
      }
      if (!plan) {
        plan = document.createElement("section");
        plan.id = "lifeLogDayPlan";
        plan.className = "lifelog-day-plan";
      }
      let heading = plan.querySelector(":scope > .lifelog-block-title");
      if (!heading) {
        heading = document.createElement("div");
        heading.className = "lifelog-block-title";
        heading.textContent = "当天安排";
        plan.insertBefore(heading, plan.firstChild);
      }
      if (scheduleSection && scheduleSection.parentElement !== plan) plan.appendChild(scheduleSection);
      if (todoSection && todoSection.parentElement !== plan) plan.appendChild(todoSection);
      if (addBtn && addBtn.parentElement !== plan) plan.appendChild(addBtn);

      if (body.firstElementChild !== section) body.insertBefore(section, body.firstChild);
      if (section.nextElementSibling !== plan) section.insertAdjacentElement("afterend", plan);
    } else {
      const plan = document.querySelector("#lifeLogDayPlan");
      if (plan) {
        const insertBefore = plan;
        Array.from(plan.childNodes).forEach((child) => {
          if (child.nodeName === "SUMMARY") return;
          if (child.classList && child.classList.contains("lifelog-block-title")) return;
          body.insertBefore(child, insertBefore);
        });
        plan.remove();
      }
      if (addBtn && addBtn.parentElement) {
        if (section.previousElementSibling !== addBtn) addBtn.insertAdjacentElement("afterend", section);
      } else if (!section.isConnected) {
        body.appendChild(section);
      }
    }
    return section;
  }

  function closeAllMenus(except) {
    document.querySelectorAll("#lifeLogDetail .lifelog-field").forEach((field) => {
      if (except && field === except) return;
      const pick = field.querySelector(".lifelog-pick");
      const menu = field.querySelector(".lifelog-menu");
      pick?.classList.remove("is-open");
      pick?.setAttribute("aria-expanded", "false");
      menu?.classList.add("hidden");
      menu?.setAttribute("hidden", "");
    });
  }

  function bindMenuDismiss() {
    if (menuDocBound) return;
    menuDocBound = true;
    document.addEventListener("click", (event) => {
      const field = event.target.closest("#lifeLogDetail .lifelog-field");
      closeAllMenus(field || null);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeAllMenus();
    });
  }

  function pickerField(kind, entry) {
    const list = kind === "weather" ? WEATHER : MOODS;
    const selected = list.find((item) => item.id === entry[kind]);
    const label = kind === "weather" ? "天气" : "心情";
    const swatch = selected ? selected.color : "";
    const icon = selected
      ? iconImg(selected, 30)
      : (kind === "mood" ? iconImg(null, 30) : '<span class="lifelog-pick-plus" aria-hidden="true">＋</span>');
    const options = list.map((item) => (
      '<button type="button" class="lifelog-opt' + (entry[kind] === item.id ? " is-active" : "") + '" data-id="' + item.id + '" role="option" aria-selected="' + (entry[kind] === item.id ? "true" : "false") + '" title="' + item.label + '" style="--mood:' + item.color + '">'
      + iconImg(item, 30)
      + '<span class="lifelog-opt-lbl">' + item.label + "</span>"
      + "</button>"
    )).join("");
    return ""
      + '<div class="lifelog-field" data-kind="' + kind + '">'
      + '<span class="lifelog-field-label">' + label + "</span>"
      + '<button type="button" class="lifelog-pick' + (selected ? " has-value" : "") + '" data-kind="' + kind + '" style="' + (swatch ? ("--mood:" + swatch) : "") + '" aria-label="' + label + (selected ? ("：" + selected.label) : "：未选") + '" aria-haspopup="listbox" aria-expanded="false" aria-controls="lifelog-menu-' + kind + '">'
      + icon
      + "</button>"
      + '<div id="lifelog-menu-' + kind + '" class="lifelog-menu hidden" role="listbox" hidden aria-label="' + label + '">' + options + "</div>"
      + "</div>";
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error || new Error("read failed"));
      reader.readAsDataURL(file);
    });
  }

  function resizeDataUrl(dataUrl, maxEdge = 1600, quality = 0.86) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
        const width = Math.max(1, Math.round(img.width * scale));
        const height = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  async function addPhotoFromDataUrl(dateKey, dataUrl) {
    if (!dataUrl || !String(dataUrl).startsWith("data:image/")) {
      showNotice("无法读取这张图片");
      return false;
    }
    const entry = entryFor(dateKey);
    if ((entry.photos || []).length >= MAX_PHOTOS) {
      showNotice("最多 9 张照片");
      return false;
    }
    try {
      const resized = await resizeDataUrl(dataUrl);
      const relativePath = await window.luma?.lifelogSaveMedia?.({
        dataBase64: resized,
        mime: "image/jpeg",
      });
      if (!relativePath) {
        showNotice("保存失败，请重试");
        persistStatus = "error";
        paintPersistStatus();
        return false;
      }
      const id = "photo-" + Date.now().toString(36);
      entry.photos = entry.photos || [];
      entry.photos.push({ id, path: relativePath, addedAt: Date.now() });
      if (!entry.coverPhotoId) entry.coverPhotoId = id;
      viewingPhotoId = id;
      entry.updatedAt = Date.now();
      mediaCache.delete(relativePath);
      await enqueuePersist();
      return true;
    } catch {
      showNotice("保存失败，请重试");
      persistStatus = "error";
      paintPersistStatus();
      return false;
    }
  }

  async function removePhoto(dateKey, photoId) {
    const entry = entryFor(dateKey);
    const photos = entry.photos || [];
    const target = photos.find((photo) => photo.id === photoId);
    if (!target) return;
    if (undo?.timer) window.clearTimeout(undo.timer);
    const prevPhotos = photos.slice();
    const prevCover = entry.coverPhotoId;
    entry.photos = photos.filter((photo) => photo.id !== photoId);
    if (entry.coverPhotoId === photoId) {
      entry.coverPhotoId = entry.photos[0] ? entry.photos[0].id : "";
    }
    if (viewingPhotoId === photoId) viewingPhotoId = entry.coverPhotoId || null;
    entry.updatedAt = Date.now();
    undo = {
      dateKey,
      prevPhotos,
      prevCover,
      path: target.path,
      timer: window.setTimeout(async () => {
        try { await window.luma?.lifelogDeleteMedia?.(target.path); } catch (_) {}
        if (undo && undo.path === target.path) undo = null;
        paintUndo();
      }, 6000),
    };
    await enqueuePersist();
  }

  async function undoRemove() {
    if (!undo) return;
    window.clearTimeout(undo.timer);
    const entry = entryFor(undo.dateKey);
    entry.photos = undo.prevPhotos;
    entry.coverPhotoId = undo.prevCover;
    entry.updatedAt = Date.now();
    viewingPhotoId = undo.prevCover || (entry.photos[0] && entry.photos[0].id) || null;
    const dateKey = undo.dateKey;
    undo = null;
    paintUndo();
    await enqueuePersist();
    await renderDetail(dateKey);
  }

  async function setCover(dateKey, photoId) {
    const entry = entryFor(dateKey);
    if (!(entry.photos || []).some((photo) => photo.id === photoId)) return;
    entry.coverPhotoId = photoId;
    entry.updatedAt = Date.now();
    await enqueuePersist();
  }

  function captureLiveNote() {
    const liveNote = document.querySelector("#lifeLogNote");
    if (currentDetailDate && liveNote) applyNoteDraft(currentDetailDate, liveNote.value);
  }

  async function renderDetail(dateKey) {
    const section = ensureDetailMount();
    if (!section || !dateKey) return;
    const previousDate = currentDetailDate;
    captureLiveNote();
    if (currentDetailDate && currentDetailDate !== dateKey) {
      viewingPhotoId = null;
      await flushNotePersist(currentDetailDate);
    } else if (currentDetailDate === dateKey) {
      const t = noteTimers.get(dateKey);
      if (t) {
        window.clearTimeout(t);
        noteTimers.delete(dateKey);
        await enqueuePersist();
      }
    }
    currentDetailDate = dateKey;
    const entry = entryFor(dateKey);
    const photos = entry.photos || [];
    const viewing = photos.find((photo) => photo.id === viewingPhotoId)
      || photos.find((photo) => photo.id === entry.coverPhotoId)
      || photos[0]
      || null;
    if (viewing) viewingPhotoId = viewing.id;
    const viewingUrl = viewing ? await mediaUrl(viewing.path) : null;
    const atLimit = photos.length >= MAX_PHOTOS;
    const strip = photos.map((photo, index) => {
      const current = viewing && photo.id === viewing.id;
      const cover = photo.id === entry.coverPhotoId;
      const label = "第" + (index + 1) + "张" + (cover ? "，封面" : "");
      return '<button type="button" class="lifelog-strip-thumb'
        + (current ? " is-current" : "")
        + (cover ? " is-cover" : "")
        + '" data-lifelog-act="view-photo" data-photo-id="' + photo.id
        + '" aria-label="' + label + '"'
        + (current ? ' aria-current="true"' : "")
        + "></button>";
    }).join("");

    section.innerHTML = ""
      + '<div class="lifelog-block-title">生活记录</div>'
      + '<div class="lifelog-pick-row">'
      + pickerField("weather", entry)
      + pickerField("mood", entry)
      + "</div>"
      + '<label class="lifelog-note-label" for="lifeLogNote">今日絮语</label>'
      + '<textarea id="lifeLogNote" class="lifelog-note" rows="3" maxlength="280" placeholder="写给今天的一句，不必很长…">' + escapeHtml(entry.note || "") + "</textarea>"
      + '<p id="lifeLogSaveStatus" class="lifelog-save-status" aria-live="polite" hidden></p>'
      + '<p id="lifeLogNotice" class="lifelog-notice" hidden></p>'
      + '<p id="lifeLogUndo" class="lifelog-undo" hidden></p>'
      + '<div class="lifelog-photos" tabindex="0" aria-label="照片，可粘贴">'
      + (viewing && viewingUrl
        ? '<img class="lifelog-photo-thumb" src="' + viewingUrl + '" alt="">'
          + '<div class="lifelog-photo-toolbar">'
          + '<span class="lifelog-photo-count">' + photos.length + "/" + MAX_PHOTOS + "</span>"
          + (viewing.id !== entry.coverPhotoId ? '<button type="button" class="lifelog-photo-textbtn" data-lifelog-act="set-cover" data-photo-id="' + viewing.id + '">设为封面</button>' : '<span class="lifelog-photo-cover-flag">封面</span>')
          + '<button type="button" class="lifelog-photo-textbtn" data-lifelog-act="remove-photo" data-photo-id="' + viewing.id + '">删除</button>'
          + '<button type="button" class="lifelog-photo-add is-overlay" data-lifelog-act="add-photo" aria-label="' + (atLimit ? "已达 9 张上限" : "再加一张") + '"' + (atLimit ? " aria-disabled=\"true\"" : "") + ">＋</button>"
          + "</div>"
          + (photos.length > 1 ? '<div class="lifelog-strip" role="list">' + strip + "</div>" : "")
        : '<button type="button" class="lifelog-photo-empty" data-lifelog-act="add-photo" aria-label="添加图片">'
          + '<span class="lifelog-photo-plus">＋</span>'
          + '<span class="lifelog-photo-hint">添加图片 · 也可粘贴</span>'
          + "</button>")
      + '<input class="lifelog-photo-file" type="file" accept="image/*" hidden>'
      + "</div>";

    paintPersistStatus();
    paintUndo();

    if (photos.length) {
      photos.forEach(async (photo) => {
        const thumb = section.querySelector('.lifelog-strip-thumb[data-photo-id="' + photo.id + '"]');
        if (!thumb) return;
        const url = await mediaUrl(photo.path);
        if (url) thumb.style.backgroundImage = "url(" + url + ")";
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
        closeAllMenus(field);
        if (willOpen) {
          menu.classList.remove("hidden");
          menu.removeAttribute("hidden");
          pick.classList.add("is-open");
          pick.setAttribute("aria-expanded", "true");
        }
      });
      menu?.addEventListener("click", async (event) => {
        const chip = event.target.closest(".lifelog-opt");
        if (!chip) return;
        event.preventDefault();
        event.stopPropagation();
        const current = entryFor(dateKey);
        current[kind] = current[kind] === chip.dataset.id ? "" : chip.dataset.id;
        current.updatedAt = Date.now();
        await enqueuePersist();
        await renderDetail(dateKey);
        if (view === "lifelog") await renderBoard();
      });
    });

    const note = section.querySelector("#lifeLogNote");
    note?.addEventListener("input", () => {
      applyNoteDraft(dateKey, note.value);
      scheduleNotePersist(dateKey);
    });

    const fileInput = section.querySelector(".lifelog-photo-file");

    if (!section.dataset.actBound) {
      section.dataset.actBound = "1";
      section.addEventListener("click", async (event) => {
        const act = event.target.closest("[data-lifelog-act]");
        if (!act || !section.contains(act)) return;
        const activeKey = currentDetailDate;
        if (!activeKey) return;
        const action = act.dataset.lifelogAct;
        const photoId = act.dataset.photoId;
        if (action === "add-photo") {
          event.preventDefault();
          if ((entryFor(activeKey).photos || []).length >= MAX_PHOTOS) {
            showNotice("最多 9 张照片");
            return;
          }
          section.querySelector(".lifelog-photo-file")?.click();
        } else if (action === "view-photo" && photoId) {
          viewingPhotoId = photoId;
          await renderDetail(activeKey);
        } else if (action === "set-cover" && photoId) {
          await setCover(activeKey, photoId);
          await renderDetail(activeKey);
          if (view === "lifelog") await renderBoard();
        } else if (action === "remove-photo" && photoId) {
          await removePhoto(activeKey, photoId);
          await renderDetail(activeKey);
          if (view === "lifelog") await renderBoard();
        } else if (action === "retry") {
          await enqueuePersist();
        } else if (action === "undo") {
          await undoRemove();
          if (view === "lifelog") await renderBoard();
        }
      });
    }

    fileInput?.addEventListener("change", async () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = "";
      if (!file) return;
      const activeKey = currentDetailDate;
      if (!activeKey) return;
      await addPhotoFromDataUrl(activeKey, await fileToDataUrl(file));
      await renderDetail(activeKey);
      if (view === "lifelog") await renderBoard();
    });

    const onPasteImage = async (event) => {
      const items = event.clipboardData && event.clipboardData.items;
      if (!items) return;
      const activeKey = currentDetailDate;
      if (!activeKey) return;
      for (const item of items) {
        if (!item.type.startsWith("image/")) continue;
        event.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;
        await addPhotoFromDataUrl(activeKey, await fileToDataUrl(file));
        await renderDetail(activeKey);
        if (view === "lifelog") await renderBoard();
        break;
      }
    };
    section.querySelector(".lifelog-photos")?.addEventListener("paste", onPasteImage);
    if (!detailSectionPasteBound) {
      detailSectionPasteBound = true;
      section.addEventListener("paste", (event) => {
        if (event.defaultPrevented) return;
        onPasteImage(event);
      });
    }

    if (view === "lifelog" && previousDate !== dateKey) await renderBoard();
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

  function wrapCloseDetail() {
    if (typeof closeCalendarDetail !== "function") return;
    if (closeCalendarDetail.__lifelogWrapped) return;
    const original = closeCalendarDetail;
    closeCalendarDetail = function lifelogAwareClose() {
      captureLiveNote();
      if (currentDetailDate) flushNotePersist(currentDetailDate);
      currentDetailDate = null;
      viewingPhotoId = null;
      if (view === "lifelog") renderBoard();
      return original();
    };
    closeCalendarDetail.__lifelogWrapped = true;
  }

  let navHooked = false;
  let navTries = 0;

  function wrapMonthNav() {
    if (navHooked) return;
    if (typeof changeCalendarMonth !== "function" || typeof goToCurrentCalendarMonth !== "function") return;
    const originalChange = changeCalendarMonth;
    changeCalendarMonth = function lifelogAwareChange(offset, animate) {
      if (view === "lifelog") {
        shiftLifelogMonth(offset);
        return;
      }
      return originalChange(offset, animate);
    };
    const originalToday = goToCurrentCalendarMonth;
    goToCurrentCalendarMonth = function lifelogAwareToday() {
      if (view === "lifelog") {
        goLifelogToday();
        return;
      }
      return originalToday();
    };
    navHooked = true;
  }

  function ensureNav() {
    wrapOpenDetail();
    wrapCloseDetail();
    wrapMonthNav();
    bindDirectNav();
    const wrapsReady = Boolean(
      (typeof openCalendarDetail === "function" && openCalendarDetail.__lifelogWrapped)
      && (typeof closeCalendarDetail === "function" && closeCalendarDetail.__lifelogWrapped)
      && navHooked
    );
    if (!wrapsReady && navTries < 40) {
      navTries += 1;
      window.setTimeout(ensureNav, 50);
    }
  }

  function bindDirectNav() {
    const controls = document.querySelector(".month-controls");
    if (!controls || controls.dataset.lifelogNav === "1") return;
    controls.dataset.lifelogNav = "1";
    controls.addEventListener("click", (event) => {
      if (view !== "lifelog") return;
      if (event.target.closest("#todayMonth")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        goLifelogToday();
      } else if (event.target.closest("#prevMonth")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        shiftLifelogMonth(-1);
      } else if (event.target.closest("#nextMonth")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        shiftLifelogMonth(1);
      }
    }, true);
  }

  function bindFlushHooks() {
    if (document.documentElement.dataset.lifelogFlush === "1") return;
    document.documentElement.dataset.lifelogFlush = "1";
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flushAllNotes();
    });
    window.addEventListener("beforeunload", () => { flushAllNotes(); });
  }

  function boot() {
    ensureSwitcher();
    ensureBoard();
    bindDirectNav();
    bindMenuDismiss();
    bindFlushHooks();
    wrapOpenDetail();
    wrapCloseDetail();
    ensureNav();
    loadStore().then(() => {
      syncChrome();
      if (typeof calendarDetailDate === "string" && calendarDetailDate) return renderDetail(calendarDetailDate);
    });
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
  window.addEventListener("load", () => {
    wrapOpenDetail();
    wrapCloseDetail();
    ensureNav();
  });
})();
