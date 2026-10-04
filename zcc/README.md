# PDF to ZCC

Converts a cut-layout PDF into a Zünd `.zcc` job.

    pip install -r requirements.txt
    python3 app.py                  # web UI at http://localhost:5000
    python3 pdf2zcc.py in.pdf -t reference.zcc -o out.zcc [--double-cut]

PDF layers `c`, `b`, `v`, `s` select the tool method; black circles on "Layer 1" are registration marks.
Material, tool settings and PrepareSteps are taken from the template (`reference.zcc`).
