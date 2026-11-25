// GET /api/cities
// 全城列表（493 城），供首页城市切换用；上游城市表极少变，缓存一天。
import { json, onRequestOptions } from "./_cors.js";
import { fetchCities } from "../_lib/chelaile.js";

export { onRequestOptions };

export async function onRequestGet() {
  try {
    const data = await fetchCities();
    return json(data, 200, { "Cache-Control": "public, max-age=86400, s-maxage=86400" });
  } catch (error) {
    return json(
      { error: "上游查询失败", detail: String(error?.message || error) },
      502,
      { "Cache-Control": "no-store" },
    );
  }
}
