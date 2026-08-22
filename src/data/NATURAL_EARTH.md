# Natural Earth offline world dataset

MapMotion's production offline world map is compiled from the public-domain Natural Earth 1:50m vector collection. Runtime rendering uses only the generated `worldMap.ts` module and never contacts a network service.

## Sources

- `ne_50m_admin_0_countries.geojson` — countries and multilingual country labels, Natural Earth 5.1.1
- `ne_50m_admin_0_boundary_lines_land.geojson` — country borders, Natural Earth 5.1.0
- `ne_50m_coastline.geojson` — coastlines, Natural Earth 4.0.0
- `ne_50m_lakes.geojson` — lakes, Natural Earth 5.1.x
- `ne_50m_rivers_lake_centerlines_scale_rank.geojson` — ranked rivers and lake centerlines, Natural Earth 5.0.0
- `ne_50m_populated_places.geojson` — major cities and multilingual city labels, Natural Earth 5.1.2
- `ne_50m_geography_marine_polys.geojson` — oceans, seas, gulfs, and multilingual marine labels, Natural Earth 5.1.x

The generated dataset embeds SHA-256 values for every source file used. Source files are downloaded from revision `ca96624a56bd078437bca8184e78163e5039ad19` of the official [`nvkelso/natural-earth-vector`](https://github.com/nvkelso/natural-earth-vector) repository into the ignored `dist-portable/natural-earth-50m` build cache.

## License

Natural Earth raster and vector data is in the public domain. Multilingual names sourced by Natural Earth from Wikidata are CC0. See the [Natural Earth terms of use](https://www.naturalearthdata.com/about/terms-of-use/).

## Rebuilding

Run the following command. Missing source files are downloaded into the ignored build cache; subsequent builds use the local cache.

```powershell
npm run data:world
```

The compiler projects longitude/latitude into MapMotion's existing deterministic `1000 × 560` SVG scene, rounds coordinates to sub-pixel precision, combines physical linework by rendering class, ranks labels, and preserves legacy country identifiers as aliases for saved projects.

## Satellite limitation

Satellite mode is represented as an unavailable offline-raster capability. A production satellite basemap requires a separately licensed, versioned, size-bounded global imagery package and offline pyramid; Natural Earth does not supply satellite imagery. MapMotion does not silently substitute network tiles or a non-satellite texture.
