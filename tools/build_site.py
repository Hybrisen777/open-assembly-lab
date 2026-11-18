"""Build the Open Assembly Lab site (this repository's root, served by GitHub Pages):

    python tools/build_site.py [WEBEXPORT_DIR]

WEBEXPORT_DIR is the web export of the Unity assembly pipeline (default C:/Projekty/IKEA_assembly_project/WebExport):
the three.js player modules, the WebXR layer (xr/) and one folder per exported product (scenario.json + model.glb +
manual pages). This script copies the player and ONLY the products listed in PRODUCTS below - kits whose model and
instructions are in the public domain - and gives the site its own name, colours and wording. Nothing else from the
export is shipped. Generated files are replaced on every build; .git, tools/, media/, README.md and .gitattributes stay.

Per product it also
  - renames the folder to a readable slug,
  - crops the header bar off the instruction pages (it carries agency / mission emblems, which are not ours to show)
    and renders the same pages again at twice the size for the enlarged page in VR (manual_hd/),
  - applies the product's display name, source and parts list.
The build fails if a replacement no longer matches the player code or if a third-party product name is left in a
shipped text file.
Needs Pillow and poppler (pdftoppm)."""
import hashlib, json, os, re, shutil, subprocess, sys, tempfile
from PIL import Image

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else r'C:\Projekty\IKEA_assembly_project\WebExport')
PROJECT = os.path.dirname(SRC)
SITE = 'Open Assembly Lab'
TAGLINE = 'Public-domain kits as step-by-step 3D assembly instructions - in the browser, and hands-on in VR and AR.'
DESCRIPTION = ('<meta name="description" content="Open Assembly Lab: public-domain kits as interactive 3D assembly '
               'instructions you can build with your hands in VR - in the browser, nothing to install.">')
KEEP = {'.git', 'tools', 'media', 'README.md', '.gitattributes'}
CODE = ['player.js', 'menu.js', 'settings.js', 'stage.js', 'bench.js']          # twins (twin.js, devices/) are not shipped

PRODUCTS = [{
    'src': 'NEWHORIZONS_NASA', 'slug': 'new-horizons',
    'name': 'New Horizons', 'card': 'New Horizons spacecraft model', 'id': 'NASA 3D Resources', 'category': '3D-printed models',
    'pdf': os.path.join('Reference', 'NEWHORIZONS_NASA', 'nasa_kit', 'assembly.pdf'),
    'pages': {'NEWHORIZONS_manual_p01.png': 1, 'NEWHORIZONS_manual_p02.png': 2, 'NEWHORIZONS_manual_p03.png': 3, 'NEWHORIZONS_manual_p04.png': 4},
    'partsSummary': '3D-printed: left body half, right body half, RTG, antenna.  From a hardware store: 5 dowels 1/4 x 1/2 inch, adhesive.',
    'introText': ('A 3D-printable model of the New Horizons spacecraft. The model files and the assembly instructions '
                  'are from NASA 3D Resources (New Horizons RP model instructions, 07-15-14); this is the 4-piece '
                  'version with the body printed in two halves. No tools. The finished model is about 17 x 14 x 11 cm. '
                  'This site is not affiliated with or endorsed by NASA.'),
}]

# ---- site identity: (old, new) in the player's .html / .js. Every pair must match at least once. ----
REPLACE = [
    ('IKEA Product Lab Player', SITE + ' Player'),
    ('IKEA Product Lab', SITE),
    ('<h1>Product Lab</h1>', f'<h1>{SITE}</h1>'),
    ('Step-by-step 3D assembly instructions and interactive digital twins of IKEA products.', TAGLINE),
    ('Search name, article number or category', 'Search name or category'),
    ("'ikea-lab-assembly'", "'open-lab-assembly'"),
    ('ikeaLab', 'openLab'),                                   # localStorage keys
    ('[IKEA Pipeline]', '[Pipeline]'),
    ("rendered from IKEA's PDFs", 'rendered from the PDFs'),
    ('Unpack and check all parts', 'Check all parts'),
    ("'<b>In the box:</b> '", "'<b>You need:</b> '"),
    ('`In the box: ${', '`You need: ${'),
    ("  ·  ${P(twin, 'digital twin', 'digital twins')}", ''),  # no twins on this site
    # colours: indigo / amber
    ('#0051a3', '#33408f'), ('#003d80', '#252f6b'), ('#0058a3', '#33408f'), ('#004a8a', '#252f6b'),
    ('#ffd91a', '#ffb547'), ('#ffdb00', '#ffb547'), ('#ffe659', '#ffca7a'), ('#e6bf0d', '#e79a2a'), ('#ffb800', '#f59e0b'),
    ('#d6e0f2', '#dfe2f5'), ('#c7dbf7', '#ccd2f2'), ('#dfe7f3', '#e3e6f6'),
    ('0xffd91a', '0xffb547'), ('0xffdb00', '0xffb547'),
    ('rgba(255,217,26,.75)', 'rgba(255,181,71,.85)'), ('rgba(0,82,163,.8)', 'rgba(51,64,143,.85)'),   # timeline
    # the instruction pages here are landscape slides: the page box follows the page instead of a tall portrait box
    ('#page img{display:block;height:min(58vh,620px);max-width:min(30vw,440px);object-fit:contain}',
     '#page img{display:block;width:min(38vw,520px);height:auto;max-height:58vh;object-fit:contain}'),
    ('#page img{height:34vh;max-width:40vw}', '#page img{width:46vw;height:auto;max-height:34vh}'),
]
# product names in code comments of the pipeline's other products
NAMES = ['STEFAN', 'KALLAX', 'ALEX', 'LACK', 'BILLY', 'MALM', 'PAX', 'BRIMNES', 'IVAR', 'ROSENTORP', 'STORKLINTA', 'TROTTEN',
         'STARKVIND', 'KNUVEBO', 'SMAKLIG', 'BLIXTSNABB', 'KALLBODA', 'TORSBODA', 'FINSMAKARE', 'KULINARISK', 'MATTRADITION', 'FORSAND']
NAME_RX = re.compile(r'\b(?:' + '|'.join(NAMES) + r')(?:_\d{8})?\b[ ]?')
FORBIDDEN = re.compile(r'ikea|\b(?:' + '|'.join(NAMES) + r')\b', re.I)

hits = {old: 0 for old, _ in REPLACE}
copied, problems = [], []


def rebrand(s):
    for old, new in REPLACE:
        n = s.count(old)
        if n: hits[old] += n; s = s.replace(old, new)
    return NAME_RX.sub('', s)


def text(rel, dst_rel=None):
    s = rebrand(open(os.path.join(SRC, rel), encoding='utf-8').read())
    if rel.endswith('.html') and DESCRIPTION not in s:
        s = s.replace('<meta charset="utf-8">', '<meta charset="utf-8">' + ('\n' if '\n<meta charset' in s else '') + DESCRIPTION, 1)
    dst = os.path.join(HERE, dst_rel or rel); os.makedirs(os.path.dirname(dst), exist_ok=True)
    with open(dst, 'w', encoding='utf-8', newline='\n') as f: f.write(s)
    copied.append(dst_rel or rel)


def binary(src, dst_rel):
    dst = os.path.join(HERE, dst_rel); os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copy2(src, dst); copied.append(dst_rel)


def header_rows(im):
    """Rows of the header bar: everything down to the red rule under the title (searched in the top quarter)."""
    rgb = im.convert('RGB'); w, h = rgb.size; px = rgb.load(); last = -1
    for y in range(h // 4):
        red = sum(1 for x in range(0, w, 4) if px[x, y][0] > 170 and px[x, y][1] < 90 and px[x, y][2] < 90)
        if red > w // 4 * 0.6: last = y
    if last < 0: raise SystemExit('header rule not found in a manual page - check the crop')
    return last + 2


def product(p):
    s, d = os.path.join(SRC, p['src']), p['slug']
    sc = json.load(open(os.path.join(s, 'scenario.json'), encoding='utf-8'))
    sc['format'] = 'open-lab-assembly'
    sc['product'].update(id=p['id'], name=p['name'], category=p['category'], introText=p['introText'], partsSummary=p['partsSummary'])
    sc.pop('source', None)
    dst = os.path.join(HERE, d); os.makedirs(dst, exist_ok=True)
    with open(os.path.join(dst, 'scenario.json'), 'w', encoding='utf-8', newline='\n') as f: json.dump(sc, f, separators=(',', ':'), ensure_ascii=False)
    copied.append(d + '/scenario.json')
    binary(os.path.join(s, sc.get('model', 'model.glb')), f"{d}/{sc.get('model', 'model.glb')}")
    binary(os.path.join(s, 'thumbnail.png'), d + '/thumbnail.png')
    hd = []
    with tempfile.TemporaryDirectory() as tmp:
        for pg in sc.get('manualPages', []):
            name = os.path.basename(pg['file'])
            im = Image.open(os.path.join(s, pg['file'])); top = header_rows(im); frac = top / im.height
            out = os.path.join(dst, pg['file']); os.makedirs(os.path.dirname(out), exist_ok=True)
            im.crop((0, top, im.width, im.height)).save(out, optimize=True); copied.append(f"{d}/{pg['file']}")
            if name in p['pages']:                                   # the same page at twice the width, same crop
                base = os.path.join(tmp, 'hd'); n = str(p['pages'][name])
                dpi = round(2 * im.width / (720 / 72))               # the PDF pages are 720 pt wide
                subprocess.run(['pdftoppm', '-f', n, '-l', n, '-r', str(dpi), '-png', '-singlefile', os.path.join(PROJECT, p['pdf']), base], check=True)
                big = Image.open(base + '.png'); out = os.path.join(dst, 'manual_hd', name); os.makedirs(os.path.dirname(out), exist_ok=True)
                big.crop((0, round(frac * big.height), big.width, big.height)).save(out, optimize=True); big.close()
                hd.append(name); copied.append(f'{d}/manual_hd/{name}')
    with open(os.path.join(dst, 'manual_hd', 'index.json'), 'w', encoding='utf-8', newline='\n') as f: json.dump(sorted(hd), f)
    copied.append(d + '/manual_hd/index.json')
    return {'folder': d, 'name': p.get('card', p['name']), 'id': p['id'], 'category': p['category'], 'mode': 'assembly', 'thumbnail': 'thumbnail.png', 'steps': len(sc['steps'])}


LOADER = """<script>
// build_site.py: load this build's modules only if this page is the current build. GitHub Pages lets browsers cache
// every file for 10 min, so after an update a cached player.html could otherwise run next to newer modules.
(function () {
  var V = '%V%', q = new URLSearchParams(location.search);
  function go() { window.SITE_VERSION = V; var s = document.createElement('script'); s.type = 'module'; s.src = 'player.js?v=' + V; document.body.appendChild(s); }
  fetch('version.json', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
    if (j.v !== V && q.get('_v') !== j.v) { q.set('_v', j.v); location.replace(location.pathname + '?' + q); }   // a fresh URL = a fresh page
    else go();
  }).catch(go);
})();
</script>"""


def version_build():
    """Content hash of the built files -> version.json, ?v= on every module import, the loader in player.html, bench.js."""
    h = hashlib.sha1()
    for rel in sorted(copied): h.update(rel.encode()); h.update(open(os.path.join(HERE, rel), 'rb').read())
    v = h.hexdigest()[:10]
    mod = re.compile(r"""(['"])(\.\.?/[\w\-/]+\.js)\1""")
    for rel in copied:
        if not rel.endswith('.js'): continue
        p = os.path.join(HERE, rel); s = open(p, encoding='utf-8').read()
        s2 = mod.sub(lambda m: f'{m.group(1)}{m.group(2)}?v={v}{m.group(1)}', s)
        if s2 != s:
            with open(p, 'w', encoding='utf-8', newline='\n') as o: o.write(s2)
    p = os.path.join(HERE, 'player.html'); s = open(p, encoding='utf-8').read()
    tag = '<script type="module" src="player.js"></script>'
    if tag not in s: sys.exit('player.html: module script tag not found - update tools/build_site.py')
    s = s.replace(tag, LOADER.replace('%V%', v)).replace('<script src="bench.js">', f'<script src="bench.js?v={v}">')
    with open(p, 'w', encoding='utf-8', newline='\n') as o: o.write(s)
    with open(os.path.join(HERE, 'version.json'), 'w', newline='\n') as o: json.dump({'v': v}, o)
    return v


def issues_url():
    try:
        cfg = open(os.path.join(HERE, '.git', 'config'), encoding='utf-8').read()
        m = re.search(r'\[remote "origin"\][^\[]*?url\s*=\s*(\S+)', cfg)
        if not m: return ''
        u = re.sub(r'^git@github\.com:', 'https://github.com/', m.group(1)).removesuffix('.git')
        return u + '/issues/new' if u.startswith('https://github.com/') else ''
    except OSError:
        return ''


def main():
    for e in os.listdir(HERE):                                  # fresh build; the repository's own files stay
        if e in KEEP: continue
        p = os.path.join(HERE, e); shutil.rmtree(p) if os.path.isdir(p) else os.remove(p)
    text('player.html'); text('index.html')
    for f in CODE: text(f)
    for r, ds, fs in os.walk(os.path.join(SRC, 'xr')):          # WebXR layer + its controller / hand models
        ds.sort()
        for f in sorted(fs):
            rel = os.path.relpath(os.path.join(r, f), SRC).replace(os.sep, '/')
            text(rel) if f.endswith('.js') else binary(os.path.join(r, f), rel)
    idx = {'products': [product(p) for p in PRODUCTS]}
    if issues_url(): idx['issuesUrl'] = issues_url()
    with open(os.path.join(HERE, 'index.json'), 'w', encoding='utf-8', newline='\n') as f: json.dump(idx, f, indent=2)
    copied.append('index.json')

    for old, n in hits.items():
        if not n: problems.append(f'replacement no longer matches the player code: {old!r}')
    for rel in copied:                                          # nothing of the pipeline's other products may be left
        if not rel.endswith(('.js', '.html', '.json', '.md')): continue
        for i, line in enumerate(open(os.path.join(HERE, rel), encoding='utf-8'), 1):
            m = FORBIDDEN.search(line)
            if m: problems.append(f'{rel}:{i}: "{m.group(0)}" in: {line.strip()[:110]}')
    v = version_build() if not problems else '-'
    with open(os.path.join(HERE, 'robots.txt'), 'w', newline='\n') as f: f.write('User-agent: *\nAllow: /\n')
    open(os.path.join(HERE, '.nojekyll'), 'w').close()          # serve the files as they are
    size = sum(os.path.getsize(os.path.join(HERE, rel)) for rel in copied)
    print(f'{HERE}: {len(copied)} files, {size / 1048576:.1f} MB, {len(idx["products"])} product(s), version {v}, reports -> {idx.get("issuesUrl", "download only")}')
    if problems:
        print('PROBLEMS:'); [print('  ' + p) for p in problems]
        sys.exit(1)


if __name__ == '__main__':
    main()
