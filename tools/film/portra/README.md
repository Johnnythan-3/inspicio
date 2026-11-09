# Portra 400 calibration

`PORTRA_FIT` in `public/film.js` nudges rolls' film colour toward real Portra 400. Here are the
measurements it was fitted to and the script that fits and checks it.

`scans.json` holds ColorChecker patch values (CIELAB D65) read from five public photos of a chart
shot on Portra 400 and scanned by their authors:

- Brian Copeland, dimitri.sorel, Sam Agnew: one frame each, at box speed.
- Tim Gray: his -3 and -2.5 EV frames. Brighter frames clip in his scans.

Each scan was evened out on neutral 5 (a gain per channel, so it is neutral), and patches the
scan clipped are listed in `clipped`. The photos themselves stay with their owners (links in the
file); only these patch averages are kept.

```bash
node tools/film/portra/fit.js check        # shipped engine vs the scans
node tools/film/portra/fit.js raw [reg]    # refit the ProRAW matrix
node tools/film/portra/fit.js photo [reg]  # refit the finished-photo matrix
```

In November 2026, with `reg` 8:

| | rolls as baked | calibrated |
|---|---|---|
| ProRAW: mean CIEDE2000 to the scans | 10.1 | 7.45 |
| ProRAW: colour vs the film | 1.37x | 1.01x |
| Finished photo: mean CIEDE2000 | 7.6 | 7.2 |

The scans differ from each other by about 7, so the fit is about as close as the data allows.
What a 3x3 cannot fix stays: purple and red still print a little dark on ProRAW, and bluish
green leans about 15 degrees toward blue.
