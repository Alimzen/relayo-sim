/**
 * The visual editor's emails: blocks and a theme, turned into HTML that mail clients render alike (tables,
 * inline styles, no CSS they drop) and into its text version. The server keeps the design and sends the HTML.
 */

export type Align = 'left' | 'center' | 'right';

export type Block =
  | { id: string; type: 'heading'; text: string; size: 'large' | 'medium'; align: Align }
  | { id: string; type: 'text'; text: string; align: Align }
  | { id: string; type: 'button'; label: string; url: string; align: Align }
  | { id: string; type: 'image'; src: string; alt: string; url: string; width: number; align: Align }
  | { id: string; type: 'divider' }
  | { id: string; type: 'spacer'; height: number }
  | { id: string; type: 'footer'; text: string; unsubscribe: boolean };

export type BlockType = Block['type'];

export interface EmailTheme {
  /** Around the email. */
  background: string;
  /** The email's own background. */
  surface: string;
  text: string;
  /** Buttons and links. */
  accent: string;
  font: 'sans' | 'serif';
  /** The line inboxes show after the subject; hidden in the email. */
  preheader: string;
}

export interface EmailDesign {
  version: 1;
  theme: EmailTheme;
  blocks: Block[];
}

export const BLOCK_LABELS: Record<BlockType, string> = {
  heading: 'Título',
  text: 'Texto',
  button: 'Botón',
  image: 'Imagen',
  divider: 'Separador',
  spacer: 'Espacio',
  footer: 'Pie',
};

const FONTS = {
  sans: "-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  serif: "Georgia, 'Times New Roman', Times, serif",
};

let counter = 0;
export const blockId = () => `b${Date.now().toString(36)}${(counter++).toString(36)}`;

export function newBlock(type: BlockType): Block {
  const id = blockId();
  switch (type) {
    case 'heading':
      return { id, type, text: 'Título', size: 'large', align: 'left' };
    case 'text':
      return { id, type, text: 'Escribe aquí. **Negrita** y [enlaces](https://ejemplo.com) con la sintaxis de Markdown.', align: 'left' };
    case 'button':
      return { id, type, label: 'Ver más', url: 'https://', align: 'left' };
    case 'image':
      return { id, type, src: 'https://', alt: '', url: '', width: 560, align: 'center' };
    case 'divider':
      return { id, type };
    case 'spacer':
      return { id, type, height: 24 };
    case 'footer':
      return { id, type, text: 'Recibes este correo porque tienes una cuenta con nosotros.', unsubscribe: true };
  }
}

export function defaultDesign(): EmailDesign {
  return {
    version: 1,
    theme: { background: '#f4f4f5', surface: '#ffffff', text: '#18181b', accent: '#2f5bea', font: 'sans', preheader: '' },
    blocks: [
      { id: blockId(), type: 'heading', text: 'Hola {{nombre}}', size: 'large', align: 'left' },
      { id: blockId(), type: 'text', text: 'Gracias por unirte. Ya puedes empezar a usar tu cuenta.', align: 'left' },
      { id: blockId(), type: 'button', label: 'Empezar', url: 'https://ejemplo.com', align: 'left' },
      { id: blockId(), type: 'footer', text: 'Recibes este correo porque te registraste en nuestra web.', unsubscribe: true },
    ],
  };
}

/** A design read back from the server: anything missing gets its default, unknown blocks are dropped. */
export function readDesign(value: unknown): EmailDesign | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<EmailDesign>;
  if (raw.version !== 1 || !Array.isArray(raw.blocks)) return null;
  const theme = { ...defaultDesign().theme, ...raw.theme };
  const blocks = raw.blocks.filter((b): b is Block => !!b && typeof b === 'object' && (b as Block).type in BLOCK_LABELS);
  return { version: 1, theme, blocks: blocks.map((b) => ({ ...newBlock(b.type), ...b }) as Block) };
}

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Text blocks: paragraphs on blank lines, line breaks, **bold**, *italics* and [links](url). */
function inline(text: string, accent: string): string {
  return escape(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label: string, url: string) => `<a href="${url}" style="color:${accent};text-decoration:underline">${label}</a>`)
    .replace(/\n/g, '<br>');
}

function paragraphs(text: string, style: string, accent: string): string {
  return text
    .split(/\n{2,}/)
    .filter((p) => p.trim())
    .map((p) => `<p style="margin:0 0 16px;${style}">${inline(p.trim(), accent)}</p>`)
    .join('');
}

function row(content: string, padding = '0 32px'): string {
  return `<tr><td style="padding:${padding}">${content}</td></tr>`;
}

/** Light text on a dark accent, dark text on a light one. */
function contrastOn(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return '#ffffff';
  const n = parseInt(m[1]!, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! > 0.45 ? '#111111' : '#ffffff';
}

function renderBlock(block: Block, theme: EmailTheme): string {
  const font = FONTS[theme.font];
  switch (block.type) {
    case 'heading': {
      const size = block.size === 'large' ? 26 : 20;
      return row(`<h${block.size === 'large' ? 1 : 2} style="margin:0 0 16px;font-family:${font};font-size:${size}px;line-height:1.3;font-weight:700;color:${theme.text};text-align:${block.align}">${inline(block.text, theme.accent)}</h${block.size === 'large' ? 1 : 2}>`);
    }
    case 'text':
      return row(paragraphs(block.text, `font-family:${font};font-size:16px;line-height:1.6;color:${theme.text};text-align:${block.align}`, theme.accent));
    case 'button': {
      // A table cell carries the color: Outlook ignores padding and backgrounds on links.
      const color = contrastOn(theme.accent);
      return row(
        `<table role="presentation" border="0" cellspacing="0" cellpadding="0" align="${block.align}" style="margin:8px 0 24px"><tr><td align="center" bgcolor="${theme.accent}" style="border-radius:8px;background:${theme.accent}"><a href="${escape(block.url)}" target="_blank" style="display:inline-block;padding:13px 26px;font-family:${font};font-size:16px;font-weight:600;line-height:1;color:${color};text-decoration:none;border-radius:8px">${escape(block.label)}</a></td></tr></table>`,
      );
    }
    case 'image': {
      const width = Math.max(40, Math.min(536, Math.round(block.width) || 536));
      const img = `<img src="${escape(block.src)}" alt="${escape(block.alt)}" width="${width}" style="display:block;width:100%;max-width:${width}px;height:auto;border:0;outline:none;text-decoration:none">`;
      const linked = block.url ? `<a href="${escape(block.url)}" target="_blank">${img}</a>` : img;
      return row(`<table role="presentation" border="0" cellspacing="0" cellpadding="0" align="${block.align}" style="margin:0 0 16px"><tr><td>${linked}</td></tr></table>`);
    }
    case 'divider':
      return row(`<table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="margin:8px 0 24px"><tr><td style="border-top:1px solid ${theme.text}22;font-size:0;line-height:0">&nbsp;</td></tr></table>`);
    case 'spacer':
      return `<tr><td style="height:${Math.max(4, Math.min(120, block.height))}px;font-size:0;line-height:0">&nbsp;</td></tr>`;
    case 'footer': {
      const unsubscribe = block.unsubscribe
        ? `<br><a href="{{unsubscribe_url}}" style="color:${theme.text}99;text-decoration:underline">Darse de baja</a>`
        : '';
      return row(
        `<p style="margin:8px 0 0;font-family:${font};font-size:13px;line-height:1.5;color:${theme.text}99;text-align:center">${inline(block.text, theme.text)}${unsubscribe}</p>`,
        '16px 32px 0',
      );
    }
  }
}

/** The email's HTML: 600 px wide, centered, light and dark aware, with the preheader hidden first. */
export function renderDesign(design: EmailDesign): string {
  const { theme } = design;
  const preheader = theme.preheader.trim()
    ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${theme.background};opacity:0">${escape(theme.preheader)}${'&#8204;&nbsp;'.repeat(40)}</div>`
    : '';
  const body = design.blocks.map((b) => renderBlock(b, theme)).join('\n');
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title></title>
</head>
<body style="margin:0;padding:0;background:${theme.background};-webkit-text-size-adjust:100%">
${preheader}
<table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" bgcolor="${theme.background}" style="background:${theme.background}">
<tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" border="0" cellspacing="0" cellpadding="0" bgcolor="${theme.surface}" style="width:100%;max-width:600px;background:${theme.surface};border-radius:12px">
<tr><td style="height:32px;font-size:0;line-height:0">&nbsp;</td></tr>
${body}
<tr><td style="height:32px;font-size:0;line-height:0">&nbsp;</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

/** The text version, for clients without HTML and for spam filters that compare both. */
export function designText(design: EmailDesign): string {
  const plain = (text: string) => text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*([^*\n]+)\*/g, '$1').replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 ($2)');
  const parts = design.blocks.map((b) => {
    switch (b.type) {
      case 'heading':
        return plain(b.text);
      case 'text':
        return plain(b.text);
      case 'button':
        return `${b.label}: ${b.url}`;
      case 'image':
        return b.alt ? `[${b.alt}]` : '';
      case 'divider':
        return '———';
      case 'spacer':
        return '';
      case 'footer':
        return `${plain(b.text)}${b.unsubscribe ? '\nDarse de baja: {{unsubscribe_url}}' : ''}`;
    }
  });
  return parts.filter((p) => p !== '').join('\n\n');
}

export interface DesignCheck {
  level: 'error' | 'warning' | 'info';
  text: string;
}

/** What could go wrong in some mail client or inbox, before sending. */
export function checkEmail(subject: string, html: string, design: EmailDesign | null): DesignCheck[] {
  const checks: DesignCheck[] = [];
  const kb = new Blob([html]).size / 1024;
  if (kb > 102) checks.push({ level: 'error', text: `El HTML ocupa ${Math.round(kb)} KB: Gmail lo recorta a partir de 102 KB y esconde el resto (el enlace de baja incluido).` });
  else if (kb > 80) checks.push({ level: 'warning', text: `El HTML ocupa ${Math.round(kb)} KB: cerca del límite de 102 KB de Gmail.` });
  if (!subject.trim()) checks.push({ level: 'error', text: 'Falta el asunto.' });
  else if (subject.length > 60) checks.push({ level: 'info', text: `Asunto de ${subject.length} caracteres: en el móvil se cortan a partir de unos 40-60.` });
  if (design) {
    for (const b of design.blocks) {
      if (b.type === 'image' && !b.alt.trim()) checks.push({ level: 'warning', text: 'Una imagen no tiene texto alternativo: Outlook y muchos clientes bloquean las imágenes y solo muestran ese texto.' });
      if (b.type === 'image' && !/^https:\/\/\S+\.\S+/.test(b.src)) checks.push({ level: 'error', text: 'Una imagen no tiene una URL https: los clientes de correo no cargan imágenes sin ella.' });
      if (b.type === 'button' && !b.label.trim()) checks.push({ level: 'error', text: 'Un botón no tiene texto.' });
      if (b.type === 'button' && !/^(https?:\/\/\S+|\{\{.+\}\}|mailto:\S+)/.test(b.url)) checks.push({ level: 'error', text: `El botón «${b.label}» no tiene una URL válida.` });
    }
    if (!design.theme.preheader.trim()) checks.push({ level: 'info', text: 'Sin preheader: la bandeja de entrada mostrará el principio del texto tras el asunto.' });
    if (design.blocks.some((b) => b.type === 'image') && !design.blocks.some((b) => b.type === 'text' || b.type === 'heading')) {
      checks.push({ level: 'warning', text: 'Solo imágenes: los filtros de spam desconfían de los correos sin texto.' });
    }
  }
  if (/href=["']http:\/\//i.test(html)) checks.push({ level: 'warning', text: 'Hay enlaces http:// (sin cifrar): algunos clientes los marcan como inseguros.' });
  if (!/\{\{\s*unsubscribe_url\s*\}\}/.test(html)) {
    checks.push({ level: 'info', text: 'Sin enlace de baja. Si es un correo de marketing, añade un pie con «Darse de baja»: lo piden Gmail y Yahoo.' });
  }
  return checks;
}
