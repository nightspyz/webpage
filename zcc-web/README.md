# PDF to ZCC (browser version)

Open `index.html` in a browser (works straight from disk, no server or install), pick a PDF and download the `.zcc`.
Everything runs locally; the PDF is not uploaded.

- `index.html`: web interface
- `pdf2zcc.js`: converter (also usable from Node: `require('./pdf2zcc.js')`)
- `template.js`: bundled job template (copy of `../zcc/reference.zcc`); you can supply your own `.zcc` in the page
- `lib/`: PDF.js 3.11.174 (Apache-2.0), bundled so no network is needed

PDF layers `c`, `b`, `v`, `s` select the tool method (stroke colour `#ee1c24`/`#00a651`/`#2e3192`/`#bf1e2e` is the fallback);
dark filled circles are registration marks. Only page 1 is converted. Curves are flattened to 16 segments.
