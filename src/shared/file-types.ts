// What kind of file a name looks like: its icon, Shiki language and label. A hint for the tree,
// the viewer and the file-type counts; main decides text, image or binary from the bytes.
// Matching follows VS Code's icon themes: an exact name beats a pattern, a pattern beats a
// compound extension (.d.ts), that beats the last extension. Names match in any case.

export type FileIcon =
  | 'code'
  | 'test'
  | 'json'
  | 'data'
  | 'config'
  | 'lock'
  | 'key'
  | 'script'
  | 'container'
  | 'doc'
  | 'license'
  | 'changelog'
  | 'owners'
  | 'patch'
  | 'sheet'
  | 'database'
  | 'image'
  | 'video'
  | 'audio'
  | 'archive'
  | 'font'
  | 'binary'
  | 'file';

export type FolderIcon =
  | 'folder'
  | 'src'
  | 'tests'
  | 'settings'
  | 'git'
  | 'deps';

export type FileType = { icon: FileIcon; lang: string | null; label: string };

// Shiki's own display names for the languages mapped below, a few reworded to read better.
export const LANGUAGE_LABELS: Record<string, string> = {
  typescript: 'TypeScript',
  tsx: 'TSX',
  javascript: 'JavaScript',
  jsx: 'JSX',
  json: 'JSON',
  jsonc: 'JSON with Comments',
  json5: 'JSON5',
  jsonl: 'JSON Lines',
  css: 'CSS',
  scss: 'SCSS',
  sass: 'Sass',
  less: 'Less',
  stylus: 'Stylus',
  html: 'HTML',
  vue: 'Vue',
  svelte: 'Svelte',
  astro: 'Astro',
  markdown: 'Markdown',
  mdx: 'MDX',
  yaml: 'YAML',
  toml: 'TOML',
  ini: 'INI',
  xml: 'XML',
  xsl: 'XSL',
  python: 'Python',
  ruby: 'Ruby',
  erb: 'ERB',
  go: 'Go',
  rust: 'Rust',
  java: 'Java',
  kotlin: 'Kotlin',
  scala: 'Scala',
  groovy: 'Groovy',
  swift: 'Swift',
  c: 'C',
  cpp: 'C++',
  csharp: 'C#',
  fsharp: 'F#',
  vb: 'Visual Basic',
  php: 'PHP',
  shellscript: 'Shell',
  fish: 'Fish',
  powershell: 'PowerShell',
  bat: 'Batch File',
  nushell: 'Nushell',
  sql: 'SQL',
  lua: 'Lua',
  dart: 'Dart',
  r: 'R',
  julia: 'Julia',
  perl: 'Perl',
  elixir: 'Elixir',
  erlang: 'Erlang',
  haskell: 'Haskell',
  clojure: 'Clojure',
  ocaml: 'OCaml',
  elm: 'Elm',
  nim: 'Nim',
  zig: 'Zig',
  'system-verilog': 'SystemVerilog',
  vhdl: 'VHDL',
  asm: 'Assembly',
  graphql: 'GraphQL',
  proto: 'Protocol Buffers',
  prisma: 'Prisma',
  terraform: 'Terraform',
  hcl: 'HashiCorp HCL',
  nix: 'Nix',
  docker: 'Dockerfile',
  cmake: 'CMake',
  make: 'Makefile',
  diff: 'Diff',
  csv: 'CSV',
  tsv: 'TSV',
  latex: 'LaTeX',
  bibtex: 'BibTeX',
  rst: 'reStructuredText',
  asciidoc: 'AsciiDoc',
  org: 'Org',
  typst: 'Typst',
  solidity: 'Solidity',
  wgsl: 'WGSL',
  glsl: 'GLSL',
  hlsl: 'HLSL',
  viml: 'Vim Script',
  'common-lisp': 'Common Lisp',
  'emacs-lisp': 'Emacs Lisp',
  racket: 'Racket',
  scheme: 'Scheme',
  coffee: 'CoffeeScript',
  pug: 'Pug',
  handlebars: 'Handlebars',
  twig: 'Twig',
  liquid: 'Liquid',
  jinja: 'Jinja',
  razor: 'Razor',
  tcl: 'Tcl',
  crystal: 'Crystal',
  d: 'D',
  pascal: 'Pascal',
  'fortran-free-form': 'Fortran',
  'fortran-fixed-form': 'Fortran',
  cobol: 'COBOL',
  mojo: 'Mojo',
  gleam: 'Gleam',
  odin: 'Odin',
  'objective-c': 'Objective-C',
  'objective-cpp': 'Objective-C++',
  kdl: 'KDL',
  ron: 'RON',
  http: 'HTTP',
  log: 'Log',
  dotenv: 'Env file',
  just: 'Just',
  codeowners: 'CODEOWNERS',
  nginx: 'Nginx',
};

export type Rule = { icon: FileIcon; lang?: string; label?: string };

const code = (lang: string): Rule => ({ icon: 'code', lang });
const as = (icon: FileIcon, lang?: string, label?: string): Rule => ({
  icon,
  lang,
  label,
});

export const BY_EXTENSION: Record<string, Rule> = {
  ts: code('typescript'),
  mts: code('typescript'),
  cts: code('typescript'),
  tsx: code('tsx'),
  js: code('javascript'),
  mjs: code('javascript'),
  cjs: code('javascript'),
  jsx: code('jsx'),
  css: code('css'),
  scss: code('scss'),
  sass: code('sass'),
  less: code('less'),
  styl: code('stylus'),
  html: code('html'),
  htm: code('html'),
  xhtml: code('html'),
  vue: code('vue'),
  svelte: code('svelte'),
  astro: code('astro'),
  py: code('python'),
  pyi: code('python'),
  pyw: code('python'),
  rb: code('ruby'),
  erb: code('erb'),
  go: code('go'),
  rs: code('rust'),
  java: code('java'),
  kt: code('kotlin'),
  kts: code('kotlin'),
  scala: code('scala'),
  sc: code('scala'),
  groovy: code('groovy'),
  gradle: code('groovy'),
  swift: code('swift'),
  c: code('c'),
  h: code('c'),
  cpp: code('cpp'),
  cc: code('cpp'),
  cxx: code('cpp'),
  'c++': code('cpp'),
  hpp: code('cpp'),
  hh: code('cpp'),
  hxx: code('cpp'),
  ino: code('cpp'),
  cs: code('csharp'),
  csx: code('csharp'),
  fs: code('fsharp'),
  fsx: code('fsharp'),
  fsi: code('fsharp'),
  vb: code('vb'),
  php: code('php'),
  sql: code('sql'),
  lua: code('lua'),
  dart: code('dart'),
  r: code('r'),
  jl: code('julia'),
  pl: code('perl'),
  pm: code('perl'),
  ex: code('elixir'),
  exs: code('elixir'),
  erl: code('erlang'),
  hrl: code('erlang'),
  hs: code('haskell'),
  clj: code('clojure'),
  cljs: code('clojure'),
  edn: code('clojure'),
  ml: code('ocaml'),
  mli: code('ocaml'),
  elm: code('elm'),
  nim: code('nim'),
  zig: code('zig'),
  sv: code('system-verilog'),
  svh: code('system-verilog'),
  vhd: code('vhdl'),
  vhdl: code('vhdl'),
  asm: code('asm'),
  s: code('asm'),
  graphql: code('graphql'),
  gql: code('graphql'),
  proto: code('proto'),
  prisma: code('prisma'),
  nix: code('nix'),
  cmake: code('cmake'),
  mk: code('make'),
  sol: code('solidity'),
  wgsl: code('wgsl'),
  glsl: code('glsl'),
  vert: code('glsl'),
  frag: code('glsl'),
  hlsl: code('hlsl'),
  vim: code('viml'),
  lisp: code('common-lisp'),
  el: code('emacs-lisp'),
  rkt: code('racket'),
  scm: code('scheme'),
  coffee: code('coffee'),
  pug: code('pug'),
  hbs: code('handlebars'),
  handlebars: code('handlebars'),
  twig: code('twig'),
  liquid: code('liquid'),
  njk: code('jinja'),
  j2: code('jinja'),
  jinja: code('jinja'),
  cshtml: code('razor'),
  razor: code('razor'),
  tcl: code('tcl'),
  cr: code('crystal'),
  d: code('d'),
  pas: code('pascal'),
  f90: code('fortran-free-form'),
  f95: code('fortran-free-form'),
  f03: code('fortran-free-form'),
  f: code('fortran-fixed-form'),
  for: code('fortran-fixed-form'),
  cob: code('cobol'),
  cbl: code('cobol'),
  mojo: code('mojo'),
  gleam: code('gleam'),
  odin: code('odin'),
  m: code('objective-c'),
  mm: code('objective-cpp'),
  http: code('http'),
  kdl: code('kdl'),
  ron: code('ron'),

  json: as('json', 'json'),
  jsonc: as('json', 'jsonc'),
  json5: as('json', 'json5'),
  jsonl: as('json', 'jsonl'),
  ndjson: as('json', 'jsonl'),
  'code-workspace': as('json', 'jsonc'),

  yml: as('data', 'yaml'),
  yaml: as('data', 'yaml'),
  toml: as('data', 'toml'),
  ini: as('data', 'ini'),
  cfg: as('data', 'ini'),
  conf: as('data', 'ini'),
  properties: as('data', 'ini'),
  xml: as('data', 'xml'),
  xsd: as('data', 'xml'),
  xsl: as('data', 'xsl'),
  xslt: as('data', 'xsl'),
  plist: as('data', 'xml'),
  hcl: as('data', 'hcl'),
  tf: as('data', 'terraform'),
  tfvars: as('data', 'terraform'),

  lock: as('lock', undefined, 'Lockfile'),

  pem: as('key', undefined, 'Key or certificate'),
  key: as('key', undefined, 'Key or certificate'),
  crt: as('key', undefined, 'Key or certificate'),
  cer: as('key', undefined, 'Key or certificate'),
  pub: as('key', undefined, 'Key or certificate'),
  asc: as('key', undefined, 'Key or certificate'),
  gpg: as('key', undefined, 'Key or certificate'),
  p12: as('key', undefined, 'Key or certificate'),
  pfx: as('key', undefined, 'Key or certificate'),
  env: as('key', 'dotenv'),

  sh: as('script', 'shellscript'),
  bash: as('script', 'shellscript'),
  zsh: as('script', 'shellscript'),
  ksh: as('script', 'shellscript'),
  fish: as('script', 'fish'),
  ps1: as('script', 'powershell'),
  psm1: as('script', 'powershell'),
  psd1: as('script', 'powershell'),
  bat: as('script', 'bat'),
  cmd: as('script', 'bat'),
  nu: as('script', 'nushell'),

  dockerfile: as('container', 'docker'),
  containerfile: as('container', 'docker'),

  md: as('doc', 'markdown'),
  markdown: as('doc', 'markdown'),
  mdx: as('doc', 'mdx'),
  txt: as('doc', undefined, 'Plain text'),
  text: as('doc', undefined, 'Plain text'),
  rst: as('doc', 'rst'),
  adoc: as('doc', 'asciidoc'),
  asciidoc: as('doc', 'asciidoc'),
  org: as('doc', 'org'),
  tex: as('doc', 'latex'),
  bib: as('doc', 'bibtex'),
  typ: as('doc', 'typst'),
  log: as('doc', 'log'),
  pdf: as('doc', undefined, 'PDF'),
  doc: as('doc', undefined, 'Word document'),
  docx: as('doc', undefined, 'Word document'),
  odt: as('doc', undefined, 'Document'),
  rtf: as('doc', undefined, 'Rich text'),

  patch: as('patch', 'diff'),
  diff: as('patch', 'diff'),

  csv: as('sheet', 'csv'),
  tsv: as('sheet', 'tsv'),
  xls: as('sheet', undefined, 'Spreadsheet'),
  xlsx: as('sheet', undefined, 'Spreadsheet'),
  ods: as('sheet', undefined, 'Spreadsheet'),

  sqlite: as('database', undefined, 'Database'),
  sqlite3: as('database', undefined, 'Database'),
  db: as('database', undefined, 'Database'),
  mdb: as('database', undefined, 'Database'),
  parquet: as('database', undefined, 'Database'),

  png: as('image', undefined, 'PNG image'),
  jpg: as('image', undefined, 'JPEG image'),
  jpeg: as('image', undefined, 'JPEG image'),
  gif: as('image', undefined, 'GIF image'),
  webp: as('image', undefined, 'WebP image'),
  avif: as('image', undefined, 'AVIF image'),
  bmp: as('image', undefined, 'Bitmap image'),
  ico: as('image', undefined, 'Icon'),
  icns: as('image', undefined, 'Icon'),
  tif: as('image', undefined, 'TIFF image'),
  tiff: as('image', undefined, 'TIFF image'),
  heic: as('image', undefined, 'HEIC image'),
  svg: as('image', 'xml', 'SVG image'),

  mp4: as('video', undefined, 'Video'),
  webm: as('video', undefined, 'Video'),
  mov: as('video', undefined, 'Video'),
  mkv: as('video', undefined, 'Video'),
  avi: as('video', undefined, 'Video'),
  m4v: as('video', undefined, 'Video'),

  mp3: as('audio', undefined, 'Audio'),
  wav: as('audio', undefined, 'Audio'),
  ogg: as('audio', undefined, 'Audio'),
  flac: as('audio', undefined, 'Audio'),
  m4a: as('audio', undefined, 'Audio'),
  aac: as('audio', undefined, 'Audio'),
  opus: as('audio', undefined, 'Audio'),

  zip: as('archive', undefined, 'Archive'),
  tar: as('archive', undefined, 'Archive'),
  gz: as('archive', undefined, 'Archive'),
  tgz: as('archive', undefined, 'Archive'),
  bz2: as('archive', undefined, 'Archive'),
  xz: as('archive', undefined, 'Archive'),
  '7z': as('archive', undefined, 'Archive'),
  rar: as('archive', undefined, 'Archive'),
  zst: as('archive', undefined, 'Archive'),
  jar: as('archive', undefined, 'Archive'),
  war: as('archive', undefined, 'Archive'),
  deb: as('archive', undefined, 'Archive'),
  rpm: as('archive', undefined, 'Archive'),

  woff: as('font', undefined, 'Font'),
  woff2: as('font', undefined, 'Font'),
  ttf: as('font', undefined, 'Font'),
  otf: as('font', undefined, 'Font'),
  eot: as('font', undefined, 'Font'),

  exe: as('binary', undefined, 'Program'),
  msi: as('binary', undefined, 'Installer'),
  dll: as('binary', undefined, 'Library'),
  so: as('binary', undefined, 'Library'),
  dylib: as('binary', undefined, 'Library'),
  bin: as('binary', undefined, 'Binary'),
  wasm: as('binary', undefined, 'WebAssembly'),
  o: as('binary', undefined, 'Object file'),
  a: as('binary', undefined, 'Library'),
  class: as('binary', undefined, 'Java class'),
  pyc: as('binary', undefined, 'Python bytecode'),
};

export const BY_NAME: Record<string, Rule> = {
  dockerfile: as('container', 'docker'),
  containerfile: as('container', 'docker'),
  makefile: as('config', 'make'),
  gnumakefile: as('config', 'make'),
  justfile: as('config', 'just'),
  'cmakelists.txt': as('config', 'cmake'),
  gemfile: code('ruby'),
  rakefile: code('ruby'),
  podfile: code('ruby'),
  vagrantfile: code('ruby'),
  brewfile: code('ruby'),
  jenkinsfile: code('groovy'),
  pipfile: as('data', 'toml'),
  'nginx.conf': as('config', 'nginx'),
  '.editorconfig': as('config', 'ini'),
  '.gitignore': as('config', undefined, 'Git ignore rules'),
  '.gitattributes': as('config', undefined, 'Git attributes'),
  '.gitmodules': as('config', 'ini'),
  '.gitkeep': as('config', undefined, 'Plain text'),
  '.git-blame-ignore-revs': as('config', undefined, 'Plain text'),
  '.npmrc': as('config', 'ini'),
  '.yarnrc': as('config', 'ini'),
  '.npmignore': as('config', undefined, 'Ignore rules'),
  '.dockerignore': as('config', undefined, 'Ignore rules'),
  '.prettierignore': as('config', undefined, 'Ignore rules'),
  '.eslintignore': as('config', undefined, 'Ignore rules'),
  '.nvmrc': as('config', undefined, 'Plain text'),
  '.node-version': as('config', undefined, 'Plain text'),
  '.babelrc': as('config', 'json'),
  '.prettierrc': as('config', 'json'),
  '.eslintrc': as('config', 'json'),
  '.oxlintrc.json': as('config', 'jsonc'),
  '.oxfmtrc.json': as('config', 'jsonc'),
  'wrangler.json': as('config', 'jsonc'),
  'wrangler.jsonc': as('config', 'jsonc'),
  'wrangler.toml': as('config', 'toml'),
  '.bashrc': as('script', 'shellscript'),
  '.bash_profile': as('script', 'shellscript'),
  '.zshrc': as('script', 'shellscript'),
  '.profile': as('script', 'shellscript'),
  '.dev.vars': as('key', 'dotenv'),
  'package-lock.json': as('lock', 'json'),
  'npm-shrinkwrap.json': as('lock', 'json'),
  'pnpm-lock.yaml': as('lock', 'yaml'),
  'yarn.lock': as('lock', undefined, 'Lockfile'),
  'bun.lockb': as('lock', undefined, 'Lockfile'),
  'bun.lock': as('lock', 'jsonc'),
  'cargo.lock': as('lock', 'toml'),
  'poetry.lock': as('lock', 'toml'),
  'gemfile.lock': as('lock', undefined, 'Lockfile'),
  'composer.lock': as('lock', 'json'),
  'go.sum': as('lock', undefined, 'Go checksums'),
  'flake.lock': as('lock', 'json'),
  codeowners: as('owners', 'codeowners'),
  owners: as('owners', undefined, 'Plain text'),
  authors: as('owners', undefined, 'Plain text'),
  contributors: as('owners', undefined, 'Plain text'),
  notice: as('license', undefined, 'Plain text'),
};

const LICENSE = /^(licen[cs]e|copying|unlicense)([.-].*)?$/;
const CHANGELOG = /^(changelog|changes|history)(\.(md|txt|rst))?$/;
const README = /^readme(\.(md|txt|rst|adoc))?$/;
const COMPOSE = /^(docker-)?compose([.-][\w.-]+)?\.ya?ml$/;
const CONFIG_SCRIPT = /\.config\.(ts|mts|cts|js|mjs|cjs)$/;
const TEST = /\.(test|spec)\.[a-z0-9]+$/;
const TS_CONFIG = /^(ts|js)config(\.[\w-]+)*\.json$/;
const COMPOUND_ARCHIVE = /\.tar\.(gz|xz|bz2|zst)$/;

function finish(rule: Rule): FileType {
  return {
    icon: rule.icon,
    lang: rule.lang ?? null,
    label:
      rule.label ??
      (rule.lang ? (LANGUAGE_LABELS[rule.lang] ?? rule.lang) : 'File'),
  };
}

// `path` is repository-relative with forward slashes; only its last part and a few folder names count.
export function fileType(path: string): FileType {
  const parts = path.split('/');
  const name = parts[parts.length - 1]!.toLowerCase();
  const dirs = parts.slice(0, -1).map((p) => p.toLowerCase());
  const exact = BY_NAME[name];
  if (exact) return finish(exact);
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';

  if (name.startsWith('dockerfile.') || name.startsWith('containerfile.'))
    return finish(as('container', 'docker'));
  if (COMPOSE.test(name)) return finish(as('container', 'yaml'));
  if (name === '.env' || name.startsWith('.env.'))
    return finish(as('key', 'dotenv'));
  if (TS_CONFIG.test(name)) return finish(as('config', 'jsonc'));
  if (CONFIG_SCRIPT.test(name))
    return finish(as('config', BY_EXTENSION[ext]?.lang));
  if (/^\.(eslintrc|prettierrc|babelrc|stylelintrc)\./.test(name))
    return finish(as('config', BY_EXTENSION[ext]?.lang));
  if (LICENSE.test(name)) return finish(as('license', undefined, 'Licence'));
  if (CHANGELOG.test(name))
    return finish(
      as('changelog', ext === 'md' ? 'markdown' : undefined, 'Change log'),
    );
  if (README.test(name))
    return finish(
      as(
        'doc',
        ext === 'md' || ext === '' ? 'markdown' : BY_EXTENSION[ext]?.lang,
      ),
    );
  if (dirs.includes('.vscode') && ext === 'json')
    return finish(as('json', 'jsonc'));

  if (
    name.endsWith('.d.ts') ||
    name.endsWith('.d.mts') ||
    name.endsWith('.d.cts')
  )
    return finish(as('code', 'typescript', 'TypeScript declarations'));
  if (TEST.test(name) || dirs.includes('__tests__')) {
    const base = BY_EXTENSION[ext];
    if (base?.icon === 'code') return finish(as('test', base.lang));
  }
  if (name.endsWith('.min.js') || name.endsWith('.min.css'))
    return finish(as('code', ext === 'js' ? 'javascript' : 'css'));
  if (COMPOUND_ARCHIVE.test(name))
    return finish(as('archive', undefined, 'Archive'));

  const byExt = BY_EXTENSION[ext];
  if (byExt) return finish(byExt);
  return {
    icon: 'file',
    lang: null,
    label: ext ? `${ext.toUpperCase()} file` : 'File',
  };
}

const FOLDERS: Record<string, FolderIcon> = {
  src: 'src',
  test: 'tests',
  tests: 'tests',
  __tests__: 'tests',
  spec: 'tests',
  '.vscode': 'settings',
  '.idea': 'settings',
  '.config': 'settings',
  config: 'settings',
  '.github': 'git',
  '.gitlab': 'git',
  node_modules: 'deps',
  vendor: 'deps',
};

export function folderIcon(name: string): FolderIcon {
  return FOLDERS[name.toLowerCase()] ?? 'folder';
}

// The Shiki language for a path, or null for plain text.
export function languageOf(path: string): string | null {
  return fileType(path).lang;
}
