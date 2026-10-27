// GET /api/station?physicalStId=&sId=&namesakeStId=&firstLineId=&cityId=040&lat=&lng=
// 单个站点的全部线路与到站时间。
import { fetchStation } from "../_lib/chelaile.js";

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
  const physicalStId = (url.searchParams.get("physicalStId") || "").slice(0, 64);
  const sId = (url.searchParams.get("sId") || "").slice(0, 64);
  const namesakeStId = (url.searchParams.get("namesakeStId") || "").slice(0, 64);
  const firstLineId = (url.searchParams.get("firstLineId") || "").slice(0, 64);
  const cityId = (url.searchParams.get("cityId") || "040").slice(0, 8);
  const lat = (url.searchParams.get("lat") || "").slice(0, 24);
  const lng = (url.searchParams.get("lng") || "").slice(0, 24);

  if (!physicalStId) {
    return json({ error: "缺少 physicalStId", hint: "从附近站点列表里带过来" }, 400);
  }

  try {
    const data = await fetchStation({ cityId, physicalStId, sId, namesakeStId, firstLineId, lat, lng });
    return json(data, 200, { "Cache-Control": "public, max-age=10, s-maxage=10" });
  } catch (error) {
    return json({ error: "站点查询失败", detail: String(error?.message || error) }, 502, {
      "Cache-Control": "no-store",
    });
  }
}
