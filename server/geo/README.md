# Service coverage geometry

Source: Alibaba Cloud DataV GeoAtlas province GeoJSON, fetched 2026-11-01.

- [Official DataV documentation](https://help.aliyun.com/zh/datav/datav-6-0/user-guide/choropleth-layer-1)
- [Source GeoJSON](https://geo.datav.aliyun.com/areas_v3/bound/100000_full.json)
- Source SHA-256: `99adfeded5223848bbe37a0a12f8023e11ee12161c7800521c27db42fdeac275`

`china-provinces.json` retains the 34 province-level administrative features, their names/codes and Polygon/MultiPolygon geometry. The non-administrative dashed-line feature is omitted. HK/MO/TW geometries are retained solely to reject those areas before accepting a mainland polygon. No polygons are sent to the browser or drawn on the product map.

This is a bundled, approximate business coverage check aligned with the app's AMap coordinate data; it is not a navigation or surveying boundary service. Near a simplified boundary a point may require correction. It makes no external API requests. Bounding boxes accelerate rejection; point-in-polygon checks make the actual decision.

To update, download the source, inspect its administrative features and change the documented date/hash; rerun mainland/excluded point, coastal ferry and API bypass regression tests. Do not replace geometry with a broad China bounding rectangle.
