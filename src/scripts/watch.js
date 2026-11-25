// 我的盯梢：固定 8 条通勤线路 + 站名归一化 + WGS-84→GCJ-02 + 追踪行程
export const CITY = "040";

/** 盯梢目标：线名 / lineId / dir / 目标站 sId / 站名 / 时段组 */
export const WATCH = [
  { no: "B1", lineId: "020-80010-1", dir: "1", stationId: "020-18725", station: "上社3", group: "morning" },
  { no: "B3", lineId: "020-80030-1", dir: "1", stationId: "020-18725", station: "上社3", group: "morning" },
  { no: "B25", lineId: "020-80250-0", dir: "0", stationId: "020-18731", station: "上社2", group: "morning" },
  { no: "B4", lineId: "020-80040-1", dir: "1", stationId: "020-18731", station: "上社2", group: "morning" },
  { no: "B12", lineId: "020-80120-0", dir: "0", stationId: "020-18731", station: "上社2", group: "morning" },
  { no: "B2", lineId: "020-80020-1", dir: "1", stationId: "020-27065", station: "上社", group: "morning" },
  { no: "B2A", lineId: "020-80022-1", dir: "1", stationId: "020-27187", station: "上社", group: "morning" },
  { no: "B8", lineId: "020-80080-1", dir: "1", stationId: "020-24535", station: "天河②", group: "evening" },
];

/** 按当前小时返回要显示的组：05:00–12:00 早班，16:00–23:00 晚班，其余两组都显示 */
export function watchGroup(now = new Date()) {
  const h = now.getHours();
  if (h >= 5 && h < 12) return "morning";
  if (h >= 16 && h < 23) return "evening";
  return "all";
}

export function watchTargets(group = watchGroup()) {
  if (group === "all") return WATCH;
  return WATCH.filter((t) => t.group === group);
}

/**
 * 站名归一化：去 BRT 前缀、去尾「站」、去 ②/N2/纯数字站台后缀。
 * BRT上社3、上社2、天河② → 上社 / 天河。
 */
export function normalizeStationName(text) {
  let s = String(text || "").trim();
  s = s.replace(/^BRT/, "");
  s = s.replace(/站$/, "");
  s = s.replace(/[②①③④⑤⑥⑦⑧⑨⑩]$/, "");
  s = s.replace(/N\d+$/i, "");
  s = s.replace(/\d+$/, "");
  return s.trim();
}

/**
 * 归一化站名 → 对应公交站（有真实站点的才能走快照坐标）。
 * 中山六院北院区无对应公交站，不进表，走地理编码。
 */
export const KNOWN_STATIONS = {
  上社: { label: "上社", lineId: "020-80010-1", dir: "1", stationId: "020-18725" },
  天河: { label: "天河", lineId: "020-80080-1", dir: "1", stationId: "020-24535" },
  体育中心: { label: "体育中心", lineId: "020-80010-1", dir: "1", stationId: "020-27298" },
};

/** WGS-84 → GCJ-02（Trackr 的 CoordTransform 标准偏移算法） */
const _a = 6378245.0;
const _ee = 0.00669342162296594323;
function _transformLat(lng, lat) {
  let ret = -100.0 + 2.0 * lng + 3.0 * lat + 0.2 * lat * lat + 0.1 * lng * lat + 0.2 * Math.sqrt(Math.abs(lng));
  ret += ((20.0 * Math.sin(6.0 * lng * Math.PI) + 20.0 * Math.sin(2.0 * lng * Math.PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(lat * Math.PI) + 40.0 * Math.sin((lat / 3.0) * Math.PI)) * 2.0) / 3.0;
  ret += ((160.0 * Math.sin((lat / 12.0) * Math.PI) + 320 * Math.sin((lat * Math.PI) / 30.0)) * 2.0) / 3.0;
  return ret;
}
function _transformLng(lng, lat) {
  let ret = 300.0 + lng + 2.0 * lat + 0.1 * lng * lng + 0.1 * lng * lat + 0.1 * Math.sqrt(Math.abs(lng));
  ret += ((20.0 * Math.sin(6.0 * lng * Math.PI) + 20.0 * Math.sin(2.0 * lng * Math.PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(lng * Math.PI) + 40.0 * Math.sin((lng / 3.0) * Math.PI)) * 2.0) / 3.0;
  ret += ((150.0 * Math.sin((lng / 12.0) * Math.PI) + 300.0 * Math.sin((lng / 30.0) * Math.PI)) * 2.0) / 3.0;
  return ret;
}
function _outOfChina(lng, lat) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}
export function wgs84ToGcj02(lng, lat) {
  if (typeof lng !== "number" || typeof lat !== "number" || _outOfChina(lng, lat)) {
    return { lng, lat };
  }
  const dLat = _transformLat(lng - 105.0, lat - 35.0);
  const dLng = _transformLng(lng - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - _ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  const dLat2 = (dLat * 180.0) / (((_a * (1 - _ee)) / (magic * sqrtMagic)) * Math.PI);
  const dLng2 = (dLng * 180.0) / ((_a / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return { lng: lng + dLng2, lat: lat + dLat2 };
}

/** 取一条盯梢线的实时数据（沿途站点 + 车辆），getJSON 由调用方传入 */
export async function fetchWatchLine(getJSON, target) {
  const q = new URLSearchParams({
    lineId: target.lineId,
    dir: String(target.dir),
    cityId: CITY,
    stationId: target.stationId,
  });
  return getJSON(`/api/line?${q}`);
}

/** 最近一班「正开往目标站」的车（eta>=0，按 eta 升序，/api/line 已排好） */
export function nearestBus(data) {
  return (data.buses || []).find((b) => typeof b.eta === "number" && b.eta >= 0) || null;
}

/** 第二班（下一辆） */
export function nextBus(data) {
  const list = (data.buses || []).filter((b) => typeof b.eta === "number" && b.eta >= 0);
  return list[1] || null;
}

/** 车牌尾号：沪A·D8866 → 8866；没有车牌返回 "" */
export function plateTail(plate) {
  const p = String(plate || "").replace(/[^0-9A-Za-z]/g, "");
  return p.length >= 4 ? p.slice(-4) : p;
}

// ── 追踪行程（线路页「追踪这班车」→ 首页顶部横幅），存本机 ──
const TRACK_KEY = "cl-track-v1";
export function getTrackedTrip() {
  try {
    const raw = JSON.parse(localStorage.getItem(TRACK_KEY) || "null");
    if (raw && raw.lineId && raw.stationId) return raw;
  } catch {
    /* ignore */
  }
  return null;
}
export function setTrackedTrip(trip) {
  try {
    localStorage.setItem(TRACK_KEY, JSON.stringify(trip));
  } catch {
    /* ignore */
  }
}
export function clearTrackedTrip() {
  try {
    localStorage.removeItem(TRACK_KEY);
  } catch {
    /* ignore */
  }
}
