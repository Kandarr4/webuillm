// Markdown ответа модели: GFM (таблицы, зачёркивание, списки задач),
// подсветка кода, рассуждения <think> — отдельным сворачиваемым блоком.
//
// Сырой HTML из ответа не исполняется и не выбрасывается, а показывается
// как текст: модель пишет «<div>» в объяснениях, и молча терять такие куски
// нельзя (react-markdown без rehype-raw их просто отбрасывает).

import { memo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { useToast } from '../lib/toast.jsx';
import { copyText } from '../lib/clipboard.js';

function remarkHtmlAsText() {
  const walk = (node) => {
    if (node.type === 'html') node.type = 'text';
    if (node.children) node.children.forEach(walk);
  };
  return walk;
}

const REMARK = [remarkGfm, remarkHtmlAsText];
const REHYPE = [[rehypeHighlight, { detect: false }]];

// Текст узла hast — для кнопки копирования кода (после подсветки код разбит
// на span'ы, из React-детей его не собрать).
function hastText(node) {
  if (!node) return '';
  if (node.type === 'text') return node.value;
  return (node.children || []).map(hastText).join('');
}

// Длиннее этого блок кода сворачивается до превью — простыня кода не должна
// выталкивать из виду остальной ответ.
const COLLAPSE_LINES = 12;

// Язык блока → расширение скачиваемого файла. Незнакомый язык из букв и
// цифр идёт в расширение как есть, остальное — .txt.
const EXT = {
  javascript: 'js', js: 'js', jsx: 'jsx', typescript: 'ts', ts: 'ts', tsx: 'tsx',
  python: 'py', py: 'py', html: 'html', xml: 'xml', svg: 'svg', css: 'css', scss: 'scss',
  json: 'json', bash: 'sh', sh: 'sh', shell: 'sh', zsh: 'sh', console: 'sh',
  powershell: 'ps1', ps1: 'ps1', ps: 'ps1', bat: 'bat', cmd: 'bat', batch: 'bat',
  sql: 'sql', java: 'java', kotlin: 'kt', c: 'c', cpp: 'cpp', 'c++': 'cpp', h: 'h',
  csharp: 'cs', cs: 'cs', go: 'go', golang: 'go', rust: 'rs', rs: 'rs', php: 'php',
  ruby: 'rb', rb: 'rb', yaml: 'yml', yml: 'yml', toml: 'toml', ini: 'ini',
  markdown: 'md', md: 'md', lua: 'lua', swift: 'swift', r: 'r', perl: 'pl',
  diff: 'diff', patch: 'diff', csv: 'csv', text: 'txt', plaintext: 'txt', txt: 'txt',
  vue: 'vue', dart: 'dart', scala: 'scala', ocaml: 'ml', haskell: 'hs',
};
const FIXED_NAME = { dockerfile: 'Dockerfile', makefile: 'Makefile' };

function fileName(lang) {
  const l = (lang || '').toLowerCase();
  if (FIXED_NAME[l]) return FIXED_NAME[l];
  const ext = EXT[l] || (/^[a-z0-9]{1,10}$/.test(l) ? l : 'txt');
  return 'code.' + ext;
}

const plural = (n, one, few, many) => {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};

function CodeBlock({ node, children }) {
  const [done, setDone] = useState(false);
  // null — «как решит длина»: блок, доросший в стриме до длинного, свернётся
  // сам, а выбор пользователя после этого уже не перебивается.
  const [userOpen, setUserOpen] = useState(null);
  const toast = useToast();
  const code = node?.children?.[0];
  const cls = code?.properties?.className || [];
  const lang = (Array.isArray(cls) ? cls : [cls])
    .map(String).find((c) => c.startsWith('language-'))?.slice(9);
  const text = hastText(code).replace(/\n$/, '');
  const lines = text ? text.split('\n').length : 0;
  const long = lines > COLLAPSE_LINES;
  const open = !long || (userOpen ?? false);

  const copy = async () => {
    try {
      await copyText(text);
      setDone(true);
      setTimeout(() => setDone(false), 1200);
    } catch {
      toast('⚠️ Браузер не дал доступ к буферу обмена', true);
    }
  };

  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName(lang);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const linesLabel = `${lines} ${plural(lines, 'строка', 'строки', 'строк')}`;
  return (
    <div className={'md-code' + (open ? '' : ' collapsed')}>
      <div className="md-code-hdr">
        <span>{lang || 'код'} · {linesLabel}</span>
        <span className="md-code-actions">
          {long ? (
            <button className="md-code-btn" onClick={() => setUserOpen(!open)}>
              {open ? '▴ Свернуть' : '▾ Развернуть'}
            </button>
          ) : null}
          <button className="md-code-btn" onClick={download} title={'Сохранить как ' + fileName(lang)}>⤓ Скачать</button>
          <button className="md-code-btn" onClick={copy}>{done ? '✓ Скопировано' : '⎘ Копировать'}</button>
        </span>
      </div>
      <pre>{children}</pre>
      {!open ? (
        <button className="md-code-more" onClick={() => setUserOpen(true)}>
          Показать весь код · {linesLabel}
        </button>
      ) : null}
    </div>
  );
}

const COMPONENTS = {
  pre: CodeBlock,
  a: ({ node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
  table: ({ node, ...props }) => <div className="md-table"><table {...props} /></div>,
};

// Рассуждения модели. Бывают двух видов: «<think>…</think>ответ» и — когда
// открывающий тег уже стоит в шаблоне промпта — «…</think>ответ».
export function splitThink(text) {
  const open = text.match(/^\s*<think>/);
  if (open) {
    const rest = text.slice(open[0].length);
    const end = rest.indexOf('</think>');
    if (end < 0) return { think: rest.trim(), thinking: true, body: '' };
    return { think: rest.slice(0, end).trim(), thinking: false, body: rest.slice(end + 8) };
  }
  const end = text.indexOf('</think>');
  if (end >= 0 && !text.slice(0, end).includes('<think>')) {
    return { think: text.slice(0, end).trim(), thinking: false, body: text.slice(end + 8) };
  }
  return { think: null, thinking: false, body: text };
}

function Md({ text }) {
  return (
    <ReactMarkdown remarkPlugins={REMARK} rehypePlugins={REHYPE} components={COMPONENTS}>
      {text}
    </ReactMarkdown>
  );
}

function Markdown({ text }) {
  const { think, thinking, body } = splitThink(text || '');
  return (
    <div className="md">
      {think != null && (
        <details className="md-think" open={thinking}>
          <summary>{thinking ? 'Рассуждает…' : 'Рассуждения'}</summary>
          <div className="md-think-body"><Md text={think} /></div>
        </details>
      )}
      {body.trim() ? <Md text={body} /> : null}
    </div>
  );
}

export default memo(Markdown);
