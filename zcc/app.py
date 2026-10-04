#!/usr/bin/env python3
"""Web interface for pdf2zcc: upload a PDF, download a .zcc job.

Run:  python3 app.py   then open http://localhost:5000
"""
import os, tempfile
from flask import Flask, request, send_file, render_template_string, abort
import pdf2zcc

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_TEMPLATE = os.path.join(HERE, "reference.zcc")
app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 64 * 1024 * 1024

PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PDF to ZCC</title>
<style>
 body{font-family:system-ui,sans-serif;max-width:560px;margin:40px auto;padding:0 16px;color:#222}
 h1{font-size:1.4rem}
 #drop{border:2px dashed #888;border-radius:8px;padding:32px;text-align:center;cursor:pointer}
 #drop.over{background:#eef5ff;border-color:#2a6fdb}
 label.opt{display:block;margin:12px 0}
 button{padding:10px 18px;font-size:1rem;cursor:pointer}
 .err{background:#fde8e8;border:1px solid #e0a0a0;padding:10px;border-radius:6px}
 .ok{background:#e8f6ec;border:1px solid #9fd0ac;padding:10px;border-radius:6px}
 small{color:#666}
</style></head><body>
<h1>PDF to ZCC converter</h1>
{% if error %}<p class="err">{{ error }}</p>{% endif %}
<form method="post" action="/convert" enctype="multipart/form-data">
 <div id="drop">Drop a PDF here or click to choose<br><small id="fname"></small>
  <input id="file" type="file" name="pdf" accept="application/pdf,.pdf" required hidden></div>
 <label class="opt"><input type="checkbox" name="double_cut"> Add a second thru-cut pass (method <code>c_2</code>)</label>
 <label class="opt">Template .zcc (optional, default: bundled reference job)<br>
  <input type="file" name="template" accept=".zcc,.xml"></label>
 <button type="submit">Convert and download .zcc</button>
</form>
<p><small>Layers <code>c</code>, <code>b</code>, <code>v</code>, <code>s</code> in the PDF select the tool method; black circles on "Layer 1" become registration marks. Tool settings, material and PrepareSteps come from the template.</small></p>
<script>
 const d=document.getElementById('drop'),f=document.getElementById('file'),n=document.getElementById('fname');
 d.onclick=()=>f.click();
 f.onchange=()=>n.textContent=f.files[0]?f.files[0].name:'';
 d.ondragover=e=>{e.preventDefault();d.classList.add('over')};
 d.ondragleave=()=>d.classList.remove('over');
 d.ondrop=e=>{e.preventDefault();d.classList.remove('over');f.files=e.dataTransfer.files;f.onchange()};
</script></body></html>"""


@app.get("/")
def index():
    return render_template_string(PAGE, error=None)


@app.post("/convert")
def convert():
    up = request.files.get("pdf")
    if not up or not up.filename.lower().endswith(".pdf"):
        return render_template_string(PAGE, error="Please choose a PDF file."), 400
    tpl_file = request.files.get("template")
    try:
        template = (tpl_file.read().decode("utf-8") if tpl_file and tpl_file.filename
                    else open(DEFAULT_TEMPLATE, encoding="utf-8").read())
        if "<Geometry>" not in template:
            raise ValueError("template has no <Geometry> block")
        with tempfile.TemporaryDirectory() as td:
            path = os.path.join(td, "in.pdf")
            up.save(path)
            out_name = os.path.splitext(os.path.basename(up.filename))[0] + ".pdf.zcc"
            txt, regs, outl, warn = pdf2zcc.build(template, path, "double_cut" in request.form, out_name)
        if not regs:
            raise ValueError("no registration marks (black circles) found in the PDF")
        if not outl:
            raise ValueError("no cut paths found in the PDF")
    except Exception as e:
        return render_template_string(PAGE, error=f"Conversion failed: {e}"), 422
    out = os.path.join(tempfile.gettempdir(), "pdf2zcc_" + os.urandom(6).hex() + ".zcc")
    with open(out, "w", encoding="utf-8") as fh:
        fh.write(txt)
    resp = send_file(out, as_attachment=True, download_name=out_name, mimetype="application/xml")
    resp.call_on_close(lambda: os.path.exists(out) and os.remove(out))
    if warn:
        resp.headers["X-Warnings"] = "; ".join(warn)[:500]
    return resp


if __name__ == "__main__":
    app.run(host=os.environ.get("HOST", "127.0.0.1"), port=int(os.environ.get("PORT", 5000)))
