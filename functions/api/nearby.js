// GET /api/nearby?lat=&lng=&cityId=040&limit=8
// 签名与解密都在这里完成，浏览器只拿到精简后的到站数据。
import { fetchNearby } from "../_lib/chelaile.js";

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
  const latRaw = url.searchParams.get("lat");
  const lngRaw = url.searchParams.get("lng");
  const lat = Number(latRaw);
  const lng = Number(lngRaw);
  const cityId = (url.searchParams.get("cityId") || "040").slice(0, 8);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 8, 1), 12);

  if (
    !latRaw || !lngRaw ||
    !Number.isFinite(lat) || !Number.isFinite(lng) ||
    Math.abs(lat) > 90 || Math.abs(lng) > 180 ||
    (lat === 0 && lng === 0)
  ) {
    return json({ error: "坐标无效", hint: "需要 lat / lng 两个数值参数" }, 400);
  }

  try {
    const data = await fetchNearby({ cityId, lat, lng, limit });
    if (!data.stations.length) {
      return json({ ...data, empty: true, message: "附近没有查到线路，换个位置试试" }, 200, {
        "Cache-Control": "no-store",
      });
    }
    return json(data, 200, { "Cache-Control": "public, max-age=15, s-maxage=15" });
  } catch (error) {
    return json(
      { error: "上游查询失败", detail: String(error?.message || error) },
      502,
      { "Cache-Control": "no-store" },
    );
  }
}
