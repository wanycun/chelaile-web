// 高德地图：JS API 加载 + 公交线路 / 车辆落图 + 算路方案画线
import { wgs84ToGcj02 } from "./watch.js";
import { esc } from "./util.js";

export const AMAP_JS_KEY = "79bf7b30ea3e72975f232532d0312aac";
const AMAP_SECURITY_CODE = "259d66682eebf0d8999f65b99175221c";

let loadPromise = null;

/** 加载高德 JS API 2.0（只加载一次）；失败时 reject 并清掉缓存，调用方可重试 */
export function loadAmap() {
  if (loadPromise) return loadPromise;
  loadPromise = new Promise((resolve, reject) => {
    if (window.AMap) return resolve(window.AMap);
    window._AMapSecurityConfig = { securityJsCode: AMAP_SECURITY_CODE };
    const script = document.createElement("script");
    script.src = `https://webapi.amap.com/maps?v=2.0&key=${AMAP_JS_KEY}`;
    script.async = true;
    script.onload = () => {
      if (window.AMap) resolve(window.AMap);
      else {
        loadPromise = null;
        reject(new Error("高德地图加载失败"));
      }
    };
    script.onerror = () => {
      loadPromise = null;
      reject(new Error("高德地图加载失败"));
    };
    document.head.appendChild(script);
  });
  return loadPromise;
}

/** 上游坐标有效性：过滤 null/0/NaN/越界（异常坐标曾把 fitBounds 撑到整个华南） */
function validCoord(lng, lat) {
  return (
    typeof lng === "number" &&
    typeof lat === "number" &&
    Number.isFinite(lng) &&
    Number.isFinite(lat) &&
    lng >= 70 &&
    lng <= 140 &&
    lat >= 15 &&
    lat <= 55 &&
    !(lng === 0 && lat === 0)
  );
}

function gcj(lng, lat) {
  if (!validCoord(lng, lat)) return null;
  const p = wgs84ToGcj02(lng, lat);
  return [p.lng, p.lat];
}

const BUS_CLUSTER_DIST = 0.004; // 约 400m 内算同一簇
const BUS_LABEL_ZOOM = 16; // ≥16 才逐辆显示时速标签
const ST_LABEL_ZOOM = 15; // ≥15 才显示站名，低缩放只显示圆点

/**
 * 在 el 里建一张公交地图。
 * routes: [{ stations: [{name, order, lat, lng}], buses: [{lat, lng, speed, plate, order}], targetOrder }]
 * 站点连线 + 站点标记（圆点 + 站名，目标站高亮）+ 车辆标记（低缩放聚合，高缩放逐辆）。
 * 定 bounds 只按站点连线，不含车辆标记；updateBuses() 原地刷新标记，不动视野。
 * 返回 { map, updateBuses(routes), destroy() }。
 */
export async function createBusMap(el, { routes }) {
  const AMap = await loadAmap();
  const map = new AMap.Map(el, { zoom: 14, center: [113.32, 23.13], resizeEnable: true });
  const polylineOverlays = [];
  let stationMarkers = [];
  let busMarkers = [];
  let currentRoutes = routes || [];

  const removeMarkers = (list) => {
    for (const m of list) map.remove(m);
    list.length = 0;
  };

  function buildPolylines() {
    for (const route of currentRoutes) {
      const stations = (route.stations || []).filter((s) => gcj(s.lng, s.lat));
      const sorted = [...stations].sort((a, b) => a.order - b.order);
      const path = sorted.map((s) => gcj(s.lng, s.lat)).filter(Boolean);
      if (path.length >= 2) {
        const pl = new AMap.Polyline({
          path,
          strokeColor: "#1B5BFF",
          strokeWeight: 5,
          strokeOpacity: 0.85,
          lineJoin: "round",
        });
        map.add(pl);
        polylineOverlays.push(pl);
      }
    }
  }

  function renderStationMarkers() {
    removeMarkers(stationMarkers);
    for (const route of currentRoutes) {
      const stations = (route.stations || []).filter((s) => gcj(s.lng, s.lat));
      const sorted = [...stations].sort((a, b) => a.order - b.order);
      for (const s of sorted) {
        const pos = gcj(s.lng, s.lat);
        if (!pos) continue;
        const isTarget = route.targetOrder && s.order === route.targetOrder;
        const isEnd = s.order === sorted[0]?.order || s.order === sorted[sorted.length - 1]?.order;
        const dot = isTarget ? 16 : 11;
        const marker = new AMap.Marker({
          position: pos,
          content: `<div style="display:flex;align-items:center;gap:5px"><span style="flex:none;width:${dot}px;height:${dot}px;border-radius:50%;background:${isTarget || isEnd ? "#1B5BFF" : "#fff"};border:2.5px solid #1B5BFF;box-shadow:0 1px 4px rgba(0,0,0,.3)"></span><span class="st-label" style="background:rgba(255,255,255,.94);border:1px solid #d1d5db;border-radius:6px;padding:2px 7px;font-size:11.5px;font-weight:${isTarget ? 800 : 600};color:${isTarget ? "#1D4ED8" : "#374151"};white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,.15)">${esc(s.name)}</span></div>`,
          offset: new AMap.Pixel(-dot / 2, -dot / 2),
          title: s.name,
        });
        map.add(marker);
        stationMarkers.push(marker);
      }
    }
  }

  /** 距离很近的车合成一簇（中心取第一辆车的位置） */
  function clusterBuses(list) {
    const clusters = [];
    for (const b of list) {
      const c = clusters.find(
        (c) => Math.abs(c.lng - b.pos[0]) < BUS_CLUSTER_DIST && Math.abs(c.lat - b.pos[1]) < BUS_CLUSTER_DIST,
      );
      if (c) c.items.push(b);
      else clusters.push({ lng: b.pos[0], lat: b.pos[1], items: [b] });
    }
    return clusters;
  }

  function renderBusMarkers() {
    removeMarkers(busMarkers);
    const detailed = map.getZoom() >= BUS_LABEL_ZOOM;
    for (const route of currentRoutes) {
      const buses = (route.buses || [])
        .map((b) => ({ ...b, pos: gcj(b.lng, b.lat) }))
        .filter((b) => b.pos);
      if (detailed) {
        for (const b of buses) {
          const speed = typeof b.speed === "number" && b.speed > 0 ? `${Math.round(b.speed)} km/h` : "";
          const marker = new AMap.Marker({
            position: b.pos,
            content: `<div style="display:flex;align-items:center;gap:3px;background:#fff;border:1.5px solid #0EA95B;color:#15803D;border-radius:999px;padding:3px 8px;font-size:12px;font-weight:700;box-shadow:0 2px 8px rgba(0,0,0,.18);white-space:nowrap">🚌${speed ? `<span>${speed}</span>` : ""}</div>`,
            offset: new AMap.Pixel(-14, -13),
          });
          map.add(marker);
          busMarkers.push(marker);
        }
        continue;
      }
      for (const c of clusterBuses(buses)) {
        if (c.items.length === 1) {
          const marker = new AMap.Marker({
            position: [c.lng, c.lat],
            content: `<div style="display:flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:50%;background:#0EA95B;color:#fff;font-size:13px;box-shadow:0 2px 8px rgba(0,0,0,.25)">🚌</div>`,
            offset: new AMap.Pixel(-13, -13),
          });
          map.add(marker);
          busMarkers.push(marker);
        } else {
          const marker = new AMap.Marker({
            position: [c.lng, c.lat],
            content: `<div style="display:flex;align-items:center;gap:2px;background:#0EA95B;color:#fff;border-radius:999px;padding:4px 10px;font-size:12.5px;font-weight:800;box-shadow:0 2px 8px rgba(0,0,0,.25);white-space:nowrap">🚌×${c.items.length}</div>`,
            offset: new AMap.Pixel(-20, -13),
          });
          marker.on("click", () => {
            map.setZoomAndCenter(Math.min(map.getZoom() + 2, 18), [c.lng, c.lat]);
          });
          map.add(marker);
          busMarkers.push(marker);
        }
      }
    }
  }

  function syncZoomClass() {
    el.classList.toggle("zoom-low", map.getZoom() < ST_LABEL_ZOOM);
  }

  map.on("zoomend", () => {
    syncZoomClass();
    renderBusMarkers();
  });

  buildPolylines();
  renderStationMarkers();
  renderBusMarkers();
  // 定 bounds 只按站点连线（车辆标记不参与）；没有连线时退到站点标记
  if (polylineOverlays.length) map.setFitView(polylineOverlays, false, [30, 30, 30, 30]);
  else if (stationMarkers.length) map.setFitView(stationMarkers, false, [30, 30, 30, 30]);
  // fit 可能改变缩放，按最终缩放重算一次标记形态与站名显隐
  renderBusMarkers();
  syncZoomClass();

  return {
    map,
    /** 原地刷新车辆与站点标记（目标站高亮跟着走），不改动视野、不重新 fit */
    updateBuses(routes) {
      currentRoutes = routes || [];
      renderStationMarkers();
      renderBusMarkers();
    },
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
