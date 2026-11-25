// 高德地图：JS API 加载 + 公交线路 / 车辆落图 + 算路方案画线
import { wgs84ToGcj02 } from "./watch.js";

export const AMAP_JS_KEY = "79bf7b30ea3e72975f232532d0312aac";
const AMAP_SECURITY_CODE = "259d66682eebf0d8999f65b99175221c";

let loadPromise = null;

/** 加载高德 JS API 2.0（只加载一次）；失败时 reject，调用方显示「地图加载失败」 */
export function loadAmap() {
  if (loadPromise) return loadPromise;
  loadPromise = new Promise((resolve, reject) => {
    if (window.AMap) return resolve(window.AMap);
    window._AMapSecurityConfig = { securityJsCode: AMAP_SECURITY_CODE };
    const script = document.createElement("script");
    script.src = `https://webapi.amap.com/maps?v=2.0&key=${AMAP_JS_KEY}`;
    script.async = true;
    script.onload = () => (window.AMap ? resolve(window.AMap) : reject(new Error("高德地图加载失败")));
    script.onerror = () => reject(new Error("高德地图加载失败"));
    document.head.appendChild(script);
  });
  return loadPromise;
}

function gcj(lng, lat) {
  if (typeof lng !== "number" || typeof lat !== "number") return null;
  const p = wgs84ToGcj02(lng, lat);
  return [p.lng, p.lat];
}

/**
 * 在 el 里建一张公交地图。
 * routes: [{ stations: [{name, order, lat, lng}], buses: [{lat, lng, speed, plate, order}], targetOrder }]
 * 站点连线 + 站点标记（目标站高亮）+ 车辆标记（🚌 + 时速）。
 * 返回 { map, destroy() }。
 */
export async function createBusMap(el, { routes }) {
  const AMap = await loadAmap();
  const map = new AMap.Map(el, { zoom: 14, resizeEnable: true });
  const overlays = [];
  const add = (o) => {
    map.add(o);
    overlays.push(o);
  };

  for (const route of routes || []) {
    const stations = (route.stations || []).filter((s) => typeof s.lat === "number" && typeof s.lng === "number");
    const sorted = [...stations].sort((a, b) => a.order - b.order);
    const path = sorted.map((s) => gcj(s.lng, s.lat)).filter(Boolean);
    if (path.length >= 2) {
      add(new AMap.Polyline({ path, strokeColor: "#1B5BFF", strokeWeight: 5, strokeOpacity: 0.85, lineJoin: "round" }));
    }
    for (const s of sorted) {
      const pos = gcj(s.lng, s.lat);
      if (!pos) continue;
      const isTarget = route.targetOrder && s.order === route.targetOrder;
      const isEnd = s.order === sorted[0]?.order || s.order === sorted[sorted.length - 1]?.order;
      add(
        new AMap.Marker({
          position: pos,
          content: `<div style="width:${isTarget ? 16 : 11}px;height:${isTarget ? 16 : 11}px;border-radius:50%;background:${isTarget ? "#1B5BFF" : isEnd ? "#1B5BFF" : "#fff"};border:2.5px solid #1B5BFF;box-shadow:0 1px 4px rgba(0,0,0,.3)"></div>`,
          offset: new AMap.Pixel(isTarget ? -8 : -5.5, isTarget ? -8 : -5.5),
          title: s.name,
        }),
      );
    }
    for (const b of route.buses || []) {
      const pos = gcj(b.lng, b.lat);
      if (!pos) continue;
      const speed = typeof b.speed === "number" && b.speed > 0 ? `${Math.round(b.speed)} km/h` : "";
      add(
        new AMap.Marker({
          position: pos,
          content: `<div style="display:flex;align-items:center;gap:3px;background:#fff;border:1.5px solid #0EA95B;color:#15803D;border-radius:999px;padding:3px 8px;font-size:12px;font-weight:700;box-shadow:0 2px 8px rgba(0,0,0,.18);white-space:nowrap">🚌${speed ? `<span>${speed}</span>` : ""}</div>`,
          offset: new AMap.Pixel(-14, -13),
        }),
      );
    }
  }

  if (overlays.length) map.setFitView(overlays, false, [30, 30, 30, 30]);
  return {
    map,
    destroy() {
      try {
        map.destroy();
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * 在 el 里画一条算路方案：segments 的 polyline（GCJ-02 坐标串，高德直接返回）。
 * 步行灰色虚线，公交/地铁蓝色实线；起终点打标记。
 * 返回 { map, destroy() }。
 */
export async function drawPlanOnMap(el, plan, { origin, destination } = {}) {
  const AMap = await loadAmap();
  const map = new AMap.Map(el, { zoom: 14, resizeEnable: true });
  const overlays = [];
  const add = (o) => {
    map.add(o);
    overlays.push(o);
  };

  for (const seg of plan?.segments || []) {
    const path = (seg.polyline || []).filter((p) => Array.isArray(p) && p.length === 2);
    if (path.length < 2) continue;
    const isWalk = seg.kind === "walk";
    add(
      new AMap.Polyline({
        path,
        strokeColor: isWalk ? "#9CA3AF" : "#1B5BFF",
        strokeWeight: isWalk ? 3 : 5,
        strokeOpacity: isWalk ? 0.8 : 0.9,
        strokeStyle: isWalk ? "dashed" : "solid",
        lineJoin: "round",
      }),
    );
  }

  const dot = (pos, label, color) => {
    add(
      new AMap.Marker({
        position: pos,
        content: `<div style="display:flex;align-items:center;gap:4px;background:${color};color:#fff;border-radius:999px;padding:4px 10px;font-size:12px;font-weight:700;box-shadow:0 2px 8px rgba(0,0,0,.25);white-space:nowrap">${label}</div>`,
        offset: new AMap.Pixel(-16, -13),
      }),
    );
  };
  const first = plan?.segments?.[0]?.polyline?.[0];
  const lastSeg = plan?.segments?.[plan.segments.length - 1];
  const last = lastSeg?.polyline?.[lastSeg.polyline.length - 1];
  if (first) dot(first, "起点", "#1B5BFF");
  if (last) dot(last, "终点", "#0EA95B");
  void origin;
  void destination;

  if (overlays.length) map.setFitView(overlays, false, [40, 40, 40, 40]);
  return {
    map,
    destroy() {
      try {
        map.destroy();
      } catch {
        /* ignore */
      }
    },
  };
}
