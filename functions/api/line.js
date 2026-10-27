// GET /api/line?lineId=&dir=1&cityId=040&stationId=&lat=&lng=
// 单条线路：沿途站点 + 车辆位置。
import { fetchLine } from "../_lib/chelaile.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
};

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS, ...extra },
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const lineId = (url.searchParams.get("lineId") || "").slice(0, 64);
  const dir = (url.searchParams.get("dir") || "1").slice(0, 2);
  const cityId = (url.searchParams.get("cityId") || "040").slice(0, 8);
  const stationId = (url.searchParams.get("stationId") || "").slice(0, 64);
  const lat = (url.searchParams.get("lat") || "").slice(0, 24);
  const lng = (url.searchParams.get("lng") || "").slice(0, 24);

  if (!lineId) {
    return json({ error: "缺少 lineId", hint: "从站点线路里带过来" }, 400);
  }

  try {
    const data = await fetchLine({ cityId, lineId, dir, stationId, lat, lng });
    return json(data, 200, { "Cache-Control": "public, max-age=10, s-maxage=10" });
  } catch (error) {
    return json({ error: "线路查询失败", detail: String(error?.message || error) }, 502, {
      "Cache-Control": "no-store",
    });
  }
}
