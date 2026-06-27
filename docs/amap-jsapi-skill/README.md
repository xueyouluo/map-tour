# AMap JSAPI Skill Reference

This project uses a compact reference extracted from `AMap-Web/amap-skills`
`amap-jsapi-skill` for implementation guidance. The upstream skill metadata
declares MIT license and covers AMap JSAPI v2.0 map initialization, security
configuration, POI search, markers, info windows, vector graphics, and route
planning.

Implementation notes used here:

- Load maps with `@amap/amap-jsapi-loader`, `version: "2.0"`.
- Configure `window._AMapSecurityConfig` before loading JSAPI.
- In production, use `serviceHost` to proxy REST calls and append
  `jscode` server-side instead of exposing `AMAP_SECURITY_JS_CODE`.
- Use `AMap.PlaceSearch` for POI candidates.
- Use `AMap.Driving` and `AMap.Walking` for route paths, then draw custom
  `AMap.Polyline` instances so routes can be saved and re-rendered.
- Use custom DOM `AMap.Marker` content for itinerary labels like `D1-1`.
