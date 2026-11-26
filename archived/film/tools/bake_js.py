import json, base64, sys
out_dir, dest = sys.argv[1], sys.argv[2]
d = json.load(open(f"{out_dir}/film.json"))
def rnd(v):
    if isinstance(v, float): return float(f"{v:.6g}")
    if isinstance(v, list): return [rnd(x) for x in v]
    if isinstance(v, dict): return {k: rnd(x) for k, x in v.items()}
    return v
d = rnd(d)
d["lutB64"] = base64.b64encode(open(f"{out_dir}/print-lut.u16", "rb").read()).decode()
body = json.dumps(d, separators=(",", ":"), sort_keys=True)
with open(dest, "w") as f:
    f.write("/* Kodak Portra 400 on Endura Premier, Noritsu print: measured data baked from the rolls\n"
            "   film engine (curves traced from Kodak E-4050 and E-4070, the film's colour matrix, and the\n"
            "   paper's colour table as 48^3 16-bit values). Generated; do not edit by hand. */\n")
    f.write("self.FILM_DATA = " + body + ";\n")
print(len(body))
