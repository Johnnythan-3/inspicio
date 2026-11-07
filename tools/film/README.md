# Film data tools

`public/film-data.js` is generated from the rolls film engine (`../Archived/rolls`, Swift).
`public/film.js` is a JavaScript port of that engine; these tools rebuild the data and check
the port against the Swift original. None of this is served.

Regenerate and verify (Mac, Xcode command-line tools):

```bash
W=$(mktemp -d)
mkdir -p "$W/Sources/export"
cp -R "../Archived/rolls/Sources/RollsFilm" "$W/Sources/"
cp tools/film/Package.swift "$W/"
cp tools/film/export.swift "$W/Sources/export/main.swift"
DNG="../Archived/rolls/3 Sample photos/IMG_0855.DNG"   # any Apple ProRAW
(cd "$W" && swift build -c release && .build/release/export out "$OLDPWD/$DNG")
python3 tools/film/bake_js.py "$W/out" public/film-data.js
node tools/film/compare.js "$PWD/public" "$W/out"
node tools/film/compare-dng.js "$PWD/public" "$W/out" "$DNG"
```

`compare.js` should report negative densities within about 1e-6 of Swift (2.6e-3 worst on the
wide frame) and the matching print exposure K. Output differs by about 0.3 code values on
average (max about 3), from the 48^3 paper colour table.

`compare-dng.js` checks the DNG reader and the RAW develop against rolls' Darkroom on a real
ProRAW: decoded light within 1e-7, the camera matrix and K identical, output about 0.5 code
values on average (max 3).
