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

  function iconImg(item, size, extraClass) {
    if (!item || !item.file) {
      return '<img class="lifelog-ico ' + (extraClass || "") + '" src="' + MOOD_EMPTY + '" width="' + size + '" height="' + size + '" alt="" aria-hidden="true">';
    }
    return '<img class="lifelog-ico ' + (extraClass || "") + '" src="' + ICON_BASE + item.file + '" width="' + size + '" height="' + size + '" alt="' + (item.label || "") + '" style="--mood:' + (item.color || "#C5CCD4") + '">';
  }
  const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

  let store = { version: 1, entries: {} };
  let mediaCache = new Map();
  let view = "month";
  let cursor = new Date();
  let noteTimers = new Map(); // dateKey -> timeout id (never clear another day's pending write)
  let notePersistChain = Promise.resolve();
  let ready = false;
  let currentDetailDate = null;
  let detailSectionPasteBound = false;

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
    const entry = store.entries[key];
    if (entry.weather === "windy") entry.weather = "foggy";
    if (entry.mood === "bad") entry.mood = "awful";
    return entry;
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
    current.note = String(text ?? "").trim();
    current.updatedAt = Date.now();
  }

  function enqueueNotePersist() {
    notePersistChain = notePersistChain
      .then(async () => {
        await saveStore();
        if (view === "lifelog") await renderBoard();
      })
      .catch(() => {});
    return notePersistChain;
  }

  function scheduleNotePersist(dateKey) {
    if (!dateKey) return;
    const prev = noteTimers.get(dateKey);
    if (prev) window.clearTimeout(prev);
    const timer = window.setTimeout(() => {
      noteTimers.delete(dateKey);
      enqueueNotePersist();
    }, 350);
    noteTimers.set(dateKey, timer);
  }

  async function flushNotePersist(dateKey) {
    if (!dateKey) return;
    const timer = noteTimers.get(dateKey);
    if (!timer) return;
    window.clearTimeout(timer);
    noteTimers.delete(dateKey);
    await enqueueNotePersist();
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
        // Month/Week: hide Lifelog, close day detail, let week/month handlers continue.
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
        + ((weather || mood) ? '<span class="lifelog-cell-footer' + (cover ? " on-photo" : "") + '"><span>' + (weather ? iconImg(weather, 16) : "") + "</span><span>" + (mood ? iconImg(mood, 16) : "") + "</span></span>" : "")
        + "</button>"
      );
    }

    board.innerHTML = ""
      + '<div class="lifelog-pills" aria-label="本月 Lifelog 统计">'
      + '<span class="lifelog-pill"><span class="lifelog-pill-ico" aria-hidden="true">📝</span><span class="lifelog-pill-text">' + daysWith + " Days</span></span>"
      + '<span class="lifelog-pill"><span class="lifelog-pill-ico" aria-hidden="true">📷</span><span class="lifelog-pill-text">' + photos + " Photos</span></span>"
      + (topMood ? '<span class="lifelog-pill"><span class="lifelog-pill-ico" aria-hidden="true">' + iconImg(topMood, 14) + '</span><span class="lifelog-pill-text">Most ' + topMood.label + "</span></span>" : "")
      + "</div>"
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
      // Record-first: lifeLogDetail on top; schedule/todos/add in collapsed 「当天安排」.
      let plan = document.querySelector("#lifeLogDayPlan");
      if (!plan) {
        plan = document.createElement("details");
        plan.id = "lifeLogDayPlan";
        plan.className = "lifelog-day-plan";
        const summary = document.createElement("summary");
        summary.className = "lifelog-day-plan-summary";
        summary.textContent = "当天安排";
        plan.appendChild(summary);
      }
      if (scheduleSection && scheduleSection.parentElement !== plan) plan.appendChild(scheduleSection);
      if (todoSection && todoSection.parentElement !== plan) plan.appendChild(todoSection);
      if (addBtn && addBtn.parentElement !== plan) plan.appendChild(addBtn);

      if (body.firstElementChild !== section) body.insertBefore(section, body.firstChild);
      if (section.nextElementSibling !== plan) section.insertAdjacentElement("afterend", plan);
    } else {
      // Month/week: restore schedule → todos → add → lifeLogDetail (unchanged order).
      const plan = document.querySelector("#lifeLogDayPlan");
      if (plan) {
        const insertBefore = plan;
        Array.from(plan.childNodes).forEach((child) => {
          if (child.nodeName === "SUMMARY") return;
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
      + '<span class="lifelog-field-label" id="lifelog-label-' + kind + '">' + label + "</span>"
      + '<button type="button" class="lifelog-pick' + (selected ? " has-value" : "") + '" data-kind="' + kind + '" style="' + (swatch ? ("--mood:" + swatch) : "") + '" aria-labelledby="lifelog-label-' + kind + '" aria-label="' + label + (selected ? ("：" + selected.label) : "：未选") + '" aria-haspopup="listbox" aria-expanded="false">'
      + icon
      + "</button>"
      + '<div class="lifelog-menu hidden" role="listbox" hidden aria-label="' + label + '">' + options + "</div>"
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
    if (!dataUrl || !String(dataUrl).startsWith("data:image/")) return;
    const entry = entryFor(dateKey);
    if ((entry.photos || []).length >= 9) return;
    const resized = await resizeDataUrl(dataUrl);
    const relativePath = await window.luma?.lifelogSaveMedia?.({
      dataBase64: resized,
      mime: "image/jpeg",
    });
    if (!relativePath) return;
    const id = "photo-" + Date.now().toString(36);
    entry.photos = entry.photos || [];
    entry.photos.push({ id, path: relativePath, addedAt: Date.now() });
    if (!entry.coverPhotoId) entry.coverPhotoId = id;
    entry.updatedAt = Date.now();
    mediaCache.delete(relativePath);
    await saveStore();
  }

    async function removePhoto(dateKey, photoId) {
    const entry = entryFor(dateKey);
    const photos = entry.photos || [];
    const target = photos.find((photo) => photo.id === photoId);
    if (!target) return;
    entry.photos = photos.filter((photo) => photo.id !== photoId);
    if (entry.coverPhotoId === photoId) {
      entry.coverPhotoId = entry.photos[0] ? entry.photos[0].id : "";
    }
    entry.updatedAt = Date.now();
    if (target.path) {
      mediaCache.delete(target.path);
      try { await window.luma?.lifelogDeleteMedia?.(target.path); } catch (_) {}
    }
    await saveStore();
  }

async function renderDetail(dateKey) {
    const section = ensureDetailMount();
    if (!section || !dateKey) return;
    // Capture live textarea into memory before DOM wipe / day switch.
    const liveNote = section.querySelector("#lifeLogNote");
    if (currentDetailDate && liveNote) {
      applyNoteDraft(currentDetailDate, liveNote.value);
    }
    if (currentDetailDate && currentDetailDate !== dateKey) {
      await flushNotePersist(currentDetailDate);
    } else if (currentDetailDate === dateKey) {
      // Same-day re-render (mood/weather): flush pending note so textarea matches store.
      const t = noteTimers.get(dateKey);
      if (t) {
        window.clearTimeout(t);
        noteTimers.delete(dateKey);
        await enqueueNotePersist();
      }
    }
    currentDetailDate = dateKey;
    const entry = entryFor(dateKey);
    const coverPhoto = (entry.photos || []).find((photo) => photo.id === entry.coverPhotoId) || (entry.photos || [])[0] || null;
    const cover = coverPhoto ? await mediaUrl(coverPhoto.path) : null;
    section.innerHTML = ""
      + '<div class="lifelog-block-title">生活记录</div>'
      + '<div class="lifelog-pick-row">'
      + pickerField("weather", entry)
      + pickerField("mood", entry)
      + "</div>"
      + '<label class="lifelog-note-label" for="lifeLogNote">今日絮语</label>'
      + '<textarea id="lifeLogNote" class="lifelog-note" rows="3" maxlength="280" placeholder="写给今天的一句，不必很长…">' + (entry.note || "").replace(/</g, "&lt;") + "</textarea>"
      + '<div class="lifelog-photos" tabindex="0" aria-label="添加图片，可粘贴">'
            + (cover
              ? '<img class="lifelog-photo-thumb" src="' + cover + '" alt="">'
                + '<button type="button" class="lifelog-photo-remove" data-photo-id="' + coverPhoto.id + '" aria-label="删除图片">×</button>'
                + '<button type="button" class="lifelog-photo-add is-overlay" aria-label="再加一张">＋</button>'
              : '<button type="button" class="lifelog-photo-empty" aria-label="添加图片">'
                + '<span class="lifelog-photo-plus">＋</span>'
                + '<span class="lifelog-photo-hint">添加图片 · 也可粘贴</span>'
                + "</button>")
            + '<input class="lifelog-photo-file" type="file" accept="image/*" hidden>'
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
        const chip = event.target.closest(".lifelog-opt");
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
      // Immediate in-memory draft for THIS date; debounce only disk persist.
      applyNoteDraft(dateKey, note.value);
      scheduleNotePersist(dateKey);
    });

    const photos = section.querySelector(".lifelog-photos");
    const fileInput = section.querySelector(".lifelog-photo-file");
    const openPicker = () => fileInput?.click();
    section.querySelector(".lifelog-photo-empty")?.addEventListener("click", openPicker);
    section.querySelector(".lifelog-photo-add")?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openPicker();
    });
    section.querySelector(".lifelog-photo-remove")?.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const photoId = event.currentTarget.getAttribute("data-photo-id");
      if (!photoId) return;
      await removePhoto(dateKey, photoId);
      await renderDetail(dateKey);
      if (view === "lifelog") await renderBoard();
    });
    fileInput?.addEventListener("change", async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      const dataUrl = await fileToDataUrl(file);
      await addPhotoFromDataUrl(dateKey, dataUrl);
      await renderDetail(dateKey);
      if (view === "lifelog") await renderBoard();
      fileInput.value = "";
    });
    photos?.addEventListener("paste", async (event) => {
      const items = event.clipboardData && event.clipboardData.items;
      if (!items) return;
      for (const item of items) {
        if (!item.type.startsWith("image/")) continue;
        event.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;
        const dataUrl = await fileToDataUrl(file);
        await addPhotoFromDataUrl(dateKey, dataUrl);
        await renderDetail(dateKey);
        if (view === "lifelog") await renderBoard();
        break;
      }
    });
    // Bind section paste once; always use currentDetailDate (not a stale closed-over key).
    if (!detailSectionPasteBound) {
      detailSectionPasteBound = true;
      section.addEventListener("paste", async (event) => {
        if (event.defaultPrevented) return;
        const activeKey = currentDetailDate;
        if (!activeKey) return;
        const items = event.clipboardData && event.clipboardData.items;
        if (!items) return;
        for (const item of items) {
          if (!item.type.startsWith("image/")) continue;
          event.preventDefault();
          const file = item.getAsFile();
          if (!file) continue;
          const dataUrl = await fileToDataUrl(file);
          await addPhotoFromDataUrl(activeKey, dataUrl);
          await renderDetail(activeKey);
          if (view === "lifelog") await renderBoard();
          break;
        }
      });
    }
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
      const key = currentDetailDate;
      const section = document.querySelector("#lifeLogDetail");
      const liveNote = section?.querySelector("#lifeLogNote");
      if (key && liveNote) applyNoteDraft(key, liveNote.value);
      if (key) {
        const timer = noteTimers.get(key);
        if (timer) {
          window.clearTimeout(timer);
          noteTimers.delete(key);
          enqueueNotePersist();
        }
      }
      return original();
    };
    closeCalendarDetail.__lifelogWrapped = true;
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
    if (typeof goToCurrentCalendarMonth === "function" && goToCurrentCalendarMonth.name !== "lifelogAwareToday") {
      const original = goToCurrentCalendarMonth;
      goToCurrentCalendarMonth = function lifelogAwareToday() {
        if (view === "lifelog") {
          const now = new Date();
          cursor = new Date(now.getFullYear(), now.getMonth(), 1);
          if (typeof calendarCursor !== "undefined") calendarCursor = new Date(cursor);
          renderBoard();
          return;
        }
        return original();
      };
    }
  }

  async function boot() {
    ensureSwitcher();
    ensureBoard();
    wrapOpenDetail();
    wrapCloseDetail();
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
