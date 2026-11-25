// GET /api/route?origin=&destination=&originLng=&originLat=&destLng=&destLat=&strategy=0
// 高德公交算路：端点有坐标直接用（快照坐标），没坐标先地理编码再算路。
import { json, onRequestOptions } from "./_cors.js";

export { onRequestOptions };

const STRATEGIES = new Set(["0", "2", "3", "5"]);

function parsePolyline(s) {
  if (typeof s !== "string" || !s) return [];
  return s
    .split(";")
    .map((p) => p.split(",").map(Number))
    .filter((p) => p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]));
}

async function geocode(key, address) {
  const q = new URLSearchParams({ address, city: "广州", key });
  const res = await fetch(`https://restapi.amap.com/v3/geocode/geo?${q}`);
  const data = await res.json().catch(() => ({}));
  if (data.status !== "1" || !data.geocodes?.length) {
    throw new Error(`找不到地点「${address}」`);
  }
  const g = data.geocodes[0];
  return { name: g.formatted_address || address, loc: g.location };
}

function parseTransit(data) {
  const transits = data?.route?.transits || [];
  return transits.map((t) => {
    const segments = [];
    for (const seg of t.segments || []) {
      const walk = seg.walking || {};
      if (walk && (Number(walk.distance) > 0 || walk.polyline)) {
        const steps = Array.isArray(walk.steps) ? walk.steps : [];
        const detail = steps.map((s) => s.instruction || "").filter(Boolean).join("；") || "步行";
        segments.push({
          kind: "walk",
          title: "步行",
          detail,
          distanceM: Number(walk.distance) || 0,
          durationSec: Number(walk.duration) || 0,
          polyline: parsePolyline(walk.polyline),
        });
      }
      const buslines = seg.bus?.buslines || [];
      for (const bl of buslines) {
        const name = bl.name || "";
        const isRail = /地铁|轻轨|城际|有轨电车/.test(name);
        const dep = bl.departure_stop?.name || "";
        const arr = bl.arrival_stop?.name || "";
        const stops = Array.isArray(bl.via_stops) ? bl.via_stops.length : 0;
        segments.push({
          kind: isRail ? "rail" : "bus",
          title: name,
          detail: dep && arr ? `${dep} 上车 → ${arr} 下车 · ${stops} 站` : name,
          distanceM: Number(bl.distance) || 0,
          durationSec: Number(bl.duration) || 0,
          polyline: parsePolyline(bl.polyline),
        });
      }
      const rail = seg.railway;
      if (rail) {
        const name = rail.name || "";
        const dep = rail.departure_stop?.name || "";
        const arr = rail.arrival_stop?.name || "";
        const stops = Array.isArray(rail.via_stops) ? rail.via_stops.length : 0;
        segments.push({
          kind: "rail",
          title: name,
          detail: dep && arr ? `${dep} 上车 → ${arr} 下车 · ${stops} 站` : name,
          distanceM: Number(rail.distance) || 0,
          durationSec: Number(rail.duration) || 0,
          polyline: parsePolyline(rail.polyline),
        });
      }
    }
    return {
      durationSec: Number(t.duration) || 0,
      costYuan: Number(t.cost) || 0,
      walkingM: Number(t.walking_distance) || 0,
      distanceM: Number(t.distance) || 0,
      segments,
    };
  });
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const origin = (url.searchParams.get("origin") || "").slice(0, 60);
  const destination = (url.searchParams.get("destination") || "").slice(0, 60);
  const strategy = url.searchParams.get("strategy") || "0";
  const originLng = url.searchParams.get("originLng") || "";
  const originLat = url.searchParams.get("originLat") || "";
  const destLng = url.searchParams.get("destLng") || "";
  const destLat = url.searchParams.get("destLat") || "";

  if (!origin || !destination) {
    return json({ error: "缺少起点或终点" }, 400);
  }
  if (!STRATEGIES.has(strategy)) {
    return json({ error: "不支持的策略" }, 400);
  }

  const key = env?.AMAP_WEB_KEY || "";
  if (!key) {
    return json(
      { error: "未配置高德 Web 服务 Key", hint: "需在 Cloudflare Pages 环境变量里设置 AMAP_WEB_KEY" },
      500,
    );
  }

  try {
    const originFromSnapshot = !!(originLng && originLat);
    const destFromSnapshot = !!(destLng && destLat);
    const o = originFromSnapshot
      ? { name: origin, loc: `${originLng},${originLat}` }
      : await geocode(key, origin);
    const d = destFromSnapshot
      ? { name: destination, loc: `${destLng},${destLat}` }
      : await geocode(key, destination);

    const q = new URLSearchParams({
      origin: o.loc,
      destination: d.loc,
      city: "广州",
      strategy,
      extensions: "all",
      key,
    });
    const res = await fetch(`https://restapi.amap.com/v3/direction/transit/integrated?${q}`);
    const data = await res.json().catch(() => ({}));
    if (data.status !== "1") {
      return json({ error: "高德算路失败", detail: data.info || "无可行方案" }, 502);
    }
    const plans = parseTransit(data);
    if (!plans.length) {
      return json({ error: "高德算路失败", detail: "无可行方案" }, 502);
    }
    return json({
      ok: true,
      originName: o.name,
      destName: d.name,
      originFromSnapshot,
      destFromSnapshot,
      plans,
    });
  } catch (error) {
    return json({ error: "路线规划失败", detail: String(error?.message || error) }, 502, {
      "Cache-Control": "no-store",
    });
  }
}
