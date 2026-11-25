// GET /api/search?cityId=040&q=B20
// 全城关键字搜索：线路 + 站点（首页搜索的后备，附近搜不到时用）。
// 签名与解析都在这里完成，浏览器只拿到精简后的结果。
import { fetchSearch } from "../_lib/chelaile.js";

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
  const q = (url.searchParams.get("q") || "").trim().slice(0, 30);
  const cityId = (url.searchParams.get("cityId") || "040").slice(0, 8);

  if (!q) {
    return json({ error: "缺少 q", hint: "需要 q 关键字参数" }, 400);
  }

  try {
    const data = await fetchSearch({ cityId, q });
    return json(data, 200, { "Cache-Control": "public, max-age=60, s-maxage=60" });
  } catch (error) {
    return json(
      { error: "上游查询失败", detail: String(error?.message || error) },
      502,
      { "Cache-Control": "no-store" },
    );
  }
}
