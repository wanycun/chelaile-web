// 车来了上游客户端：签名 → 请求 → 解密 → 精简成前端可用的结构。
// 只做只读、低频的「附近站点」查询。
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
  if (data.encryptResult) return JSON.parse(await aesEcbDecrypt(data.encryptResult));
  return data;
}

/** 把 stnStates 压成最多两条到站信息 */
function pickBuses(line) {
  const states = Array.isArray(line?.stnStates) ? line.stnStates : [];
  const buses = states
    .map((s) => ({
      eta: typeof s.travelTime === "number" ? s.travelTime : -1,
      dist: typeof s.distanceToDest === "number" ? s.distanceToDest : -1,
      cap: typeof s.capacity === "number" ? s.capacity : 0,
      left: typeof s.value === "number" ? s.value : -1,
    }))
    .filter((b) => b.eta >= 0 || b.dist > 0)
    .sort((a, b) => (a.eta < 0 ? 1e9 : a.eta) - (b.eta < 0 ? 1e9 : b.eta))
    .slice(0, 2);
  return buses;
}

function pickTags(line) {
  const list = line?.stnStates?.[0]?.busTagList;
  if (!Array.isArray(list)) return [];
  return list.map((t) => t?.title).filter(Boolean).slice(0, 2);
}

export function reshapeNearby(raw, limit = 8) {
  const stations = Array.isArray(raw?.nearSts) ? raw.nearSts : [];
  return stations
    .map((s) => {
      const lines = (Array.isArray(s.lines) ? s.lines : []).map((l) => {
        const ln = l.line || {};
        return {
          no: String(ln.name || ln.lineNo || "").replace(/^0+/, "") || String(ln.lineNo || ""),
          to: ln.destinationName || ln.endSn || "",
          dir: ln.direction ?? 0,
          first: ln.firstTime || "",
          last: ln.lastTime || "",
          hasBus: !!ln.hasBusInfo,
          subway: !!(ln.isSubway || s.isSubway),
          buses: pickBuses(l),
          // 未发车的线路：上游给预计发车时刻（"17:25" 或 "17:08~17:18"）
          pre: l.preArrivalTime || "",
          tags: pickTags(l),
        };
      });
      return {
        sId: s.sId || "",
        name: s.sn || "",
        distance: typeof s.distance === "number" ? s.distance : -1,
        subway: !!s.isSubway,
        lines: lines.filter((l) => l.no),
      };
    })
    .filter((s) => s.name && s.lines.length)
    .sort((a, b) => (a.distance < 0 ? 1e9 : a.distance) - (b.distance < 0 ? 1e9 : b.distance))
    .slice(0, limit);
}

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
