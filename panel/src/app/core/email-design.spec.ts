import { checkEmail, defaultDesign, designText, readDesign, renderDesign, type EmailDesign } from './email-design';

const design = (blocks: EmailDesign['blocks'], preheader = ''): EmailDesign => ({ ...defaultDesign(), theme: { ...defaultDesign().theme, preheader }, blocks });

describe('email design', () => {
  it('renders blocks as email HTML: tables, inline styles, escaped text and kept variables', () => {
    const html = renderDesign(
      design(
        [
          { id: 'a', type: 'heading', text: 'Hola {{nombre}} <script>', size: 'large', align: 'left' },
          { id: 'b', type: 'text', text: 'Uno **dos**\n\n[Tienda](https://tienda.example)', align: 'center' },
          { id: 'c', type: 'button', label: 'Comprar', url: 'https://tienda.example/?a=1&b=2', align: 'left' },
          { id: 'd', type: 'footer', text: 'Pie', unsubscribe: true },
        ],
        'Ofertas de la semana',
      ),
    );
    expect(html).toContain('Hola {{nombre}} &lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('<strong>dos</strong>');
    expect(html).toContain('href="https://tienda.example"');
    expect(html).toContain('href="https://tienda.example/?a=1&amp;b=2"');
    expect(html).toContain('bgcolor="#2f5bea"');
    expect(html).toContain('{{unsubscribe_url}}');
    expect(html).toContain('Ofertas de la semana');
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
  });

  it('writes the text version', () => {
    const text = designText(
      design([
        { id: 'a', type: 'text', text: 'Mira [esto](https://x.example)', align: 'left' },
        { id: 'b', type: 'button', label: 'Ir', url: 'https://x.example/ir', align: 'left' },
        { id: 'c', type: 'footer', text: 'Pie', unsubscribe: true },
      ]),
    );
    expect(text).toBe('Mira esto (https://x.example)\n\nIr: https://x.example/ir\n\nPie\nDarse de baja: {{unsubscribe_url}}');
  });

  it('reads designs back, dropping what it does not know', () => {
    expect(readDesign(null)).toBeNull();
    expect(readDesign({ version: 2, blocks: [] })).toBeNull();
    const read = readDesign({ version: 1, blocks: [{ id: 'x', type: 'text', text: 'Hola' }, { type: 'video' }] });
    expect(read?.blocks).toEqual([{ id: 'x', type: 'text', text: 'Hola', align: 'left' }]);
    expect(read?.theme.accent).toBe('#2f5bea');
  });

  it('warns about what some clients get wrong', () => {
    const d = design([{ id: 'a', type: 'image', src: 'http://x.example/a.png', alt: '', url: '', width: 300, align: 'center' }]);
    const levels = checkEmail('', renderDesign(d), d).map((c) => c.level);
    expect(levels.filter((l) => l === 'error')).toHaveLength(2);
    const texts = checkEmail('Hola', '<p>' + 'x'.repeat(110 * 1024) + '</p>', null).map((c) => c.text);
    expect(texts.some((t) => t.includes('102 KB'))).toBe(true);
    expect(texts.some((t) => t.includes('enlace de baja'))).toBe(true);
  });
});
