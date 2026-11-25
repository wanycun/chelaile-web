// 高德地图：JS API 加载 + 公交线路 / 车辆落图 + 算路方案画线
import { wgs84ToGcj02, plateTail } from "./watch.js";
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
const ST_LABEL_ZOOM = 15; // ≥15 全部站名
const ST_LABEL_SPARSE_ZOOM = 10; // 10–14 只显示目标站 + 起讫 + 每 4 站；<10 只留圆点
const SPIDER_EVERY = 4; // 稀疏站名每 4 站一个
const SPIDER_EPS = 0.0002; // 约 20m 内算同一位置（坐标重合）
const SPIDER_R = 34; // 环形散开半径（px）

/**
 * 站名显隐（纯函数，可单测）：
 * - zoom ≥ 15：全部站名
 * - 10–14：目标站 + 起讫站 + 每 4 站一个。B1 整线 fit 缩放约 11，站间距仅约 12px，
 *   27 个白底标签全显会叠成一团，只能稀疏显示——站名在默认缩放下可见，但不是全显。
 * - zoom < 10（缩得很远）：只留圆点
 */
export function shouldShowStationLabel({ zoom, index, total, isTarget, isEnd }) {
  if (zoom >= ST_LABEL_ZOOM) return true;
  if (zoom >= ST_LABEL_SPARSE_ZOOM) {
    return Boolean(isTarget || isEnd || index % SPIDER_EVERY === 0);
  }
  return false;
}

/** 同一位置判定：若干个 [lng, lat] 是否两两都在 SPIDER_EPS 内（纯函数，可单测） */
export function sameSpot(positions) {
  if (positions.length < 2) return true;
  const [x0, y0] = positions[0];
  return positions.every(([x, y]) => Math.abs(x - x0) < SPIDER_EPS && Math.abs(y - y0) < SPIDER_EPS);
}

/** 环形散开的像素偏移：n 个点均匀分布在半径 r 的圆上（纯函数，可单测） */
export function spiderOffsets(n, r = SPIDER_R) {
  if (n <= 1) return [{ dx: 0, dy: 0 }];
  return Array.from({ length: n }, (_, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    return { dx: Math.round(Math.cos(a) * r), dy: Math.round(Math.sin(a) * r) };
  });
}

/**
 * 在 el 里建一张公交地图。
 * routes: [{ stations: [{name, order, lat, lng}], buses: [{lat, lng, speed, plate, order}], targetOrder }]
 * 站点连线 + 站点标记（圆点；站名按缩放显示：≥15 全显，10–14 稀疏显示，<10 只留圆点）+
 * 车辆标记（低缩放聚合，高缩放逐辆；坐标重合的车点簇后环形散开 spiderfy）。
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
  let expandedClusterKey = null; // 正在环形散开的簇（key = 簇中心经纬度），缩放/刷新后收起

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
    const zoom = map.getZoom();
    for (const route of currentRoutes) {
      const stations = (route.stations || []).filter((s) => gcj(s.lng, s.lat));
      const sorted = [...stations].sort((a, b) => a.order - b.order);
      for (let i = 0; i < sorted.length; i++) {
        const s = sorted[i];
        const pos = gcj(s.lng, s.lat);
        if (!pos) continue;
        const isTarget = route.targetOrder && s.order === route.targetOrder;
        const isEnd = i === 0 || i === sorted.length - 1;
        // 站名按缩放决定是否挂进标记（不是 CSS 隐藏）：默认 fit 缩放约 11 时稀疏显示，
        // 之前 zoom-low 阈值 15 与 fit 缩放对不上，站名在默认视图下永远不显示。
        const showLabel = shouldShowStationLabel({
          zoom,
          index: i,
          total: sorted.length,
          isTarget,
          isEnd,
        });
        const dot = isTarget ? 16 : 11;
        const label = showLabel
          ? `<span class="st-label" style="background:rgba(255,255,255,.94);border:1px solid #d1d5db;border-radius:6px;padding:2px 7px;font-size:11.5px;font-weight:${isTarget ? 800 : 600};color:${isTarget ? "#1D4ED8" : "#374151"};white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,.15)">${esc(s.name)}</span>`
          : "";
        const marker = new AMap.Marker({
          position: pos,
          content: `<div style="display:flex;align-items:center;gap:5px"><span style="flex:none;width:${dot}px;height:${dot}px;border-radius:50%;background:${isTarget || isEnd ? "#1B5BFF" : "#fff"};border:2.5px solid #1B5BFF;box-shadow:0 1px 4px rgba(0,0,0,.3)"></span>${label}</div>`,
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

  /** 单辆车标记内容：车牌尾号优先，没有车牌显示时速 */
  function busMarkerContent(b) {
    const tail = plateTail(b.plate);
    const speed = typeof b.speed === "number" && b.speed > 0 ? `${Math.round(b.speed)} km/h` : "";
    const label = tail || speed;
    return `<div style="display:flex;align-items:center;gap:3px;background:#fff;border:1.5px solid #0EA95B;color:#15803D;border-radius:999px;padding:3px 8px;font-size:12px;font-weight:700;box-shadow:0 2px 8px rgba(0,0,0,.18);white-space:nowrap">🚌${label ? `<span>${esc(label)}</span>` : ""}</div>`;
  }

  function singleBusContent() {
    return `<div style="display:flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:50%;background:#0EA95B;color:#fff;font-size:13px;box-shadow:0 2px 8px rgba(0,0,0,.25)">🚌</div>`;
  }

  function clusterContent(n) {
    return `<div style="display:flex;align-items:center;gap:2px;background:#0EA95B;color:#fff;border-radius:999px;padding:4px 10px;font-size:12.5px;font-weight:800;box-shadow:0 2px 8px rgba(0,0,0,.25);white-space:nowrap">🚌×${n}</div>`;
  }

  function addBusMarker(pos, content, offset = [-14, -13]) {
    const marker = new AMap.Marker({
      position: pos,
      content,
      offset: new AMap.Pixel(offset[0], offset[1]),
    });
    map.add(marker);
    busMarkers.push(marker);
    return marker;
  }

  /** 环形散开的中心锚点（真位置）；点它收起散开 */
  function addCenterDot(pos) {
    const marker = new AMap.Marker({
      position: pos,
      content: `<div style="width:12px;height:12px;border-radius:50%;background:#0EA95B;border:2px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,.35)"></div>`,
      offset: new AMap.Pixel(-6, -6),
    });
    marker.on("click", () => {
      expandedClusterKey = null;
      renderBusMarkers();
    });
    map.add(marker);
    busMarkers.push(marker);
    return marker;
  }

  /** n 辆重合的车在中心点周围环形散开后的真实位置（像素环 → 经纬度） */
  function spiderPositions(center, n) {
    const c = map.lngLatToContainer(new AMap.LngLat(center[0], center[1]));
    return spiderOffsets(n).map(({ dx, dy }) => {
      const p = map.containerToLngLat(new AMap.Pixel(c.x + dx, c.y + dy));
      return [p.lng, p.lat];
    });
  }

  /** 把重合的几辆车环形散开显示（spiderfy），每辆带车牌尾号/时速以区分 */
  function renderSpiderfied(center, items) {
    const ring = spiderPositions(center, items.length);
    addCenterDot(center);
    items.forEach((b, i) => addBusMarker(ring[i], busMarkerContent(b)));
  }

  function renderBusMarkers() {
    removeMarkers(busMarkers);
    const detailed = map.getZoom() >= BUS_LABEL_ZOOM;
    for (const route of currentRoutes) {
      const buses = (route.buses || [])
        .map((b) => ({ ...b, pos: gcj(b.lng, b.lat) }))
        .filter((b) => b.pos);
      if (detailed) {
        // 高缩放逐辆显示；坐标重合的几辆车会叠在同一个像素上，环形散开
        const groups = [];
        for (const b of buses) {
          const g = groups.find((g) => sameSpot([g.pos, b.pos]));
          if (g) g.items.push(b);
          else groups.push({ pos: b.pos, items: [b] });
        }
        for (const g of groups) {
          if (g.items.length === 1) addBusMarker(g.pos, busMarkerContent(g.items[0]));
          else renderSpiderfied(g.pos, g.items);
        }
        continue;
      }
      for (const c of clusterBuses(buses)) {
        if (c.items.length === 1) {
          addBusMarker([c.lng, c.lat], singleBusContent(), [-13, -13]);
        } else {
          const key = `${c.lng.toFixed(5)},${c.lat.toFixed(5)}`;
          const coincident = sameSpot(c.items.map((b) => b.pos));
          if (coincident && expandedClusterKey === key) {
            // 已展开：环形散开显示各车（点中心绿点收起）
            renderSpiderfied([c.lng, c.lat], c.items);
          } else {
            const marker = addBusMarker([c.lng, c.lat], clusterContent(c.items.length), [-20, -13]);
            marker.on("click", () => {
              if (coincident) {
                // 坐标重合：放大也分不开，改环形散开；缩放或刷新后自动收起
                expandedClusterKey = key;
                renderBusMarkers();
              } else {
                map.setZoomAndCenter(Math.min(map.getZoom() + 2, 18), [c.lng, c.lat]);
              }
            });
          }
        }
      }
    }
  }

  map.on("zoomend", () => {
    // 缩放后簇与站名按新缩放重算；散开的环收起
    expandedClusterKey = null;
    renderStationMarkers();
    renderBusMarkers();
  });

  buildPolylines();
  renderStationMarkers();
  renderBusMarkers();
  // 定 bounds 只按站点连线（车辆标记不参与）；没有连线时退到站点标记
  if (polylineOverlays.length) map.setFitView(polylineOverlays, false, [30, 30, 30, 30]);
  else if (stationMarkers.length) map.setFitView(stationMarkers, false, [30, 30, 30, 30]);
  // fit 可能改变缩放，按最终缩放重算一次站名显隐与车辆形态
  renderStationMarkers();
  renderBusMarkers();

  return {
    map,
    /** 原地刷新车辆与站点标记（目标站高亮跟着走），不改动视野、不重新 fit */
    updateBuses(routes) {
      currentRoutes = routes || [];
      expandedClusterKey = null; // 新数据到了，散开的环收起
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
