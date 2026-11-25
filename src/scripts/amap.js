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
const BUS_LABEL_ZOOM = 14; // ≥14 逐辆显示时速 pill；<14 车辆只画小绿点/小徽章，站名优先
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
 * 错开标签的引线几何（纯函数，可单测）：引线是标签标记自身 HTML 里的一条竖线，
 * 不再用 AMap.Polyline——上一轮 Polyline 方案在真实浏览器里一条都看不见（mock 单测
 * 说画了也没用），图层/坐标换算/重绘清除里有没摸到的坑，直接弃用。
 * 几何（以标签内容左上角为原点，标签盒高 24px、半高 12px）：
 * - 线宽 2px、x 位置 = 圆点中心 x（side right 时在标签盒左侧 dot/2+5 px 外，
 *   side left 时在右侧同等距离外），线尾正好落在圆点中心上；
 * - 线从标签盒垂直中心出发、长度 |dy|：dy<0（标签在上）时 top=12，尾 = 12+26=38
 *   = 圆点中心相对 y（-dy+12）；dy>0（标签在下）时 top=-14，尾 = -14+26=12
 *   = 标签盒垂直中心。线在标签盒外的可见段正好是标签边沿到圆点的 14px 间隙，
 *   不压文字。
 * dy=0 的贴点标签不画线，返回 null。
 */
export function leaderGeometry(placement, dot, labelWidth) {
  if (!placement || placement.dy === 0) return null;
  const dotRelX =
    placement.side === "right" ? -(dot / 2 + 5) : labelWidth + dot / 2 + 5;
  const dotRelY = -placement.dy + LABEL_HALF_H;
  return {
    left: dotRelX - 1, // 2px 宽的线，左缘 = 圆点中心 x - 1
    top: Math.min(dotRelY, LABEL_HALF_H),
    height: Math.abs(placement.dy),
  };
}

/**
 * 给站名标签选落点（纯函数，可单测）：
 * 依次试 右 / 左 / 右上 / 左上 / 右下 / 左下，落点盒须在容器内且不与 obstacles（已保留的
 * 标签盒）重叠；全部失败返回 null（只留圆点，站名靠 hover 的 title 看）。
 * 标签优先、车辆让路：obstacles 里只有标签盒，不再把车辆标记当障碍物——与标签重叠的
 * 车辆标记由 renderBusMarkers 直接跳过，不许再把标签顶成圆点。
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
 * 车辆标记（<14 只画小绿点/小徽章，≥14 逐辆显示时速 pill；坐标重合的车点簇后环形散开 spiderfy）。
 * 标签优先、车辆让路：站名标签防撞只看标签盒，撞标签的车辆标记直接不画；错开的标签
 * 在标记 HTML 里带一条竖线引线连回自己的圆点（与标签同一 Marker、层级 400/500，
 * 不用 Polyline、不做经纬度换算，缩放/平移/重绘都与标签同生同灭）。
 * 定 bounds 只按站点连线，不含车辆标记；updateBuses() 原地刷新标记，不动视野。
 * 返回 { map, updateBuses(routes), destroy() }。
 */
export async function createBusMap(el, { routes }) {
  const AMap = await loadAmap();
  const map = new AMap.Map(el, { zoom: 14, center: [113.32, 23.13], resizeEnable: true });
  const polylineOverlays = [];
  let stationMarkers = [];
  let busMarkers = [];
  let labelBoxes = []; // 本轮已保留的站名标签盒（屏幕坐标），供车辆标记让路用
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

  /** 车辆标记的屏幕包围盒：内容宽高 + offset（与 addBusMarker 的落点一致） */
  function markerBox(p, w, h, ox, oy) {
    return { x0: p.x + ox, x1: p.x + ox + w, y0: p.y + oy, y1: p.y + oy + h };
  }

  /** 车辆标记是否撞上站名标签：标签优先，车辆让路，撞上的车辆标记不画 */
  function blockedByLabel(box) {
    return labelBoxes.some((l) => boxesOverlap(box, l));
  }

  const stationDotHtml = (dot) =>
    `<span style="flex:none;width:${dot}px;height:${dot}px;border-radius:50%;background:#1B5BFF;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.35)"></span>`;

  // 标签单独成标记：位置由 marker 的经纬度 + offset 定，不再用 translateY 错位。
  // 错开的标签（dy≠0）在标记 HTML 里自带一条竖线引线：2px 宽 #6B7280 实色，
  // 从标签盒垂直中心出发、长 |dy|、尾端正好落在圆点中心上（见 leaderGeometry）。
  // 引线与标签同属一个 Marker（层级 400/500），不存在跨图层被盖、不存在经纬度
  // 换算，缩放/平移后高德自己带着标记走，重绘时与标签同生同灭。
  const stationLabelHtml = (name, isTarget, leader) => {
    const label = `<span class="st-label" style="position:relative;z-index:1;background:rgba(255,255,255,.94);border:1px solid #d1d5db;border-radius:6px;padding:2px 7px;font-size:11.5px;font-weight:${isTarget ? 800 : 600};color:${isTarget ? "#1D4ED8" : "#374151"};white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,.15)">${esc(name)}</span>`;
    if (!leader) return label;
    return `<span style="position:relative;display:inline-block">${label}<span style="position:absolute;display:block;width:2px;height:${leader.height}px;left:${leader.left}px;top:${leader.top}px;background:#6B7280"></span></span>`;
  };

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
        const anchor = map.lngLatToContainer(new AMap.LngLat(pos[0], pos[1]));
        const item = { s, pos, isTarget, isEnd, order: s.order, anchor };
        if (showLabel) candidates.push(item);
        else dotsOnly.push(item);
      }
    }
    candidates.sort(
      (a, b) =>
        (a.isTarget ? 0 : a.isEnd ? 1 : 2) - (b.isTarget ? 0 : b.isEnd ? 1 : 2) || a.order - b.order,
    );
    // 目标站圆点盒（障碍物）：目标站是「你在的站」，别的标签一旦盖住它，目标站
    // 圆点就看不见了，所以别的标签落点必须绕开它；目标站自己的标签盒从圆点边缘
    // 5px 外起，本来就不重叠，放进来也无妨。其余圆点不需要当障碍物：圆点层级
    // 200 低于一切标签（400/500），圆点盖不住任何标签文字；标签偶尔压住某个
    // 普通圆点只是该圆点被白底遮住，不影响站名可读。
    // （曾试过把全部圆点盒都当障碍物：站间距仅 12px，dy=0 的标签盒里总有圆点，
    // 全部标签被逼进上下错开带，9 个标签里 2–3 个 6 个落点全失败、退回只剩圆点，
    // 比现状更糟，已放弃。）
    let targetDotBox = null;
    const targetItem = candidates.find((c) => c.isTarget);
    if (targetItem) {
      const ta = targetItem.anchor;
      targetDotBox = { x0: ta.x - 10, x1: ta.x + 10, y0: ta.y - 10, y1: ta.y + 10 };
    }
    const keptBoxes = [];
    // 圆点与标签分开成两个标记。根因（终点站标签被盖）：以前圆点+标签在同一个
    // Marker 里、非目标站 zIndex 全是 200，标记按优先级顺序添加——后加的圆点
    // 标记（dotsOnly 在 candidates 之后、以及后加的邻站标签标记）会画在先加的
    // 终点站标签之上。分开后层级严格分层：圆点一律 200 < 标签 400（目标站 500），
    // 带文字的标签永远画在一切圆点之上，与添加顺序无关。anchor 显式写死
    // top-left（高德默认即 top-left）：内容左上角 = 经纬度点 + offset。
    const drawStation = (item, placement) => {
      const { s, pos, isTarget } = item;
      const dot = isTarget ? 16 : 10;
      const dotMarker = new AMap.Marker({
        position: pos,
        content: stationDotHtml(dot),
        offset: new AMap.Pixel(-dot / 2, -dot / 2),
        title: s.name,
        anchor: "top-left",
        zIndex: 200,
      });
      map.add(dotMarker);
      stationMarkers.push(dotMarker);
      if (!placement) return;
      const labelWidth = estimateLabelWidth(s.name);
      const cx = (placement.box.x0 + placement.box.x1) / 2;
      const cy = (placement.box.y0 + placement.box.y1) / 2;
      const lp = map.containerToLngLat(new AMap.Pixel(cx, cy));
      const labelMarker = new AMap.Marker({
        position: [lp.lng, lp.lat],
        content: stationLabelHtml(s.name, isTarget, leaderGeometry(placement, dot, labelWidth)),
        offset: new AMap.Pixel(-Math.round(labelWidth / 2), -LABEL_HALF_H),
        title: s.name,
        anchor: "top-left",
        zIndex: isTarget ? 500 : 400,
      });
      map.add(labelMarker);
      stationMarkers.push(labelMarker);
    };
    for (const item of candidates) {
      const { s, pos, isTarget, anchor } = item;
      const dot = isTarget ? 16 : 10;
      const labelWidth = estimateLabelWidth(s.name);
      // 标签优先、车辆让路：防撞看已保留的标签盒 + 目标站圆点盒，不再把车辆标记
      // 当障碍物；与标签重叠的车辆标记由 renderBusMarkers 跳过，标签本身永远保留。
      const placement = placeLabel(
        anchor,
        dot,
        labelWidth,
        targetDotBox ? [...keptBoxes, targetDotBox] : keptBoxes,
        container,
      );
      if (placement) keptBoxes.push(placement.box);
      drawStation(item, placement);
    }
    for (const item of dotsOnly) drawStation(item, null);
    labelBoxes = keptBoxes;
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

  /** 低缩放单辆车：10px 小绿点（站名优先，车辆细节放大再看） */
  function smallBusDotContent() {
    return `<div style="width:10px;height:10px;border-radius:50%;background:#0EA95B;border:1.5px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.3)"></div>`;
  }

  /** 低缩放簇徽章宽度估算（px）：🚌 约 10px + "×N" 约 7px/字 + 内边距 12px */
  function smallClusterWidth(n) {
    return 22 + 7 * String(n).length;
  }

  /** 低缩放簇徽章：小尺寸 🚌×N */
  function smallClusterContent(n) {
    return `<div style="display:flex;align-items:center;gap:1px;background:#0EA95B;color:#fff;border-radius:999px;padding:2px 6px;font-size:10px;font-weight:800;box-shadow:0 1px 4px rgba(0,0,0,.25);white-space:nowrap">🚌×${n}</div>`;
  }

  function addBusMarker(pos, content, offset = [-14, -13]) {
    const marker = new AMap.Marker({
      position: pos,
      content,
      offset: new AMap.Pixel(offset[0], offset[1]),
      // 车辆气泡层级低于站名标签（400/500），密集处不盖站名
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

  /** 把重合的几辆车环形散开显示（spiderfy），每辆带车牌尾号/时速以区分；
   * 撞上站名标签的 pill/锚点直接让路不画（标签优先） */
  function renderSpiderfied(center, items) {
    const ring = spiderPositions(center, items.length);
    const cc = map.lngLatToContainer(new AMap.LngLat(center[0], center[1]));
    if (!blockedByLabel(markerBox(cc, 12, 12, -6, -6))) addCenterDot(center);
    items.forEach((b, i) => {
      const c = map.lngLatToContainer(new AMap.LngLat(ring[i][0], ring[i][1]));
      if (!blockedByLabel(markerBox(c, 90, 28, -14, -13))) {
        addBusMarker(ring[i], busMarkerContent(b));
      }
    });
  }

  function renderBusMarkers() {
    removeMarkers(busMarkers);
    const zoom = map.getZoom();
    const detailed = zoom >= BUS_LABEL_ZOOM; // ≥14 逐辆显示时速 pill
    const toPx = (pos) => map.lngLatToContainer(new AMap.LngLat(pos[0], pos[1]));
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
          if (g.items.length === 1) {
            const c = toPx(g.pos);
            if (!blockedByLabel(markerBox(c, 90, 28, -14, -13))) {
              addBusMarker(g.pos, busMarkerContent(g.items[0]));
            }
          } else {
            renderSpiderfied(g.pos, g.items);
          }
        }
        continue;
      }
      // 低缩放（<14）：车辆只画小绿点 / 小徽章，站名优先，撞标签的车辆标记直接让路不画
      for (const c of clusterBuses(buses)) {
        const p = toPx([c.lng, c.lat]);
        if (c.items.length === 1) {
          if (!blockedByLabel(markerBox(p, 10, 10, -5, -5))) {
            addBusMarker([c.lng, c.lat], smallBusDotContent(), [-5, -5]);
          }
        } else {
          const key = `${c.lng.toFixed(5)},${c.lat.toFixed(5)}`;
          const coincident = sameSpot(c.items.map((b) => b.pos));
          if (coincident && expandedClusterKey === key) {
            // 已展开：环形散开显示各车（点中心绿点收起）
            renderSpiderfied([c.lng, c.lat], c.items);
          } else {
            const w = smallClusterWidth(c.items.length);
            if (!blockedByLabel(markerBox(p, w, 20, -Math.round(w / 2), -10))) {
              const marker = addBusMarker(
                [c.lng, c.lat],
                smallClusterContent(c.items.length),
                [-Math.round(w / 2), -10],
              );
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
