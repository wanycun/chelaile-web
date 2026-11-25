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

/** 站名标签宽度估算（px）：中文约 12px/字，ASCII 约 7px/字，+ 内边距与边框 16px（纯函数，可单测） */
export function estimateLabelWidth(name) {
  let w = 16;
  for (const ch of String(name || "")) {
    w += ch.charCodeAt(0) > 0xff ? 12 : 7;
  }
  return w;
}

/** 两个包围盒是否重叠（margin 为安全间距，纯函数，可单测） */
export function boxesOverlap(a, b, margin = 2) {
  return a.x0 < b.x1 + margin && a.x1 + margin > b.x0 && a.y0 < b.y1 + margin && a.y1 + margin > b.y0;
}

const LABEL_DY = 26; // 标签竖向交错的偏移量（px）；标签盒高约 24px，错开后上下互不重叠
const LABEL_HALF_H = 12;

/**
 * 给站名标签选落点（纯函数，可单测）：
 * 依次试 右 / 左 / 右上 / 左上 / 右下 / 左下，落点盒须在容器内且不与 obstacles（已保留的
 * 标签盒 + 车辆标记盒）重叠；全部失败返回 null（只留圆点，站名靠 hover 的 title 看）。
 * zIndex 只能解决「标签 vs 车辆」的层叠，解决不了「标签 vs 标签」互压（B1 默认缩放约 11
 * 时站间距仅约 12px，标签 70–90px 宽，每 4 站一个仍会互压），所以必须做防撞。
 */
export function placeLabel(anchor, dot, labelWidth, obstacles, size) {
  const tries = [
    { side: "right", dy: 0 },
    { side: "left", dy: 0 },
    { side: "right", dy: -LABEL_DY },
    { side: "left", dy: -LABEL_DY },
    { side: "right", dy: LABEL_DY },
    { side: "left", dy: LABEL_DY },
  ];
  for (const t of tries) {
    const x0 = t.side === "right" ? anchor.x + dot / 2 + 5 : anchor.x - dot / 2 - 5 - labelWidth;
    const box = {
      x0,
      x1: x0 + labelWidth,
      y0: anchor.y + t.dy - LABEL_HALF_H,
      y1: anchor.y + t.dy + LABEL_HALF_H,
    };
    if (box.x0 < 0 || box.y0 < 0 || box.x1 > size.width || box.y1 > size.height) continue;
    if (obstacles.some((o) => boxesOverlap(box, o))) continue;
    return { side: t.side, dy: t.dy, box };
  }
  return null;
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

  /** 车辆标记在屏幕上的包围盒（供站名防撞用；落点逻辑与 renderBusMarkers 保持一致） */
  function computeBusBoxes() {
    const boxes = [];
    const zoom = map.getZoom();
    const toPx = (lngLat) => map.lngLatToContainer(new AMap.LngLat(lngLat[0], lngLat[1]));
    for (const route of currentRoutes) {
      const buses = (route.buses || [])
        .map((b) => ({ ...b, pos: gcj(b.lng, b.lat) }))
        .filter((b) => b.pos);
      if (zoom >= BUS_LABEL_ZOOM) {
        const groups = [];
        for (const b of buses) {
          const g = groups.find((g) => sameSpot([g.pos, b.pos]));
          if (g) g.items.push(b);
          else groups.push({ pos: b.pos, items: [b] });
        }
        for (const g of groups) {
          const c = toPx(g.pos);
          if (g.items.length === 1) {
            // 单辆车：白底时速 pill，约 90×28（offset [-14,-13]）
            boxes.push({ x0: c.x - 14, x1: c.x + 76, y0: c.y - 13, y1: c.y + 15 });
          } else {
            // 环形散开：34px 半径的环 + pill，按 120×120 的方框算
            boxes.push({ x0: c.x - 60, x1: c.x + 60, y0: c.y - 60, y1: c.y + 60 });
          }
        }
        continue;
      }
      for (const c of clusterBuses(buses)) {
        const p = toPx([c.lng, c.lat]);
        if (c.items.length === 1) {
          // 单辆车：26px 绿圆点（offset [-13,-13]）
          boxes.push({ x0: p.x - 13, x1: p.x + 13, y0: p.y - 13, y1: p.y + 13 });
        } else {
          const key = `${c.lng.toFixed(5)},${c.lat.toFixed(5)}`;
          const coincident = sameSpot(c.items.map((b) => b.pos));
          if (coincident && expandedClusterKey === key) {
            boxes.push({ x0: p.x - 60, x1: p.x + 60, y0: p.y - 60, y1: p.y + 60 });
          } else {
            // 簇徽章 🚌×N，约 55×28（offset [-20,-13]）
            boxes.push({ x0: p.x - 20, x1: p.x + 35, y0: p.y - 13, y1: p.y + 15 });
          }
        }
      }
    }
    return boxes;
  }

  const stationDotHtml = (dot, isTarget, isEnd) =>
    `<span style="flex:none;width:${dot}px;height:${dot}px;border-radius:50%;background:${isTarget || isEnd ? "#1B5BFF" : "#fff"};border:2.5px solid #1B5BFF;box-shadow:0 1px 4px rgba(0,0,0,.3)"></span>`;

  const stationLabelHtml = (name, isTarget, dy) =>
    `<span class="st-label" style="background:rgba(255,255,255,.94);border:1px solid #d1d5db;border-radius:6px;padding:2px 7px;font-size:11.5px;font-weight:${isTarget ? 800 : 600};color:${isTarget ? "#1D4ED8" : "#374151"};white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,.15);transform:translateY(${dy - 4}px)">${esc(name)}</span>`;

  function renderStationMarkers() {
    removeMarkers(stationMarkers);
    const zoom = map.getZoom();
    const size = map.getSize();
    const container = { width: size.width, height: size.height };
    // 先收集全部候选站名（跨线路统一防撞），按优先级排序：目标站 > 起讫站 > 其余按站序。
    // 站名按缩放决定是否挂进标记（不是 CSS 隐藏）：默认 fit 缩放约 11 时稀疏显示，
    // 之前 zoom-low 阈值 15 与 fit 缩放对不上，站名在默认视图下永远不显示。
    const candidates = [];
    const dotsOnly = [];
    for (const route of currentRoutes) {
      const stations = (route.stations || []).filter((s) => gcj(s.lng, s.lat));
      const sorted = [...stations].sort((a, b) => a.order - b.order);
      for (let i = 0; i < sorted.length; i++) {
        const s = sorted[i];
        const pos = gcj(s.lng, s.lat);
        if (!pos) continue;
        const isTarget = route.targetOrder && s.order === route.targetOrder;
        const isEnd = i === 0 || i === sorted.length - 1;
        const showLabel = shouldShowStationLabel({
          zoom,
          index: i,
          total: sorted.length,
          isTarget,
          isEnd,
        });
        const item = { s, pos, isTarget, isEnd, order: s.order };
        if (showLabel) candidates.push(item);
        else dotsOnly.push(item);
      }
    }
    candidates.sort(
      (a, b) =>
        (a.isTarget ? 0 : a.isEnd ? 1 : 2) - (b.isTarget ? 0 : b.isEnd ? 1 : 2) || a.order - b.order,
    );
    const busBoxes = computeBusBoxes();
    const keptBoxes = [];
    const drawStation = (item, placement) => {
      const { s, pos, isTarget, isEnd } = item;
      const dot = isTarget ? 16 : 11;
      const labelWidth = estimateLabelWidth(s.name);
      const label = placement ? stationLabelHtml(s.name, isTarget, placement.dy) : "";
      const dotHtml = stationDotHtml(dot, isTarget, isEnd);
      // 标签在圆点左侧时内容顺序调换，并把 offset 左移一个标签宽，保证圆点仍落在站位上
      const content =
        placement && placement.side === "left"
          ? `<div style="display:flex;align-items:center;gap:5px">${label}${dotHtml}</div>`
          : `<div style="display:flex;align-items:center;gap:5px">${dotHtml}${label}</div>`;
      const offsetX =
        placement && placement.side === "left" ? -(labelWidth + 5 + dot / 2) : -dot / 2;
      const marker = new AMap.Marker({
        position: pos,
        content,
        offset: new AMap.Pixel(offsetX, -dot / 2),
        title: s.name,
        // 站名标签层级高于车辆气泡/簇徽章（100），目标站最高，避免站名被车盖住
        zIndex: isTarget ? 300 : 200,
      });
      map.add(marker);
      stationMarkers.push(marker);
    };
    for (const item of candidates) {
      const { s, pos, isTarget } = item;
      const dot = isTarget ? 16 : 11;
      const labelWidth = estimateLabelWidth(s.name);
      const anchor = map.lngLatToContainer(new AMap.LngLat(pos[0], pos[1]));
      const placement = placeLabel(anchor, dot, labelWidth, [...keptBoxes, ...busBoxes], container);
      if (placement) keptBoxes.push(placement.box);
      drawStation(item, placement);
    }
    for (const item of dotsOnly) drawStation(item, null);
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
      // 车辆气泡层级低于站名标签（200/300），密集处不盖站名
      zIndex: 100,
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
      // 散开锚点高于车辆气泡、低于站名标签
      zIndex: 150,
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
