// code-editor FR-7/FR-10: the Monaco language for a file, from its extension, and
// the name the status bar shows. Anything unlisted is plain text.

export interface Language {
  id: string;
  name: string;
}

const PLAIN: Language = { id: 'plaintext', name: 'Plain Text' };

const BY_EXT: Record<string, Language> = {
  ts: { id: 'typescript', name: 'TypeScript' },
  mts: { id: 'typescript', name: 'TypeScript' },
  cts: { id: 'typescript', name: 'TypeScript' },
  tsx: { id: 'typescript', name: 'TypeScript React' },
  js: { id: 'javascript', name: 'JavaScript' },
  mjs: { id: 'javascript', name: 'JavaScript' },
  cjs: { id: 'javascript', name: 'JavaScript' },
  jsx: { id: 'javascript', name: 'JavaScript React' },
  json: { id: 'json', name: 'JSON' },
  jsonc: { id: 'json', name: 'JSON' },
  css: { id: 'css', name: 'CSS' },
  scss: { id: 'scss', name: 'SCSS' },
  less: { id: 'less', name: 'Less' },
  html: { id: 'html', name: 'HTML' },
  htm: { id: 'html', name: 'HTML' },
  md: { id: 'markdown', name: 'Markdown' },
  markdown: { id: 'markdown', name: 'Markdown' },
  rs: { id: 'rust', name: 'Rust' },
  py: { id: 'python', name: 'Python' },
  go: { id: 'go', name: 'Go' },
  java: { id: 'java', name: 'Java' },
  kt: { id: 'kotlin', name: 'Kotlin' },
  swift: { id: 'swift', name: 'Swift' },
  c: { id: 'c', name: 'C' },
  h: { id: 'c', name: 'C' },
  cpp: { id: 'cpp', name: 'C++' },
  hpp: { id: 'cpp', name: 'C++' },
  cs: { id: 'csharp', name: 'C#' },
  php: { id: 'php', name: 'PHP' },
  rb: { id: 'ruby', name: 'Ruby' },
  sh: { id: 'shell', name: 'Shell' },
  bash: { id: 'shell', name: 'Shell' },
  zsh: { id: 'shell', name: 'Shell' },
  ps1: { id: 'powershell', name: 'PowerShell' },
  yml: { id: 'yaml', name: 'YAML' },
  yaml: { id: 'yaml', name: 'YAML' },
  xml: { id: 'xml', name: 'XML' },
  svg: { id: 'xml', name: 'XML' },
  sql: { id: 'sql', name: 'SQL' },
  ini: { id: 'ini', name: 'INI' },
  toml: { id: 'ini', name: 'TOML' },
  graphql: { id: 'graphql', name: 'GraphQL' },
};

const BY_NAME: Record<string, Language> = {
  dockerfile: { id: 'dockerfile', name: 'Dockerfile' },
  makefile: { id: 'plaintext', name: 'Makefile' },
};

export function languageFor(path: string): Language {
  const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const named = BY_NAME[base];
  if (named) return named;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return PLAIN;
  return BY_EXT[base.slice(dot + 1)] ?? PLAIN;
}
