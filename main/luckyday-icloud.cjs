"use strict";

function compactDateKey(dateKey) {
  return String(dateKey || "").replaceAll("-", "");
}

function nextDateKey(dateKey) {
  const [y, m, d] = String(dateKey || "").split("-").map(Number);
  const date = new Date(y, m - 1, d, 12, 0, 0, 0);
  date.setDate(date.getDate() + 1);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function markerUid(mark) {
  const type = mark?.type === "cheng" ? "cheng" : "chu";
  return `luckyday-${type}-${String(mark?.dateKey || "")}@luma-todo`;
}

function luckyDayMarkerIcs(mark, updatedAt = Date.now()) {
  const label = mark?.type === "cheng" ? "成日" : "除日";
  const dateKey = String(mark?.dateKey || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) throw new Error("LuckyDay 标记日期无效");
  const uid = markerUid(mark);
  const stamp = new Date(updatedAt);
  const dtstamp = stamp.getUTCFullYear()
    + String(stamp.getUTCMonth() + 1).padStart(2, "0")
    + String(stamp.getUTCDate()).padStart(2, "0")
    + "T"
    + String(stamp.getUTCHours()).padStart(2, "0")
    + String(stamp.getUTCMinutes()).padStart(2, "0")
    + String(stamp.getUTCSeconds()).padStart(2, "0")
    + "Z";
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Luma Todo//LuckyDay//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    "UID:" + uid,
    "DTSTAMP:" + dtstamp,
    "LAST-MODIFIED:" + dtstamp,
    "SUMMARY:" + label,
    "DTSTART;VALUE=DATE:" + compactDateKey(dateKey),
    "DTEND;VALUE=DATE:" + compactDateKey(nextDateKey(dateKey)),
    "TRANSP:TRANSPARENT",
    "X-LUMA-LUCKYDAY:TRUE",
    "X-LUMA-LUCKYDAY-TYPE:" + mark.type,
    "X-LUMA-LUCKYDAY-DATE:" + dateKey,
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

function markerKey(value) {
  const type = value?.luckyDayType || value?.type || "";
  const dateKey = value?.luckyDayDate || value?.dateKey || "";
  return type && dateKey ? type + "|" + dateKey : "";
}

module.exports = { luckyDayMarkerIcs, markerUid, markerKey, nextDateKey };
