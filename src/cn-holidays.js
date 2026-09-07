(function attachCnHolidays(root) {
  const YEARS = {
    2025: {
      holidays: {
        "2025-01-01": "元旦",
        "2025-01-28": "春节",
        "2025-01-29": "春节",
        "2025-01-30": "春节",
        "2025-01-31": "春节",
        "2025-02-01": "春节",
        "2025-02-02": "春节",
        "2025-02-03": "春节",
        "2025-02-04": "春节",
        "2025-04-04": "清明",
        "2025-04-05": "清明",
        "2025-04-06": "清明",
        "2025-05-01": "劳动节",
        "2025-05-02": "劳动节",
        "2025-05-03": "劳动节",
        "2025-05-04": "劳动节",
        "2025-05-05": "劳动节",
        "2025-05-31": "端午",
        "2025-06-01": "端午",
        "2025-06-02": "端午",
        "2025-10-01": "国庆节",
        "2025-10-02": "国庆节",
        "2025-10-03": "国庆节",
        "2025-10-04": "国庆节",
        "2025-10-05": "国庆节",
        "2025-10-06": "中秋",
        "2025-10-07": "国庆节",
        "2025-10-08": "国庆节"
      },
      workdays: {
        "2025-01-26": "春节",
        "2025-02-08": "春节",
        "2025-04-27": "劳动节",
        "2025-09-28": "国庆节",
        "2025-10-11": "国庆节"
      }
    },
    2026: {
      holidays: {
        "2026-01-01": "元旦",
        "2026-01-02": "元旦",
        "2026-01-03": "元旦",
        "2026-02-15": "春节",
        "2026-02-16": "春节",
        "2026-02-17": "春节",
        "2026-02-18": "春节",
        "2026-02-19": "春节",
        "2026-02-20": "春节",
        "2026-02-21": "春节",
        "2026-02-22": "春节",
        "2026-02-23": "春节",
        "2026-04-04": "清明",
        "2026-04-05": "清明",
        "2026-04-06": "清明",
        "2026-05-01": "劳动节",
        "2026-05-02": "劳动节",
        "2026-05-03": "劳动节",
        "2026-05-04": "劳动节",
        "2026-05-05": "劳动节",
        "2026-06-19": "端午",
        "2026-06-20": "端午",
        "2026-06-21": "端午",
        "2026-09-25": "中秋",
        "2026-09-26": "中秋",
        "2026-09-27": "中秋",
        "2026-10-01": "国庆节",
        "2026-10-02": "国庆节",
        "2026-10-03": "国庆节",
        "2026-10-04": "国庆节",
        "2026-10-05": "国庆节",
        "2026-10-06": "国庆节",
        "2026-10-07": "国庆节"
      },
      workdays: {
        "2026-01-04": "元旦",
        "2026-02-14": "春节",
        "2026-02-28": "春节",
        "2026-05-09": "劳动节",
        "2026-09-20": "国庆节",
        "2026-10-10": "国庆节"
      }
    }
  };

  function yearOf(dateKey) {
    const year = Number(String(dateKey || "").slice(0, 4));
    return Number.isFinite(year) ? year : 0;
  }

  function getCnHolidayMark(dateKey) {
    if (!dateKey || typeof dateKey !== "string") return null;
    const pack = YEARS[yearOf(dateKey)];
    if (!pack) return null;
    if (pack.workdays[dateKey]) {
      return { type: "work", name: pack.workdays[dateKey] };
    }
    if (pack.holidays[dateKey]) {
      return { type: "off", name: pack.holidays[dateKey] };
    }
    return null;
  }

  function cnHolidayDetailLabel(mark) {
    if (!mark || !mark.name) return "";
    return mark.type === "work" ? `${mark.name} · 调休上班` : `${mark.name} · 放假`;
  }

  function cnHolidayBadgeText(mark) {
    if (!mark) return "";
    if (mark.type === "work") return "班";
    const name = String(mark.name || "");
    if (name.endsWith("节") && name.length > 2) return name.slice(0, -1);
    return name || "休";
  }

  root.getCnHolidayMark = getCnHolidayMark;
  root.cnHolidayDetailLabel = cnHolidayDetailLabel;
  root.cnHolidayBadgeText = cnHolidayBadgeText;
  root.CN_HOLIDAY_YEARS = YEARS;
})(typeof globalThis !== "undefined" ? globalThis : window);
