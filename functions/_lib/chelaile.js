// 车来了上游客户端：签名 → 请求 → 解密 → 精简成前端可用的结构。
// 只做只读、低频的查询（附近站点 / 单站点 / 单线路）。
import { md5 } from "./md5.js";
import { aesEcbDecrypt } from "./aes-ecb.js";

const BASE = "https://web.chelaile.net.cn/api";
const SALT = "qwihrnbtmj";

const DEFAULT_PARAMS = {
  s: "h5", wxs: "wx_app", sign: "1", h5RealData: "1", v: "3.11.28",
  src: "weixinapp_cx", ctm_mp: "mp_wx", vc: "2", favoriteGray: "1",
  gpstype: "wgs", geo_type: "wgs", scene: "1256",
};

// 上游会校验这套客户端特征，改了就回 status:400（即使签名正确）
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254160a) XWEB/18055",
  xweb_xhr: "1",
  "Content-Type": "text",
  Accept: "*/*",
  "Sec-Fetch-Site": "cross-site",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Dest": "empty",
  Referer: "https://servicewechat.com/wx71d589ea01ce3321/814/page-frame.html",
  "Accept-Language": "zh-CN,zh;q=0.9",
};

export const CITIES = { "040": "广州", "010": "北京", "020": "深圳", "030": "上海" };

export function cryptoSign(params) {
  const str =
    Object.entries(params).map(([k, v]) => `"${k}"="${v}"`).join("&") + SALT;
  return md5(str);
}

function parseEnvelope(text) {
  const start = text.indexOf("{");
  if (start < 0) throw new Error("上游返回不是 JSON");
  const env = JSON.parse(text.slice(start, text.lastIndexOf("}") + 1));
  const data = env?.jsonr?.data;
  if (!data) throw new Error("上游返回缺少 jsonr.data");
  return data;
}

async function request(path, params) {
  const signed = { ...params, cryptoSign: cryptoSign(params) };
  const url = `${BASE}${path}?${new URLSearchParams(signed).toString()}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`上游 HTTP ${res.status}`);
  const data = parseEnvelope(await res.text());
  if (data.encryptResult) return JSON.parse(aesEcbDecrypt(data.encryptResult));
  return data;
}

/** 把 stnStates 压成最多三条到站信息（最近三班） */
function pickBuses(line) {
  const states = Array.isArray(line?.stnStates) ? line.stnStates : [];
  return states
    .map((s) => ({
      eta: typeof s.travelTime === "number" ? s.travelTime : -1,
      dist: typeof s.distanceToDest === "number" ? s.distanceToDest : -1,
      cap: typeof s.capacity === "number" ? s.capacity : 0,
      left: typeof s.value === "number" ? s.value : -1,
    }))
    .filter((b) => b.eta >= 0 || b.dist > 0)
    .sort((a, b) => (a.eta < 0 ? 1e9 : a.eta) - (b.eta < 0 ? 1e9 : b.eta))
    .slice(0, 3);
}

function pickTags(line) {
  const list = line?.stnStates?.[0]?.busTagList;
  if (!Array.isArray(list)) return [];
  return list.map((t) => t?.title).filter(Boolean).slice(0, 2);
}

/** 一条线路 → 前端结构（附近站点、站点详情共用） */
function shapeLine(l, station) {
  const ln = l.line || {};
  return {
    no: String(ln.name || ln.lineNo || "").replace(/^0+/, "") || String(ln.lineNo || ""),
    lineId: ln.lineId || "",
    dir: ln.direction ?? 0,
    to: ln.destinationName || ln.endSn || "",
    from: ln.startSn || "",
    first: ln.firstTime || "",
    last: ln.lastTime || "",
    price: ln.price || "",
    hasBus: !!ln.hasBusInfo,
    subway: !!(ln.isSubway || station?.isSubway),
    buses: pickBuses(l),
    pre: l.preArrivalTime || "",
    tags: pickTags(l),
  };
}

/** 一个站点 → 前端结构 */
function shapeStation(s) {
  const lines = (Array.isArray(s.lines) ? s.lines : [])
    .map((l) => shapeLine(l, s))
    .filter((l) => l.no);
  return {
    sId: s.sId || "",
    name: s.sn || "",
    distance: typeof s.distance === "number" ? s.distance : -1,
    subway: !!s.isSubway,
    // 站点详情页与收藏需要的身份字段
    physicalStId: s.physicalStId || "",
    namesakeStId: s.namesakeStId || "",
    firstLineId: s.firstLineId || "",
    lat: typeof s.lat === "number" ? s.lat : null,
    lng: typeof s.lng === "number" ? s.lng : null,
    metros: (Array.isArray(s.metros) ? s.metros : [])
      .map((m) => m?.lineNo || m?.name || "")
      .filter(Boolean)
      .slice(0, 4),
    lines,
  };
}

export function reshapeNearby(raw, limit = 8) {
  const stations = Array.isArray(raw?.nearSts) ? raw.nearSts : [];
  return stations
    .map(shapeStation)
    .filter((s) => s.name && s.lines.length)
    .sort((a, b) => (a.distance < 0 ? 1e9 : a.distance) - (b.distance < 0 ? 1e9 : b.distance))
    .slice(0, limit);
}

/** 附近站点（首页） */
export async function fetchNearby({ cityId = "040", lat, lng, limit = 8 }) {
  if (!lat || !lng) throw new Error("缺少 lat/lng");
  const raw = await request("/bus/stop!encryptedHomePage.action", {
    ...DEFAULT_PARAMS,
    cityId,
    localCityId: "undefined",
    lat: String(lat),
    lng: String(lng),
    geo_lat: String(lat),
    geo_lng: String(lng),
    type: "5",
    permission: "0",
  });
  return {
    cityId,
    city: CITIES[cityId] || "",
    updatedAt: Date.now(),
    stations: reshapeNearby(raw, limit),
  };
}

/** 单个站点详情（站点页） */
export async function fetchStation({
  cityId = "040",
  physicalStId,
  sId = "",
  namesakeStId = "",
  firstLineId = "",
  lat = "",
  lng = "",
}) {
  if (!physicalStId) throw new Error("缺少 physicalStId");
  const raw = await request("/bus/stop!encryptedPhyStnDetail.action", {
    ...DEFAULT_PARAMS,
    cityId,
    localCityId: cityId,
    physicalStId,
    namesakeStId,
    firstLineId,
    stationId: "",
    lat: String(lat || ""),
    lng: String(lng || ""),
    geo_lat: String(lat || ""),
    geo_lng: String(lng || ""),
    actionState: "1",
    permission: "0",
  });
  const list = Array.isArray(raw?.stationList) ? raw.stationList : [];
  const hit = list.find((s) => s.sId === sId) || list[0];
  if (!hit) throw new Error("上游没有这个站点");
  return {
    cityId,
    city: CITIES[cityId] || "",
    updatedAt: Date.now(),
    station: shapeStation(hit),
  };
}

/** 单条线路详情（线路页）：沿途站点 + 车辆位置 */
export async function fetchLine({
  cityId = "040",
  lineId,
  dir = "1",
  stationId = "",
  lat = "",
  lng = "",
}) {
  if (!lineId) throw new Error("缺少 lineId");
  const raw = await request("/bus/line!encryptedLineDetail.action", {
    ...DEFAULT_PARAMS,
    cityId,
    localCityId: cityId,
    lineId,
    direction: String(dir),
    stationId,
    targetOrder: "0",
    lat: String(lat || ""),
    lng: String(lng || ""),
    geo_lat: String(lat || ""),
    geo_lng: String(lng || ""),
    userId: "",
    h5Id: "",
    unionId: "",
    accountId: "",
    secret: "",
  });

  const ln = raw?.line || {};
  const stations = (Array.isArray(raw?.stations) ? raw.stations : []).map((s) => ({
    name: s.sn || "",
    order: typeof s.order === "number" ? s.order : 0,
    sId: s.sId || "",
    metropolitan: Array.isArray(s.metros) && s.metros.length > 0,
  }));

  // 目标站以「传进来的 stationId 是否真在这条线上」为准：
  // 反方向往往不经过原站，此时上游会退化成第一个站，必须自己挡掉
  const upstreamTarget = Number(raw?.targetOrder) || 0;
  const wantId = String(stationId || "");
  let targetStation = wantId ? stations.find((s) => String(s.sId) === wantId) : null;
  if (!wantId) targetStation = stations.find((s) => s.order === upstreamTarget) || null;
  const targetOrder = targetStation ? targetStation.order : 0;
  const targetName = targetStation ? targetStation.name : "";

  // 车辆：order = 正在驶向的站序（配合 distanceToSc 就是「车在两站之间」）
  // travels 里带的是「到目标站」的预测，distanceToWaitStn 是到目标站的距离
  const buses = (Array.isArray(raw?.buses) ? raw.buses : [])
    .map((b) => {
      const toTarget = (Array.isArray(b.travels) ? b.travels : []).find(
        (t) => Number(t.order) === targetOrder,
      );
      return {
        order: typeof b.order === "number" ? b.order : 0,
        distNext: typeof b.distanceToSc === "number" && b.distanceToSc >= 0 ? b.distanceToSc : -1,
        eta: toTarget && typeof toTarget.travelTime === "number" ? toTarget.travelTime : -1,
        dist: typeof b.distanceToWaitStn === "number" && b.distanceToWaitStn >= 0 ? b.distanceToWaitStn : -1,
      };
    })
    .filter((b) => b.order > 0)
    .sort((a, b) => (a.eta < 0 ? 1e9 : a.eta) - (b.eta < 0 ? 1e9 : b.eta));

  return {
    cityId,
    city: CITIES[cityId] || "",
    updatedAt: Date.now(),
    line: {
      id: lineId,
      no: String(ln.name || "").replace(/^0+/, "") || String(ln.lineNo || ""),
      from: ln.startSn || "",
      to: ln.destinationName || ln.endSn || "",
      dir: ln.direction ?? Number(dir),
      first: ln.firstTime || "",
      last: ln.lastTime || "",
      price: ln.price || "",
      count: typeof ln.stationsNum === "number" ? ln.stationsNum : stations.length,
      targetOrder,
      targetName,
      /** 传了站但这条线不经停该站时为 false，前端据此提示 */
      targetMatched: !!targetStation,
    },
    stations,
    buses,
  };
}
